// Supabase Edge Function (Deno runtime)
// Name: receipt-email-worker
// Deploy: supabase functions deploy receipt-email-worker --no-verify-jwt
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
function getSupabaseSecretKey(): string {
  const configured = Deno.env.get("SUPABASE_SECRET_KEY");
  if (configured) return configured;

  const keySet = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keySet) {
    try {
      const key = JSON.parse(keySet).default;
      if (key) return key;
      throw new Error("SUPABASE_SECRET_KEYS.default is missing.");
    } catch {
      throw new Error("SUPABASE_SECRET_KEYS must be valid JSON.");
    }
  }

  // Temporary compatibility while the project moves from legacy service_role keys.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("A Supabase secret key is required.");
  return legacy;
}
const SUPABASE_SECRET_KEY = getSupabaseSecretKey();
const EMAIL_WEBHOOK_SECRET = Deno.env.get("EMAIL_WEBHOOK_SECRET");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CONFIRM_CHAT_ID = Deno.env.get("TELEGRAM_CONFIRM_CHAT_ID");
const DEFAULT_SUPABASE_USER_ID = Deno.env.get("DEFAULT_SUPABASE_USER_ID");
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map((s)=>s.trim()).filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

type ParsedTransaction = {
  type: "income" | "outcome";
  amount: number;
  categoryName: string;
  accountName: string;
  occurred_at: string;
  description: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeTransaction(parsed: any): ParsedTransaction {
  const amount = Number(String(parsed?.amount ?? "").replace(/[^\d.]/g, ""));
  const occurredAt = parsed?.occurred_at ? new Date(parsed.occurred_at) : new Date();

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Parsed transaction has invalid amount");
  }
  if (isNaN(occurredAt.getTime())) {
    throw new Error("Parsed transaction has invalid occurred_at");
  }

  return {
    type: parsed.type === "income" ? "income" : "outcome",
    amount,
    categoryName: String(parsed.categoryName || "Uncategorized").slice(0, 80),
    accountName: String(parsed.accountName || "Bank").slice(0, 80),
    occurred_at: occurredAt.toISOString(),
    description: String(parsed.description || "Email receipt").slice(0, 500)
  };
}

async function getOrCreateCategory(name: string, userId: string) {
  const { data, error } = await supabase.rpc("backend_resolve_category", {
    p_user_id: userId, p_name: name
  });
  if (error) throw new Error("Category resolution failed.");
  return data;
}

async function getOrCreateAccount(name: string) {
  const { data, error } = await supabase.from("accounts")
    .upsert({ name }, { onConflict: "name" }).select("id").single();
  if (error) throw new Error("Account resolution failed.");
  return data.id;
}

async function createStagingTransaction(p: ParsedTransaction) {
  const userId = requireEnv("DEFAULT_SUPABASE_USER_ID", DEFAULT_SUPABASE_USER_ID);
  const categoryId = await getOrCreateCategory(p.categoryName, userId);
  const accountId = await getOrCreateAccount(p.accountName);

  const { data, error } = await supabase
    .from("transaction_staging")
    .insert({
      amount: p.amount,
      description: p.description,
      occurred_at: p.occurred_at,
      type: p.type,
      category_id: categoryId,
      account_id: accountId,
      user_id: userId,
      status: "pending"
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

async function sendTransactionConfirmation(stagingId: string, p: ParsedTransaction, source?: any) {
  requireEnv("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
  const confirmationChatId = TELEGRAM_CONFIRM_CHAT_ID || ALLOWED_CHAT_IDS[0];
  requireEnv("TELEGRAM_CONFIRM_CHAT_ID or ALLOWED_CHAT_IDS", confirmationChatId);

  const when = new Date(p.occurred_at).toLocaleString("en-GB", {
    timeZone: "Asia/Jakarta",
    hour12: false
  });
  const sourceLine = source?.subject ? `\nEmail: ${String(source.subject).slice(0, 120)}` : "";

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: confirmationChatId,
      parse_mode: "HTML",
      text: `📧 <b>Email receipt detected</b>\n\nType: ${p.type}\nAmount: ${p.amount.toLocaleString("id-ID")} IDR\nCategory: ${p.categoryName}\nAccount: ${p.accountName}\nWhen: ${when}\nDescription: ${p.description}${sourceLine}\n\nSave this transaction?`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `confirm:${stagingId}` },
            { text: "❌ Reject", callback_data: `reject:${stagingId}` }
          ]
        ]
      }
    })
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload?.description || `Telegram error: ${response.status}`);
  }

  const telegramMessageId = payload?.result?.message_id;
  const telegramChatId = payload?.result?.chat?.id;
  if (telegramMessageId && telegramChatId) {
    const { error } = await supabase
      .from("transaction_staging")
      .update({
        metadata: {
          telegram_chat_id: String(telegramChatId),
          telegram_message_id: telegramMessageId,
          email_subject: source?.subject || null
        }
      })
      .eq("id", stagingId);

    if (error) {
      console.error("Failed to store Telegram message metadata.");
    }
  }
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const expectedSecret = requireEnv("EMAIL_WEBHOOK_SECRET", EMAIL_WEBHOOK_SECRET);
    const receivedSecret = req.headers.get("x-email-webhook-secret");
    if (!receivedSecret || receivedSecret !== expectedSecret) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    requireEnv("SUPABASE_URL", SUPABASE_URL);
    requireEnv("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY);

    const body = await req.json();
    const transaction = normalizeTransaction(body.transaction);
    const stagingId = await createStagingTransaction(transaction);
    await sendTransactionConfirmation(stagingId, transaction, body.source);

    return jsonResponse({
      ok: true,
      stagingId,
      transaction
    });
  } catch (error) {
    console.error("Receipt processing failed.");
    return jsonResponse({
      ok: false,
      error: "Receipt processing failed."
    }, 500);
  }
});

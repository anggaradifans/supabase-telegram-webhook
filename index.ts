// Supabase Edge Function (Deno runtime)
// Name: telegram-webhook
// Deploy: supabase functions deploy telegram-webhook --no-verify-jwt
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// --- Secrets from Supabase dashboard ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map((s)=>s.trim()).filter(Boolean);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// --- Helpers ---
// Parse Jakarta local date string "[YYYY-MM-DD HH:MM]" -> UTC Date
function parseJakartaDate(str) {
  const [datePart, timePart] = str.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  // create UTC date for same numbers, then subtract 7h to shift to UTC
  const utc = new Date(Date.UTC(y, m - 1, d, hh, mm));
  utc.setUTCHours(utc.getUTCHours() - 7);
  return utc;
}
// Parse: outcome 75000 Food BCA Lunch at warung
// Format: <type> <amount> <category> <account> [optional [YYYY-MM-DD HH:MM]] <description>
function parseMessage(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const re = /^(income|outcome)\s+(\d+(?:[\.,]\d{1,2})?)\s+(\S+)\s+(\S+)(?:\s+\[(.+?)\])?(?:\s+(.*))?$/i;
  const m = cleaned.match(re);
  if (!m) {
    throw new Error("Format: <income|outcome> <amount> <Category> <Account> [optional [YYYY-MM-DD HH:MM]] <optional description>");
  }
  const [, typeRaw, amountRaw, categoryRaw, accountRaw, occurredRaw, descRaw] = m;
  const type = typeRaw.toLowerCase();
  const amount = Number(amountRaw.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Bad amount");
  const category = categoryRaw.trim();
  const account = accountRaw.trim();
  let occurred_at;
  if (occurredRaw) {
    const d = parseJakartaDate(occurredRaw);
    if (isNaN(d.getTime())) throw new Error("Invalid occurred_at");
    occurred_at = d;
  } else {
    // if no date, use current real-time UTC
    occurred_at = new Date();
  }
  const description = (descRaw ?? "").trim() || null;
  return {
    type,
    amount,
    category,
    account,
    occurred_at: occurred_at.toISOString(),
    description
  };
}
async function getOrCreateCategory(name) {
  const { data: existing } = await supabase.from("categories").select("id").eq("name", name).maybeSingle();
  if (existing) return existing.id;
  // all new categories default to 'both'
  const { data: inserted, error } = await supabase.from("categories").insert({
    name,
    allowed_type: "both"
  }).select("id").single();
  if (error) throw error;
  return inserted.id;
}
async function getOrCreateAccount(name) {
  const { data: existing } = await supabase.from("accounts").select("id").eq("name", name).maybeSingle();
  if (existing) return existing.id;
  const { data: inserted, error } = await supabase.from("accounts").insert({
    name
  }).select("id").single();
  if (error) throw error;
  return inserted.id;
}
async function insertTransaction(p) {
  const category_id = await getOrCreateCategory(p.categoryName);
  const account_id = await getOrCreateAccount(p.accountName);
  const { data, error } = await supabase.from("transactions").insert({
    type: p.type,
    amount: p.amount,
    category_id,
    account_id,
    currency: "IDR",
    occurred_at: p.occurred_at,
    description: p.description
  }).select("id").single();
  if (error) throw error;
  return data.id;
}
async function replyToTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}
// --- Main handler ---
serve(async (req)=>{
  try {
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!secret || secret !== TELEGRAM_SECRET_TOKEN) {
      return new Response("Unauthorized", {
        status: 401
      });
    }
    const update = await req.json();
    const message = update?.message ?? update?.edited_message;
    if (!message) return new Response("ok");
    const chatId = String(message.chat?.id ?? "");
    if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) {
      return new Response("forbidden", {
        status: 403
      });
    }
    const text = message.text;
    if (!text) return new Response("ok");
    if (/^\/start|^\/help/i.test(text)) {
      await replyToTelegram(chatId, "👋 Format: outcome 75000 Food BCA [YYYY-MM-DD HH:MM] Lunch");
      return new Response("ok");
    }
    const p = parseMessage(text);
    const id = await insertTransaction({
      type: p.type,
      amount: p.amount,
      categoryName: p.category,
      accountName: p.account,
      occurred_at: p.occurred_at,
      description: p.description
    });
    // Format reply with Jakarta local time
    const when = new Date(p.occurred_at).toLocaleString("en-GB", {
      timeZone: "Asia/Jakarta",
      hour12: false
    });
    let replyText = `✅ Saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
    if (p.description) {
      replyText += `\nDescription: ${p.description}`;
    }
    replyText += `\nRef: ${id}`;
    await replyToTelegram(chatId, replyText);
    return new Response(JSON.stringify({
      ok: true,
      id
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({
      ok: false,
      error: String(e)
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }
});

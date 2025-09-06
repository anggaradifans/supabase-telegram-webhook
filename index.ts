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
      text,
      parse_mode: "HTML"
    })
  });
}

// Parse date input for outcome commands
function parseDateInput(input) {
  const now = new Date();
  const jakartaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  
  if (!input || input.toLowerCase() === "today") {
    // Current month
    return {
      year: jakartaNow.getFullYear(),
      month: jakartaNow.getMonth() + 1, // 1-based
      isCurrentMonth: true
    };
  }
  
  // Parse YYYY-MM format
  const yearMonthMatch = input.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonthMatch) {
    const year = parseInt(yearMonthMatch[1]);
    const month = parseInt(yearMonthMatch[2]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month, isCurrentMonth: false };
    }
  }
  
  // Parse YYYY format (entire year)
  const yearMatch = input.match(/^(\d{4})$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year >= 2000 && year <= 2100) {
      return { year, isFullYear: true };
    }
  }
  
  throw new Error("Invalid date format. Use: /outcome, /outcome today, /outcome 2024-01, or /outcome 2024");
}

// Query outcomes for a specific period
async function queryOutcomes(dateParams) {
  let query = supabase
    .from("transactions")
    .select(`
      id, type, amount, occurred_at, description,
      categories(name),
      accounts(name)
    `)
    .eq("type", "outcome")
    .order("occurred_at", { ascending: false });

  if (dateParams.isFullYear) {
    // Full year query
    const startOfYear = new Date(Date.UTC(dateParams.year, 0, 1));
    const endOfYear = new Date(Date.UTC(dateParams.year + 1, 0, 1));
    query = query
      .gte("occurred_at", startOfYear.toISOString())
      .lt("occurred_at", endOfYear.toISOString());
  } else {
    // Monthly query
    const startOfMonth = new Date(Date.UTC(dateParams.year, dateParams.month - 1, 1));
    const endOfMonth = new Date(Date.UTC(dateParams.year, dateParams.month, 1));
    query = query
      .gte("occurred_at", startOfMonth.toISOString())
      .lt("occurred_at", endOfMonth.toISOString());
  }

  const { data, error } = await query;
  if (error) throw error;
  
  return data || [];
}

// Format outcome report
function formatOutcomeReport(outcomes, dateParams) {
  if (outcomes.length === 0) {
    const period = dateParams.isFullYear 
      ? `${dateParams.year}`
      : `${String(dateParams.month).padStart(2, '0')}/${dateParams.year}`;
    return `📊 No outcomes found for ${period}`;
  }

  // Calculate total
  const totalAmount = outcomes.reduce((sum, t) => sum + t.amount, 0);
  
  // Group by category
  const byCategory = outcomes.reduce((acc, t) => {
    const categoryName = t.categories?.name || 'Unknown';
    if (!acc[categoryName]) {
      acc[categoryName] = { amount: 0, count: 0 };
    }
    acc[categoryName].amount += t.amount;
    acc[categoryName].count += 1;
    return acc;
  }, {});

  // Format period
  const period = dateParams.isFullYear 
    ? `${dateParams.year}`
    : `${String(dateParams.month).padStart(2, '0')}/${dateParams.year}`;
  
  let report = `📊 <b>Outcome Report - ${period}</b>\n\n`;
  report += `💰 <b>Total: ${totalAmount.toLocaleString('id-ID')} IDR</b>\n`;
  report += `📝 <b>Transactions: ${outcomes.length}</b>\n\n`;
  
  report += `<b>By Category:</b>\n`;
  Object.entries(byCategory)
    .sort(([,a], [,b]) => (b as any).amount - (a as any).amount)
    .forEach(([category, data]) => {
      const categoryData = data as { amount: number; count: number };
      const percentage = ((categoryData.amount / totalAmount) * 100).toFixed(1);
      report += `• ${category}: ${categoryData.amount.toLocaleString('id-ID')} IDR (${percentage}%) - ${categoryData.count}x\n`;
    });

  // Add recent transactions (top 5)
  if (outcomes.length > 0) {
    report += `\n<b>Recent Transactions:</b>\n`;
    outcomes.slice(0, 5).forEach(t => {
      const date = new Date(t.occurred_at).toLocaleDateString("en-GB", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "2-digit"
      });
      const categoryName = t.categories?.name || 'Unknown';
      const accountName = t.accounts?.name || 'Unknown';
      report += `• ${date} - ${t.amount.toLocaleString('id-ID')} IDR (${categoryName}/${accountName})`;
      if (t.description) {
        report += ` - ${t.description}`;
      }
      report += `\n`;
    });
    
    if (outcomes.length > 5) {
      report += `... and ${outcomes.length - 5} more transactions\n`;
    }
  }

  return report;
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
      const helpText = `👋 <b>Financial Tracker Bot</b>

<b>📝 Record Transaction:</b>
<code>outcome 75000 Food BCA [YYYY-MM-DD HH:MM] Lunch</code>
<code>income 500000 Salary BCA Monthly salary</code>

<b>📊 Check Reports:</b>
/outcome - Current month outcomes
/outcome today - Current month outcomes  
/outcome 2024-01 - January 2024 outcomes
/outcome 2024 - All 2024 outcomes

<b>Format:</b> &lt;type&gt; &lt;amount&gt; &lt;Category&gt; &lt;Account&gt; [optional date] &lt;description&gt;`;
      await replyToTelegram(chatId, helpText);
      return new Response("ok");
    }

    // Handle /outcome command
    if (/^\/outcome/i.test(text)) {
      try {
        const args = text.substring(8).trim(); // Remove "/outcome" prefix
        const dateParams = parseDateInput(args);
        const outcomes = await queryOutcomes(dateParams);
        const report = formatOutcomeReport(outcomes, dateParams);
        await replyToTelegram(chatId, report);
        return new Response("ok");
      } catch (error) {
        await replyToTelegram(chatId, `❌ Error: ${error.message}`);
        return new Response("ok");
      }
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

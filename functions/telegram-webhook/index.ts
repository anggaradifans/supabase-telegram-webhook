// Supabase Edge Function (Deno runtime)
// Name: telegram-webhook
// Deploy: supabase functions deploy telegram-webhook --no-verify-jwt
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// --- Secrets from Supabase dashboard ---
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
const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OCR_METHOD = Deno.env.get("OCR_METHOD") || "openai"; // "openai", "google", "tesseract"
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map((s)=>s.trim()).filter(Boolean);

// Simple in-memory store for pending OCR confirmations
function redactSecrets(text: string): string {
  for (const secret of [SUPABASE_SECRET_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET_TOKEN, OPENAI_API_KEY]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}
const pendingConfirmations = new Map<string, {
  ocrText: string;
  timestamp: number;
  imageUrl?: string;
}>();
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === `Bearer ${SUPABASE_SECRET_KEY}`) {
        headers.delete("Authorization");
      }
      return fetch(input, { ...init, headers });
    }
  }
});
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
  // Capitalize first letter, rest lowercase for consistent formatting
  const category = categoryRaw.trim().toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
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
function requireOwner(userId?: string | null): asserts userId is string {
  if (!userId) throw new Error("An active, verified Telegram account link is required.");
}
// Get or create Telegram user and return Supabase user ID
async function getTelegramUser(telegramUserId: number, telegramUsername?: string, telegramFirstName?: string, telegramLastName?: string) {
  const { data: existing, error: fetchError } = await supabase
    .from("telegram_users")
    .select("supabase_user_id, is_active")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  
  if (fetchError) throw fetchError;
  
  if (existing) {
    // Update last activity and user info
    await supabase
      .from("telegram_users")
      .update({
        last_activity_at: new Date().toISOString(),
        telegram_username: telegramUsername,
        telegram_first_name: telegramFirstName,
        telegram_last_name: telegramLastName,
        updated_at: new Date().toISOString()
      })
      .eq("telegram_user_id", telegramUserId);
    
    if (!existing.is_active) {
      throw new Error("Your Telegram account is not active. Please contact support.");
    }
    
    return existing.supabase_user_id;
  }
  
  // User not registered
  return null;
}

// Check budget after transaction insertion
async function checkBudgetStatus(userId: string, categoryId: string, transactionAmount: number, occurredAt: string) {
  const transactionDate = new Date(occurredAt);
  
  // Get active budgets for this category and user
  const { data: budgets, error } = await supabase
    .from("budgets")
    .select("id, amount, period, start_date, end_date, currency")
    .eq("user_id", userId)
    .eq("category_id", categoryId)
    .lte("start_date", transactionDate.toISOString())
    .or(`end_date.is.null,end_date.gte.${transactionDate.toISOString()}`);
  
  if (error) {
    console.error("Budget lookup failed.");
    return null;
  }
  
  if (!budgets || budgets.length === 0) {
    return { alerts: null, progress: null }; // No budgets for this category
  }
  
  // Check each budget
  const budgetAlerts: string[] = [];
  const budgetProgress: string[] = [];
  
  for (const budget of budgets) {
    let periodStart: Date;
    let periodEnd: Date;
    
    // Calculate period based on budget period type and transaction date
    switch (budget.period) {
      case "daily":
        // Daily: use the day of the transaction
        periodStart = new Date(transactionDate);
        periodStart.setUTCHours(0, 0, 0, 0);
        periodEnd = new Date(periodStart);
        periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
        break;
      case "weekly":
        // Weekly: find the week containing the transaction date
        const dayOfWeek = transactionDate.getUTCDay();
        periodStart = new Date(transactionDate);
        periodStart.setUTCDate(periodStart.getUTCDate() - dayOfWeek);
        periodStart.setUTCHours(0, 0, 0, 0);
        periodEnd = new Date(periodStart);
        periodEnd.setUTCDate(periodEnd.getUTCDate() + 7);
        break;
      case "monthly":
        // Monthly: use the month of the transaction date
        periodStart = new Date(Date.UTC(transactionDate.getUTCFullYear(), transactionDate.getUTCMonth(), 1));
        periodEnd = new Date(Date.UTC(transactionDate.getUTCFullYear(), transactionDate.getUTCMonth() + 1, 1));
        break;
      case "yearly":
        // Yearly: use the year of the transaction date
        periodStart = new Date(Date.UTC(transactionDate.getUTCFullYear(), 0, 1));
        periodEnd = new Date(Date.UTC(transactionDate.getUTCFullYear() + 1, 0, 1));
        break;
      default:
        continue;
    }
    
    // Check if transaction falls within this budget period
    // Also verify the period is within budget's start_date and end_date
    const budgetStart = new Date(budget.start_date);
    const budgetEnd = budget.end_date ? new Date(budget.end_date) : null;
    
    if (transactionDate < budgetStart || (budgetEnd && transactionDate >= budgetEnd)) {
      continue;
    }
    
    if (periodStart < budgetStart) {
      periodStart = budgetStart;
    }
    if (budgetEnd && periodEnd > budgetEnd) {
      periodEnd = budgetEnd;
    }
    
    // Calculate net spending (outcome - income) in this period
    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("type, amount")
      .eq("user_id", userId)
      .eq("category_id", categoryId)
      .in("type", ["outcome", "income"])
      .gte("occurred_at", periodStart.toISOString())
      .lt("occurred_at", periodEnd.toISOString())
      .is("deleted_at", null);
    
    if (txError) {
      console.error("Budget transaction lookup failed.");
      continue;
    }
    
    // Calculate net spending: outcome - income
    let totalOutcome = 0;
    let totalIncome = 0;
    (transactions || []).forEach(t => {
      if (t.type === "outcome") {
        totalOutcome += Number(t.amount);
      } else if (t.type === "income") {
        totalIncome += Number(t.amount);
      }
    });
    const totalSpent = totalOutcome - totalIncome;
    const budgetAmount = Number(budget.amount);
    // Calculate percentage based on net spending (can be negative if income > outcome)
    const percentageUsed = totalSpent > 0 ? (totalSpent / budgetAmount) * 100 : 0;
    const remaining = budgetAmount - totalSpent;
    
    // Get period label
    const periodLabel = budget.period.charAt(0).toUpperCase() + budget.period.slice(1);
    
    // Format progress info (use Math.max to ensure non-negative display)
    const displaySpent = Math.max(0, totalSpent);
    const progressInfo = `💰 <b>Budget Progress (${periodLabel})</b>\nNet Spent: ${displaySpent.toLocaleString('id-ID')} / ${budgetAmount.toLocaleString('id-ID')} ${budget.currency} (${percentageUsed.toFixed(1)}%)\nRemaining: ${remaining.toLocaleString('id-ID')} ${budget.currency}`;
    
    // Alert if budget exceeded or close to limit
    if (totalSpent > budgetAmount) {
      const exceeded = totalSpent - budgetAmount;
      budgetAlerts.push(`⚠️ <b>Budget Exceeded!</b>\nCategory budget exceeded by ${exceeded.toLocaleString('id-ID')} ${budget.currency}\nBudget: ${budgetAmount.toLocaleString('id-ID')} ${budget.currency}\nNet Spent: ${displaySpent.toLocaleString('id-ID')} ${budget.currency}`);
      budgetProgress.push(progressInfo);
    } else if (percentageUsed >= 90 && totalSpent > 0) {
      budgetAlerts.push(`⚠️ <b>Budget Warning</b>\n${percentageUsed.toFixed(1)}% of budget used\nBudget: ${budgetAmount.toLocaleString('id-ID')} ${budget.currency}\nNet Spent: ${displaySpent.toLocaleString('id-ID')} ${budget.currency}\nRemaining: ${remaining.toLocaleString('id-ID')} ${budget.currency}`);
      budgetProgress.push(progressInfo);
    } else {
      // Always show progress, even if not warning
      budgetProgress.push(progressInfo);
    }
  }
  
  return {
    alerts: budgetAlerts.length > 0 ? budgetAlerts.join("\n\n") : null,
    progress: budgetProgress.length > 0 ? budgetProgress.join("\n\n") : null
  };
}

async function insertTransaction(p, userId: string | undefined, updateId: number) {
  requireOwner(userId);
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Invalid Telegram update.");
  const { data: id, error } = await supabase.rpc("backend_save_telegram_transaction", {
    p_user_id: userId, p_update_id: updateId, p_transaction: p
  });
  if (error) throw new Error("Transaction could not be saved.");
  let budgetInfo = null;
  if (p.type === "outcome") {
    const { data: txn } = await supabase.from("transactions").select("category_id")
      .eq("id", id).eq("user_id", userId).single();
    if (txn) budgetInfo = await checkBudgetStatus(userId, txn.category_id, p.amount, p.occurred_at).catch(() => null);
  }
  return { id, budgetInfo };
}

async function processStagedTransaction(stagingId: string, telegramUserId: number | undefined, action: string) {
  if (!Number.isSafeInteger(telegramUserId)) throw new Error("Invalid Telegram sender.");
  const { data, error } = await supabase.rpc("backend_process_staged_transaction", {
    p_staging_id: stagingId, p_telegram_user_id: telegramUserId, p_action: action
  });
  if (error) throw new Error("Transaction unavailable or could not be processed.");
  return data;
}
async function confirmStagedTransaction(stagingId: string, telegramUserId?: number) {
  const { stagingData, txn } = await processStagedTransaction(stagingId, telegramUserId, "confirm");
  let budgetStatus = null;
  if (txn?.type === "outcome") {
    budgetStatus = await checkBudgetStatus(txn.user_id, txn.category_id, txn.amount, txn.occurred_at)
      .catch(() => null);
  }
  return { stagingData, txn, budgetStatus };
}
async function rejectStagedTransaction(stagingId: string, telegramUserId?: number) {
  const { stagingData } = await processStagedTransaction(stagingId, telegramUserId, "reject");
  return stagingData;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Two UUIDs must fit inside Telegram's 64-byte callback_data limit.
function compactId(uuid: string) {
  return btoa(String.fromCharCode(...uuid.replace(/-/g, "").match(/../g)!.map(h => parseInt(h, 16))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function expandId(value: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error("Invalid selection.");
  const hex = Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=="))
    .map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function reviewKeyboard(stagingId: string) {
  return { inline_keyboard: [
    [{ text: "✅ Confirm", callback_data: `confirm:${stagingId}` }, { text: "❌ Reject", callback_data: `reject:${stagingId}` }],
    [{ text: "Edit category", callback_data: `ec:${stagingId}:0` }, { text: "Edit account", callback_data: `ea:${stagingId}:0` }]
  ] };
}

function revisionMessage(result: any, action: string) {
  const p = result.stagingData;
  const when = new Date(p.occurred_at).toLocaleString("en-GB", { timeZone: "Asia/Jakarta", hour12: false });
  let text = `<b>Review transaction</b>\n\nType: ${escapeHtml(p.type)}\nAmount: ${Number(p.amount).toLocaleString("id-ID")} ${escapeHtml(p.currency || "IDR")}\nCategory: ${escapeHtml(result.categoryName || "Uncategorized")}\nAccount: ${escapeHtml(result.accountName || "Bank")}\nWhen: ${when}\nDescription: ${escapeHtml(p.description)}`;
  if (p.metadata?.email_subject) text += `\nEmail: ${escapeHtml(String(p.metadata.email_subject).slice(0, 120))}`;
  if (action !== "ec" && action !== "ea") {
    return { text: text + "\n\nReview the category and account, then confirm to save.", reply_markup: reviewKeyboard(p.id) };
  }
  const isCategory = action === "ec";
  const currentId = isCategory ? p.category_id : p.account_id;
  const choices = result.choices || [];
  const keyboard = choices.slice(0, 8).map((choice: any) => [{
    text: `${choice.id === currentId ? "✓ " : ""}${choice.name}`,
    callback_data: `${isCategory ? "sc" : "sa"}:${compactId(p.id)}:${compactId(choice.id)}`
  }]);
  const navigation = [];
  if (result.page > 0) navigation.push({ text: "Previous", callback_data: `${action}:${p.id}:${result.page - 1}` });
  if (choices.length > 8) navigation.push({ text: "Next", callback_data: `${action}:${p.id}:${result.page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: "Back to review", callback_data: `review:${p.id}` }]);
  text += choices.length ? `\n\nChoose ${isCategory ? "a category" : "an account"} (page ${result.page + 1}).` : "\n\nNo available choices on this page.";
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

async function reviseStagedTransaction(action: string, id: string, selection: string | undefined, telegramUserId: number) {
  const selecting = action === "sc" || action === "sa";
  const stagingId = selecting ? expandId(id) : id;
  const page = action === "ec" || action === "ea" ? Number(selection || 0) : 0;
  if (!Number.isSafeInteger(page) || page < 0 || page > 10000) throw new Error("Invalid page.");
  const actions = { ec: "categories", ea: "accounts", sc: "category", sa: "account", review: "view" };
  const { data, error } = await supabase.rpc("backend_revise_staged_transaction", {
    p_staging_id: stagingId, p_telegram_user_id: telegramUserId, p_action: actions[action],
    p_choice_id: selecting ? expandId(selection || "") : null, p_page: page
  });
  if (error || !data) throw new Error("Receipt unavailable, already processed, or selection no longer valid. Reopen the receipt to review it.");
  return revisionMessage(data, action);
}

async function findStagingIdForTelegramReply(replyMessage: any, userId: string) {
  requireOwner(userId);
  const replyMessageId = replyMessage?.message_id;
  const replyChatId = replyMessage?.chat?.id;

  if (!replyMessageId || !replyChatId) {
    return null;
  }

  const { data, error } = await supabase
    .from("transaction_staging")
    .select("id")
    .eq("user_id", userId)
    .contains("metadata", {
      telegram_chat_id: String(replyChatId),
      telegram_message_id: replyMessageId
    })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`Could not find replied transaction: ${error.message}`);
  }

  return data?.[0]?.id || null;
}
async function replyToTelegram(chatId, text) {
  text = redactSecrets(text);
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

// Parse date input for summary commands
function parseSummaryDateInput(input) {
  const now = new Date();
  const jakartaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  
  if (!input || input.toLowerCase() === "today") {
    // Current month only
    return [{
      year: jakartaNow.getFullYear(),
      month: jakartaNow.getMonth() + 1, // 1-based
    }];
  }
  
  // Parse month ranges like "Sept 2025 - Oct 2025" or "Sep 2025-Oct 2025"
  const rangeMatch = input.match(/^(\w+)\s+(\d{4})\s*[-–]\s*(\w+)\s+(\d{4})$/i);
  if (rangeMatch) {
    const [, startMonthStr, startYearStr, endMonthStr, endYearStr] = rangeMatch;
    const startMonth = parseMonthName(startMonthStr);
    const endMonth = parseMonthName(endMonthStr);
    const startYear = parseInt(startYearStr);
    const endYear = parseInt(endYearStr);
    
    if (startMonth && endMonth && startYear >= 2000 && endYear >= 2000) {
      const months: any[] = [];
      let currentYear = startYear;
      let currentMonth = startMonth;
      
      while (currentYear < endYear || (currentYear === endYear && currentMonth <= endMonth)) {
        months.push({ year: currentYear, month: currentMonth });
        currentMonth++;
        if (currentMonth > 12) {
          currentMonth = 1;
          currentYear++;
        }
        
        // Safety check to prevent infinite loops
        if (months.length > 24) break;
      }
      
      return months;
    }
  }
  
  // Parse single month like "Sept 2025" or "September 2025"
  const singleMonthMatch = input.match(/^(\w+)\s+(\d{4})$/i);
  if (singleMonthMatch) {
    const [, monthStr, yearStr] = singleMonthMatch;
    const month = parseMonthName(monthStr);
    const year = parseInt(yearStr);
    
    if (month && year >= 2000 && year <= 2100) {
      return [{ year, month }];
    }
  }
  
  // Parse YYYY-MM format
  const yearMonthMatch = input.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonthMatch) {
    const year = parseInt(yearMonthMatch[1]);
    const month = parseInt(yearMonthMatch[2]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) {
      return [{ year, month }];
    }
  }
  
  throw new Error("Invalid format. Use: /summary, /summary Sept 2025, or /summary Sept 2025 - Oct 2025");
}

// Parse month name to number
function parseMonthName(monthStr) {
  const monthMap = {
    'jan': 1, 'january': 1, 'januari': 1,
    'feb': 2, 'february': 2, 'februari': 2,
    'mar': 3, 'march': 3, 'maret': 3,
    'apr': 4, 'april': 4,
    'may': 5, 'mei': 5,
    'jun': 6, 'june': 6, 'juni': 6,
    'jul': 7, 'july': 7, 'juli': 7,
    'aug': 8, 'august': 8, 'agustus': 8,
    'sep': 9, 'sept': 9, 'september': 9,
    'oct': 10, 'october': 10, 'oktober': 10,
    'nov': 11, 'november': 11,
    'dec': 12, 'december': 12, 'desember': 12
  };
  
  return monthMap[monthStr.toLowerCase()];
}

// Get month name in English
function getMonthName(monthNumber) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[monthNumber - 1] || 'Unknown';
}

// Query outcomes for a specific period
async function queryOutcomes(dateParams, userId?: string) {
  requireOwner(userId);
  let query = supabase
    .from("transactions")
    .select(`
      id, type, amount, occurred_at, description,
      categories(name),
      accounts(name)
    `)
    .eq("type", "outcome")
    .is("deleted_at", null)
    .order("occurred_at", { ascending: false });

  // Filter by user_id if provided
  if (userId) {
    query = query.eq("user_id", userId);
  }

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

// Query monthly summary for specific months
async function querySummaryData(months, userId?: string) {
  requireOwner(userId);
  const summaries: any[] = [];
  
  for (const { year, month } of months) {
    // Query income and outcome for this month
    const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
    const endOfMonth = new Date(Date.UTC(year, month, 1));
    
    let query = supabase
      .from("transactions")
      .select("type, amount")
      .gte("occurred_at", startOfMonth.toISOString())
      .lt("occurred_at", endOfMonth.toISOString())
      .is("deleted_at", null);
    
    // Filter by user_id if provided
    if (userId) {
      query = query.eq("user_id", userId);
    }
    
    const { data, error } = await query;
      
    if (error) throw error;
    
    // Calculate totals
    let totalIncome = 0;
    let totalOutcome = 0;
    
    (data || []).forEach(transaction => {
      if (transaction.type === 'income') {
        totalIncome += transaction.amount;
      } else if (transaction.type === 'outcome') {
        totalOutcome += transaction.amount;
      }
    });
    
    summaries.push({
      year,
      month,
      monthName: getMonthName(month),
      totalIncome,
      totalOutcome,
      balance: totalIncome - totalOutcome,
      transactionCount: (data || []).length
    });
  }
  
  return summaries;
}

// Format monthly summary report
function formatSummaryReport(summaries) {
  if (summaries.length === 0) {
    return `📊 No data found`;
  }
  
  let report = `📊 <b>Monthly Summary</b>\n\n`;
  
  summaries.forEach((summary, index) => {
    const incomeFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(summary.totalIncome);
    
    const outcomeFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(summary.totalOutcome);
    
    report += `<b>${summary.monthName}</b>\n`;
    report += `Income: ${incomeFormatted}\n`;
    report += `Outcome: ${outcomeFormatted}\n`;
    
    // Add balance if there are transactions
    if (summary.transactionCount > 0) {
      const balanceFormatted = new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(Math.abs(summary.balance));
      
      const balanceLabel = summary.balance >= 0 ? 'Surplus' : 'Deficit';
      report += `${balanceLabel}: ${balanceFormatted}\n`;
    }
    
    // Add spacing between months (except for the last one)
    if (index < summaries.length - 1) {
      report += `\n`;
    }
  });
  
  // Add overall summary if multiple months
  if (summaries.length > 1) {
    const totalIncome = summaries.reduce((sum, s) => sum + s.totalIncome, 0);
    const totalOutcome = summaries.reduce((sum, s) => sum + s.totalOutcome, 0);
    const totalBalance = totalIncome - totalOutcome;
    
    const totalIncomeFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(totalIncome);
    
    const totalOutcomeFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(totalOutcome);
    
    const totalBalanceFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Math.abs(totalBalance));
    
    report += `\n<b>📈 Total Summary</b>\n`;
    report += `Total Income: ${totalIncomeFormatted}\n`;
    report += `Total Outcome: ${totalOutcomeFormatted}\n`;
    
    const totalBalanceLabel = totalBalance >= 0 ? 'Total Surplus' : 'Total Deficit';
    report += `${totalBalanceLabel}: ${totalBalanceFormatted}`;
  }
  
  return report;
}

// --- Main handler ---
serve(async (req)=>{
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!secret || secret !== TELEGRAM_SECRET_TOKEN) {
      return new Response("Unauthorized", {
        status: 401
      });
    }
    const update = await req.json();
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return new Response("Invalid update", { status: 400 });

    // Handle inline Confirm / Reject buttons from staged email or receipt transactions.
    if (update.callback_query) {
      const { id, data, message, from } = update.callback_query;
      const [action, stagingId, selection] = (data || "").split(":");
      const callbackChatId = String(message?.chat?.id ?? "");

      console.log("Telegram callback received", {
        action,
        stagingId,
        chatId: callbackChatId
      });

      const answerCallback = async (text: string) => {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callback_query_id: id, text })
        });
      };

      const editMessageText = async (text: string, replyMarkup = { inline_keyboard: [] }) => {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: message?.chat?.id,
            message_id: message?.message_id,
            text,
            parse_mode: "HTML",
            reply_markup: replyMarkup
          })
        });
        const payload = await response.json();
        if (!payload.ok && !String(payload.description).includes("message is not modified")) {
          throw new Error("Could not refresh the Telegram receipt. Reopen it before confirming.");
        }
      };

      try {
        if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(callbackChatId)) {
          await answerCallback("This chat is not allowed.");
          return new Response("ok");
        }

        if (message?.chat?.type !== "private" || !Number.isSafeInteger(from?.id)) {
          await answerCallback("Use a private chat with the bot.");
          return new Response("ok");
        }

        if (!stagingId) {
          await answerCallback("Invalid transaction data.");
          return new Response("ok");
        }

        if (["ec", "ea", "sc", "sa", "review"].includes(action)) {
          await answerCallback("Loading receipt...");
          const revised = await reviseStagedTransaction(action, stagingId, selection, from.id);
          await editMessageText(revised.text, revised.reply_markup);
          return new Response("ok");
        }

        if (action === "confirm" || action === "reject") {
          await answerCallback(`Processing ${action}...`);
        }

        if (action === "confirm") {
          const { stagingData, budgetStatus } = await confirmStagedTransaction(stagingId, from?.id);
          await editMessageText(`✅ <b>Confirmed &amp; Saved</b>\nAmount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR\nDesc: ${escapeHtml(stagingData.description)}`);

          console.log("Telegram callback completed", {
            action,
            stagingId,
            chatId: callbackChatId
          });

          if (budgetStatus?.progress) {
            await replyToTelegram(message.chat.id, budgetStatus.progress);
          }
          if (budgetStatus?.alerts) {
            await replyToTelegram(message.chat.id, budgetStatus.alerts);
          }
          return new Response("ok");
        }

        if (action === "reject") {
          const stagingData = await rejectStagedTransaction(stagingId, from?.id);
          await editMessageText(`❌ <b>Rejected</b>\nAmount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR\nDesc: ${escapeHtml(stagingData.description)}`);
          console.log("Telegram callback completed", {
            action,
            stagingId,
            chatId: callbackChatId
          });
          return new Response("ok");
        }

        await answerCallback("Unknown action.");
        return new Response("ok");
      } catch (error) {
        console.error("Callback query failed.");
        const errorMessage = error instanceof Error ? error.message.slice(0, 500) : "Failed to process callback.";
        if (message?.chat?.id) {
          await replyToTelegram(
            message.chat.id,
            `❌ Could not process this receipt: ${escapeHtml(errorMessage)}`
          );
        }
        return new Response("ok");
      }
    }
    
    const message = update?.message;
    if (!message) return new Response("ok");
    const chatId = String(message.chat?.id ?? "");
    if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) {
      return new Response("forbidden", {
        status: 403
      });
    }
    
    // Extract Telegram user info
    const telegramUserId = message.from?.id;
    const telegramUsername = message.from?.username;
    const telegramFirstName = message.from?.first_name;
    const telegramLastName = message.from?.last_name;
    
    // Get Supabase user ID if registered (for non-register commands)
    let supabaseUserId: string | null = null;
    if (telegramUserId && !/^\/register/i.test(message.text || "")) {
      try {
        supabaseUserId = await getTelegramUser(
          telegramUserId,
          telegramUsername,
          telegramFirstName,
          telegramLastName
        );
      } catch (error) {
        // User not registered or error - will be handled per command
        console.log("Telegram sender mapping unavailable.");
      }
    }
    
    const text = message.text;
    if (!text) return new Response("ok");
    if (/^\/register/i.test(text)) {
      await replyToTelegram(chatId, "Account linking by user ID is disabled. Contact the administrator to verify your account link.");
      return new Response("ok");
    }
    if (!supabaseUserId) {
      await replyToTelegram(chatId, "An active, verified account link is required. Contact the administrator.");
      return new Response("ok");
    }
    if (message.chat?.type !== "private") {
      await replyToTelegram(chatId, "Use a private chat with the bot for financial operations.");
      return new Response("ok");
    }


    // Confirm all pending staged receipt transactions.
    if (/^\/(confirm_all|confirmall)(?:\s+|$)/i.test(text)) {
      const targetUserId = supabaseUserId;
      const limitMatch = text.match(/\s+(\d+)\s*$/);
      const limit = Math.min(Math.max(Number(limitMatch?.[1] || 25), 1), 100);

      let query = supabase
        .from("transaction_staging")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);

      if (targetUserId) {
        query = query.eq("user_id", targetUserId);
      }

      let { data: stagedRows, error: stagedError } = await query;

      if (stagedError) {
        await replyToTelegram(chatId, `❌ Could not load pending transactions: ${stagedError.message}`);
        return new Response("ok");
      }
      if (!stagedRows?.length) {
        await replyToTelegram(chatId, "No pending transactions to confirm.");
        return new Response("ok");
      }

      let confirmed = 0;
      const failures: string[] = [];
      for (const row of stagedRows) {
        try {
          await confirmStagedTransaction(row.id, telegramUserId);
          confirmed += 1;
        } catch (error) {
          failures.push(`${row.id}: ${error.message}`);
        }
      }

      let replyText = `✅ Confirmed ${confirmed} pending transaction(s).`;
      if (stagedRows.length === limit) {
        replyText += `
Processed max ${limit}. Run /confirm_all again if more remain.`;
      }
      if (failures.length) {
        replyText += `

❌ Failed ${failures.length}:
${failures.slice(0, 5).join("\n")}`;
      }
      await replyToTelegram(chatId, replyText);
      return new Response("ok");
    }

    // Reject all pending staged receipt transactions.
    if (/^\/(reject_all|rejectall)(?:\s+|$)/i.test(text)) {
      const targetUserId = supabaseUserId;
      const limitMatch = text.match(/\s+(\d+)\s*$/);
      const limit = Math.min(Math.max(Number(limitMatch?.[1] || 25), 1), 100);

      let query = supabase
        .from("transaction_staging")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);

      if (targetUserId) {
        query = query.eq("user_id", targetUserId);
      }

      let { data: stagedRows, error: stagedError } = await query;

      if (stagedError) {
        await replyToTelegram(chatId, `❌ Could not load pending transactions: ${stagedError.message}`);
        return new Response("ok");
      }
      if (!stagedRows?.length) {
        await replyToTelegram(chatId, "No pending transactions to reject.");
        return new Response("ok");
      }

      let rejected = 0;
      const failures: string[] = [];
      for (const row of stagedRows) {
        try {
          await rejectStagedTransaction(row.id, telegramUserId);
          rejected += 1;
        } catch (error) {
          failures.push(`${row.id}: ${error.message}`);
        }
      }

      let replyText = `❌ Rejected ${rejected} pending transaction(s).`;
      if (stagedRows.length === limit) {
        replyText += `
Processed max ${limit}. Run /reject_all again if more remain.`;
      }
      if (failures.length) {
        replyText += `

❌ Failed ${failures.length}:
${failures.slice(0, 5).join("\n")}`;
      }
      await replyToTelegram(chatId, replyText);
      return new Response("ok");
    }

    // Allow replying with "confirm" / "reject" to the specific receipt message.
    const normalizedText = text.trim().toLowerCase();
    if (/^(confirm|yes|y|reject|no|n)$/i.test(normalizedText)) {
      const isReject = /^(reject|no|n)$/i.test(normalizedText);
      try {
        const stagingId = await findStagingIdForTelegramReply(message.reply_to_message, supabaseUserId);
        if (!stagingId) {
          await replyToTelegram(chatId, `Reply to the receipt alert you want to ${isReject ? "reject" : "confirm"}.`);
          return new Response("ok");
        }

        if (isReject) {
          const stagingData = await rejectStagedTransaction(stagingId, telegramUserId);
          await replyToTelegram(chatId, `❌ Rejected
Amount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR
Desc: ${stagingData.description}`);
          return new Response("ok");
        }

        const { stagingData, budgetStatus } = await confirmStagedTransaction(stagingId, telegramUserId);
        let replyText = `✅ Confirmed and saved
Amount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR
Desc: ${stagingData.description}`;
        if (budgetStatus?.progress) {
          replyText += `

${budgetStatus.progress}`;
        }
        if (budgetStatus?.alerts) {
          replyText += `

${budgetStatus.alerts}`;
        }
        await replyToTelegram(chatId, replyText);
        return new Response("ok");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to process transaction.";
        console.error("Telegram reply action error", {
          action: isReject ? "reject" : "confirm",
          chatId,
          error: redactSecrets(errorMessage)
        });
        await replyToTelegram(chatId, `❌ Failed to ${isReject ? "reject" : "confirm"} transaction: ${errorMessage}`);
        return new Response("ok");
      }
    }
    
    // Handle confirmation responses
    if (pendingConfirmations.has(chatId)) {
      const pendingData = pendingConfirmations.get(chatId)!;
      const response = text.toLowerCase().trim();
      
      if (response === 'yes' || response === 'y') {
        // Process the OCR text as a transaction
        try {
          const p = parseMessage(pendingData.ocrText);
          const result = await insertTransaction({
            type: p.type,
            amount: p.amount,
            categoryName: p.category,
            accountName: p.account,
            occurred_at: p.occurred_at,
            description: p.description
          }, supabaseUserId || undefined, update.update_id);
          
          // Format reply with Jakarta local time
          const when = new Date(p.occurred_at).toLocaleString("en-GB", {
            timeZone: "Asia/Jakarta",
            hour12: false
          });
          let replyText = `✅ Confirmed and saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
          if (p.description) {
            replyText += `\nDescription: ${p.description}`;
          }
          replyText += `\nRef: ${result.id}`;
          
          // Add budget progress and alerts if available
          if (result.budgetInfo) {
            if (result.budgetInfo.progress) {
              replyText += `\n\n${result.budgetInfo.progress}`;
            }
            if (result.budgetInfo.alerts) {
              replyText += `\n\n${result.budgetInfo.alerts}`;
            }
          }
          
          await replyToTelegram(chatId, replyText);
          pendingConfirmations.delete(chatId);
          return new Response("ok");
        } catch (error) {
          await replyToTelegram(chatId, `❌ Error processing OCR text: ${error.message}\n\nPlease send a corrected version or try again.`);
          return new Response("ok");
        }
      } else if (response === 'no' || response === 'n') {
        // Cancel the OCR transaction
        pendingConfirmations.delete(chatId);
        await replyToTelegram(chatId, "❌ OCR transaction cancelled. You can send a new image or type a transaction manually.");
        return new Response("ok");
      } else {
        // Treat as corrected version
        try {
          const p = parseMessage(text);
          const result = await insertTransaction({
            type: p.type,
            amount: p.amount,
            categoryName: p.category,
            accountName: p.account,
            occurred_at: p.occurred_at,
            description: p.description
          }, supabaseUserId || undefined, update.update_id);
          
          // Format reply with Jakarta local time
          const when = new Date(p.occurred_at).toLocaleString("en-GB", {
            timeZone: "Asia/Jakarta",
            hour12: false
          });
          let replyText = `✅ Corrected and saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
          if (p.description) {
            replyText += `\nDescription: ${p.description}`;
          }
          replyText += `\nRef: ${result.id}`;
          
          // Add budget progress and alerts if available
          if (result.budgetInfo) {
            if (result.budgetInfo.progress) {
              replyText += `\n\n${result.budgetInfo.progress}`;
            }
            if (result.budgetInfo.alerts) {
              replyText += `\n\n${result.budgetInfo.alerts}`;
            }
          }
          
          await replyToTelegram(chatId, replyText);
          pendingConfirmations.delete(chatId);
          return new Response("ok");
        } catch (error) {
          await replyToTelegram(chatId, `❌ Error with corrected format: ${error.message}\n\nPlease check the format or reply 'no' to cancel.`);
          return new Response("ok");
        }
      }
    }
    
    if (/^\/start|^\/help/i.test(text)) {
      const helpText = `👋 <b>Financial Tracker Bot</b>

<b>🔐 Registration:</b>
Account linking: contact the administrator for verification.

<b>📝 Record Transaction:</b>
<code>outcome 75000 Food BCA [YYYY-MM-DD HH:MM] Lunch</code>
<code>income 500000 Salary BCA Monthly salary</code>

<b>📸 OCR from Image:</b>
Send a photo of receipt/transaction and I'll extract the text for you to confirm

<b>📊 Check Reports:</b>
/outcome - Current month outcomes
/outcome today - Current month outcomes  
/outcome 2024-01 - January 2024 outcomes
/outcome 2024 - All 2024 outcomes

<b>💰 Monthly Summary:</b>
/summary - Current month income & outcome
/summary Sept 2025 - September 2025 summary
/summary Sept 2025 - Oct 2025 - Range summary

<b>Format:</b> &lt;type&gt; &lt;amount&gt; &lt;Category&gt; &lt;Account&gt; [optional date] &lt;description&gt;`;
      await replyToTelegram(chatId, helpText);
      return new Response("ok");
    }

    // Handle /outcome command
    if (/^\/outcome/i.test(text)) {
      try {
        const args = text.substring(8).trim(); // Remove "/outcome" prefix
        const dateParams = parseDateInput(args);
        const outcomes = await queryOutcomes(dateParams, supabaseUserId || undefined);
        const report = formatOutcomeReport(outcomes, dateParams);
        await replyToTelegram(chatId, report);
        return new Response("ok");
      } catch (error) {
        await replyToTelegram(chatId, `❌ Error: ${error.message}`);
        return new Response("ok");
      }
    }

    // Handle /summary command
    if (/^\/summary/i.test(text)) {
      try {
        const args = text.substring(8).trim(); // Remove "/summary" prefix
        const months = parseSummaryDateInput(args);
        const summaries = await querySummaryData(months, supabaseUserId || undefined);
        const report = formatSummaryReport(summaries);
        await replyToTelegram(chatId, report);
        return new Response("ok");
      } catch (error) {
        await replyToTelegram(chatId, `❌ Error: ${error.message}`);
        return new Response("ok");
      }
    }
    
    // Handle regular text transaction
    try {
      const p = parseMessage(text);
      const result = await insertTransaction({
        type: p.type,
        amount: p.amount,
        categoryName: p.category,
        accountName: p.account,
        occurred_at: p.occurred_at,
        description: p.description
      }, supabaseUserId || undefined, update.update_id);
      // Format reply with Jakarta local time
      const when = new Date(p.occurred_at).toLocaleString("en-GB", {
        timeZone: "Asia/Jakarta",
        hour12: false
      });
      let replyText = `✅ Saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
      if (p.description) {
        replyText += `\nDescription: ${p.description}`;
      }
      replyText += `\nRef: ${result.id}`;
      
      // Add budget progress and alerts if available
      if (result.budgetInfo) {
        if (result.budgetInfo.progress) {
          replyText += `\n\n${result.budgetInfo.progress}`;
        }
        if (result.budgetInfo.alerts) {
          replyText += `\n\n${result.budgetInfo.alerts}`;
        }
      }
      
      await replyToTelegram(chatId, replyText);
      return new Response(JSON.stringify({
        ok: true,
        id: result.id
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    } catch (error) {
      await replyToTelegram(chatId, `❌ ${error.message}`);
      return new Response("ok");
    }
  } catch (e) {
    console.error("Telegram webhook failed.");
    return new Response(JSON.stringify({
      ok: false,
      error: "Telegram webhook failed."
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }
});

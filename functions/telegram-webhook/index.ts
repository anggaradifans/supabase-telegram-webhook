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
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OCR_METHOD = Deno.env.get("OCR_METHOD") || "openai"; // "openai", "google", "tesseract"
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map((s)=>s.trim()).filter(Boolean);

// Simple in-memory store for pending OCR confirmations
const pendingConfirmations = new Map<string, {
  ocrText: string;
  timestamp: number;
  imageUrl?: string;
}>();
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
async function getOrCreateCategory(name) {
  // Search case-insensitively for existing category
  const { data: existing } = await supabase.from("categories").select("id").ilike("name", name).maybeSingle();
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

// Register Telegram user with Supabase user ID
async function registerTelegramUser(telegramUserId: number, supabaseUserId: string, telegramUsername?: string, telegramFirstName?: string, telegramLastName?: string) {
  // Check if Supabase user exists
  const { data: supabaseUser, error: userError } = await supabase.auth.admin.getUserById(supabaseUserId);
  if (userError || !supabaseUser) {
    throw new Error("Invalid Supabase user ID. Please check your user ID.");
  }
  
  // Check if Telegram user already exists
  const { data: existing } = await supabase
    .from("telegram_users")
    .select("id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  
  if (existing) {
    // Update existing record
    const { error } = await supabase
      .from("telegram_users")
      .update({
        supabase_user_id: supabaseUserId,
        telegram_username: telegramUsername,
        telegram_first_name: telegramFirstName,
        telegram_last_name: telegramLastName,
        is_active: true,
        last_activity_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("telegram_user_id", telegramUserId);
    
    if (error) throw error;
    return "updated";
  }
  
  // Create new record
  const { error } = await supabase
    .from("telegram_users")
    .insert({
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      telegram_first_name: telegramFirstName,
      telegram_last_name: telegramLastName,
      supabase_user_id: supabaseUserId,
      is_active: true,
      last_activity_at: new Date().toISOString()
    });
  
  if (error) throw error;
  return "created";
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
    console.error("Error fetching budgets:", error);
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
      console.error("Error fetching transactions for budget check:", txError);
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

async function insertTransaction(p, userId?: string) {
  const category_id = await getOrCreateCategory(p.categoryName);
  const account_id = await getOrCreateAccount(p.accountName);
  const { data, error } = await supabase.from("transactions").insert({
    type: p.type,
    amount: p.amount,
    category_id,
    account_id,
    currency: "IDR",
    occurred_at: p.occurred_at,
    description: p.description,
    user_id: userId || null
  }).select("id").single();
  if (error) throw error;
  
  // Check budget if user_id is provided and transaction is outcome
  let budgetInfo: { alerts: string | null; progress: string | null } | null = null;
  if (userId && p.type === "outcome") {
    try {
      const budgetStatus = await checkBudgetStatus(userId, category_id, p.amount, p.occurred_at);
      // Only set budgetInfo if there's actual progress or alerts to show
      if (budgetStatus && (budgetStatus.progress || budgetStatus.alerts)) {
        budgetInfo = budgetStatus;
      }
    } catch (error) {
      console.error("Error checking budget:", error);
      // Don't fail the transaction if budget check fails
    }
  }
  
  return { id: data.id, budgetInfo };
}

async function confirmStagedTransaction(stagingId: string, telegramUserId?: number) {
  const { data: stagingData, error: fetchError } = await supabase
    .from("transaction_staging")
    .select("*")
    .eq("id", stagingId)
    .single();

  if (fetchError || !stagingData) {
    throw new Error("Transaction not found or expired.");
  }
  if (stagingData.status !== "pending") {
    throw new Error(`Already ${stagingData.status}.`);
  }

  let targetUserId = stagingData.user_id;
  if (!targetUserId && telegramUserId) {
    try {
      const uid = await getTelegramUser(telegramUserId);
      if (uid) targetUserId = uid;
    } catch (error) {
      console.log("User lookup failed", error);
    }
  }
  if (!targetUserId && DEFAULT_SUPABASE_USER_ID) {
    targetUserId = DEFAULT_SUPABASE_USER_ID;
  }

  const { data: txn, error: insertError } = await supabase
    .from("transactions")
    .insert({
      amount: stagingData.amount,
      description: stagingData.description,
      occurred_at: stagingData.occurred_at,
      type: stagingData.type || "outcome",
      category_id: stagingData.category_id || (await getOrCreateCategory("Uncategorized")),
      account_id: stagingData.account_id || (await getOrCreateAccount("Bank")),
      user_id: targetUserId,
      currency: stagingData.currency || "IDR"
    })
    .select()
    .single();

  if (insertError) {
    console.error("Insert Error", insertError);
    throw new Error("Failed to save transaction.");
  }

  await supabase
    .from("transaction_staging")
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString()
    })
    .eq("id", stagingId);

  let budgetStatus: { alerts: string | null; progress: string | null } | null = null;
  if (targetUserId && txn.type === "outcome") {
    try {
      budgetStatus = await checkBudgetStatus(targetUserId, txn.category_id, txn.amount, txn.occurred_at);
    } catch (error) {
      console.error("Budget check error", error);
    }
  }

  return { stagingData, txn, budgetStatus };
}

async function rejectStagedTransaction(stagingId: string) {
  const { data: stagingData, error: fetchError } = await supabase
    .from("transaction_staging")
    .select("*")
    .eq("id", stagingId)
    .single();

  if (fetchError || !stagingData) {
    throw new Error("Transaction not found or expired.");
  }
  if (stagingData.status !== "pending") {
    throw new Error(`Already ${stagingData.status}.`);
  }

  await supabase
    .from("transaction_staging")
    .update({
      status: "rejected",
      rejected_at: new Date().toISOString()
    })
    .eq("id", stagingId);

  return stagingData;
}

async function findPendingStagingIdForTelegramReply(replyMessage: any, targetUserId?: string | null) {
  const replyMessageId = replyMessage?.message_id;
  const replyChatId = replyMessage?.chat?.id;

  if (replyMessageId && replyChatId) {
    const { data, error } = await supabase
      .from("transaction_staging")
      .select("id")
      .eq("status", "pending")
      .contains("metadata", {
        telegram_chat_id: String(replyChatId),
        telegram_message_id: replyMessageId
      })
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("Reply staging lookup failed", error);
    } else if (data?.[0]?.id) {
      return data[0].id;
    }
  }

  const findLatestPending = async (filterByUser: boolean) => {
    let query = supabase
      .from("transaction_staging")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (filterByUser && targetUserId) {
      query = query.eq("user_id", targetUserId);
    }

    return await query;
  };

  let { data: stagedRows, error: stagedError } = await findLatestPending(true);
  if (!stagedRows?.length && targetUserId && !stagedError) {
    ({ data: stagedRows, error: stagedError } = await findLatestPending(false));
  }

  if (stagedError) {
    throw new Error(`Could not find pending transaction: ${stagedError.message}`);
  }

  return stagedRows?.[0]?.id || null;
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
  try {
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!secret || secret !== TELEGRAM_SECRET_TOKEN) {
      return new Response("Unauthorized", {
        status: 401
      });
    }
    const update = await req.json();

    // Handle inline Confirm / Reject buttons from staged email or receipt transactions.
    if (update.callback_query) {
      const { id, data, message, from } = update.callback_query;
      const [action, stagingId] = (data || "").split(":");

      const answerCallback = async (text: string) => {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callback_query_id: id, text })
        });
      };

      const editMessageText = async (text: string) => {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: message?.chat?.id,
            message_id: message?.message_id,
            text,
            parse_mode: "HTML"
          })
        });
      };

      try {
        if (!stagingId) {
          await answerCallback("Invalid transaction data.");
          return new Response("ok");
        }

        if (action === "confirm") {
          const { stagingData, budgetStatus } = await confirmStagedTransaction(stagingId, from?.id);
          await editMessageText(`✅ <b>Confirmed & Saved</b>\nAmount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR\nDesc: ${stagingData.description}`);
          await answerCallback("Saved!");

          if (budgetStatus?.progress) {
            await replyToTelegram(message.chat.id, budgetStatus.progress);
          }
          if (budgetStatus?.alerts) {
            await replyToTelegram(message.chat.id, budgetStatus.alerts);
          }
          return new Response("ok");
        }

        if (action === "reject") {
          const stagingData = await rejectStagedTransaction(stagingId);
          await editMessageText(`❌ <b>Rejected</b>\nAmount: ${Number(stagingData.amount).toLocaleString("id-ID")} IDR\nDesc: ${stagingData.description}`);
          await answerCallback("Rejected");
          return new Response("ok");
        }

        await answerCallback("Unknown action.");
        return new Response("ok");
      } catch (error) {
        console.error("Callback query error", error);
        await answerCallback(error instanceof Error ? error.message.slice(0, 180) : "Failed to process callback.");
        return new Response("ok");
      }
    }
    
    const message = update?.message ?? update?.edited_message;
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
        console.log("Telegram user not registered or error:", error);
      }
    }
    
    const text = message.text;
    if (!text) return new Response("ok");

    // Confirm all pending staged receipt transactions.
    if (/^\/(confirm_all|confirmall)(?:\s+|$)/i.test(text)) {
      const targetUserId = supabaseUserId || DEFAULT_SUPABASE_USER_ID;
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
      if (!stagedRows?.length && targetUserId && !stagedError) {
        ({ data: stagedRows, error: stagedError } = await supabase
          .from("transaction_staging")
          .select("id")
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(limit));
      }

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
      const targetUserId = supabaseUserId || DEFAULT_SUPABASE_USER_ID;
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
      if (!stagedRows?.length && targetUserId && !stagedError) {
        ({ data: stagedRows, error: stagedError } = await supabase
          .from("transaction_staging")
          .select("id")
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(limit));
      }

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
          await rejectStagedTransaction(row.id);
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

    // Allow replying with "confirm" / "reject" to the receipt message.
    // If there is no reply context, fall back to the newest pending staged transaction.
    const normalizedText = text.trim().toLowerCase();
    if (/^(confirm|yes|y|reject|no|n)$/i.test(normalizedText)) {
      const isReject = /^(reject|no|n)$/i.test(normalizedText);
      const targetUserId = supabaseUserId || DEFAULT_SUPABASE_USER_ID;

      try {
        const stagingId = await findPendingStagingIdForTelegramReply(message.reply_to_message, targetUserId);
        if (!stagingId) {
          await replyToTelegram(chatId, `No pending transaction to ${isReject ? "reject" : "confirm"}.`);
          return new Response("ok");
        }

        if (isReject) {
          const stagingData = await rejectStagedTransaction(stagingId);
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
        await replyToTelegram(chatId, `❌ Failed to ${isReject ? "reject" : "confirm"} transaction: ${error.message}`);
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
          }, supabaseUserId || undefined);
          
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
          }, supabaseUserId || undefined);
          
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
/register &lt;supabase_user_id&gt; - Link your Telegram account to Supabase

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

    // Handle /register command
    if (/^\/register/i.test(text)) {
      try {
        if (!telegramUserId) {
          await replyToTelegram(chatId, "❌ Unable to identify Telegram user. Please try again.");
          return new Response("ok");
        }
        
        const args = text.substring(9).trim(); // Remove "/register" prefix
        if (!args) {
          await replyToTelegram(chatId, "❌ Please provide your Supabase user ID.\n\nUsage: /register &lt;supabase_user_id&gt;\n\nYou can find your user ID in your Supabase dashboard.");
          return new Response("ok");
        }
        
        const result = await registerTelegramUser(
          telegramUserId,
          args,
          telegramUsername,
          telegramFirstName,
          telegramLastName
        );
        
        if (result === "created") {
          await replyToTelegram(chatId, `✅ <b>Registration Successful!</b>\n\nYour Telegram account has been linked to your Supabase account.\n\nYou can now use all features including budget tracking.`);
        } else {
          await replyToTelegram(chatId, `✅ <b>Account Updated!</b>\n\nYour Telegram account information has been updated.`);
        }
        return new Response("ok");
      } catch (error) {
        await replyToTelegram(chatId, `❌ Registration failed: ${error.message}\n\nPlease check your Supabase user ID and try again.`);
        return new Response("ok");
      }
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
      }, supabaseUserId || undefined);
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

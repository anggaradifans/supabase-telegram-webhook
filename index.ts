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

// Download image from Telegram
async function downloadTelegramFile(fileId: string): Promise<Uint8Array> {
  // Get file info from Telegram
  const fileInfoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const fileInfoResponse = await fetch(fileInfoUrl);
  const fileInfo = await fileInfoResponse.json();
  
  if (!fileInfo.ok) {
    throw new Error(`Failed to get file info: ${fileInfo.description}`);
  }
  
  // Download the actual file
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
  const fileResponse = await fetch(fileUrl);
  
  if (!fileResponse.ok) {
    throw new Error(`Failed to download file: ${fileResponse.statusText}`);
  }
  
  return new Uint8Array(await fileResponse.arrayBuffer());
}

// Convert image to base64 for OpenAI Vision API
function imageToBase64(imageData: Uint8Array): string {
  const bytes = Array.from(imageData);
  const binary = bytes.map(byte => String.fromCharCode(byte)).join('');
  return btoa(binary);
}

// Extract text from image using OpenAI Vision API
async function extractTextFromImage(imageData: Uint8Array): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI API key not configured");
  }
  
  const base64Image = imageToBase64(imageData);
  
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract all text from this image. Focus on financial transaction details like amounts, categories, accounts, dates, and descriptions. Return only the extracted text, formatted clearly. If you see transaction information, try to format it in a way that matches this pattern: 'outcome/income [amount] [category] [account] [date] [description]'"
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: 500
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }
  
  const result = await response.json();
  return result.choices[0]?.message?.content || "No text detected";
}

// Clean up old pending confirmations (older than 5 minutes)
function cleanupOldConfirmations() {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  for (const [chatId, data] of pendingConfirmations.entries()) {
    if (data.timestamp < fiveMinutesAgo) {
      pendingConfirmations.delete(chatId);
    }
  }
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

// Query monthly summary for specific months
async function querySummaryData(months) {
  const summaries: any[] = [];
  
  for (const { year, month } of months) {
    // Query income and outcome for this month
    const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
    const endOfMonth = new Date(Date.UTC(year, month, 1));
    
    const { data, error } = await supabase
      .from("transactions")
      .select("type, amount")
      .gte("occurred_at", startOfMonth.toISOString())
      .lt("occurred_at", endOfMonth.toISOString())
      .is("deleted_at", null);
      
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
    const message = update?.message ?? update?.edited_message;
    if (!message) return new Response("ok");
    const chatId = String(message.chat?.id ?? "");
    if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) {
      return new Response("forbidden", {
        status: 403
      });
    }
    
    // Clean up old confirmations
    cleanupOldConfirmations();
    
    // Handle photo messages
    if (message.photo && message.photo.length > 0) {
      try {
        await replyToTelegram(chatId, "🔍 Processing your image with OCR...");
        
        // Get the largest photo size
        const photo = message.photo[message.photo.length - 1];
        const imageData = await downloadTelegramFile(photo.file_id);
        const extractedText = await extractTextFromImage(imageData);
        
        // Store the OCR result for confirmation
        pendingConfirmations.set(chatId, {
          ocrText: extractedText,
          timestamp: Date.now()
        });
        
        const confirmationMessage = `📋 <b>OCR Results:</b>\n\n<code>${extractedText}</code>\n\n🤖 Is this correct? Reply with:\n• <b>yes</b> or <b>y</b> to process the transaction\n• <b>no</b> or <b>n</b> to cancel\n• Or send a corrected version`;
        
        await replyToTelegram(chatId, confirmationMessage);
        return new Response("ok");
      } catch (error) {
        console.error("OCR Error:", error);
        await replyToTelegram(chatId, `❌ OCR Error: ${error.message}`);
        return new Response("ok");
      }
    }
    
    const text = message.text;
    if (!text) return new Response("ok");
    
    // Handle confirmation responses
    if (pendingConfirmations.has(chatId)) {
      const pendingData = pendingConfirmations.get(chatId)!;
      const response = text.toLowerCase().trim();
      
      if (response === 'yes' || response === 'y') {
        // Process the OCR text as a transaction
        try {
          const p = parseMessage(pendingData.ocrText);
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
          let replyText = `✅ Confirmed and saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
          if (p.description) {
            replyText += `\nDescription: ${p.description}`;
          }
          replyText += `\nRef: ${id}`;
          
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
          let replyText = `✅ Corrected and saved ${p.type} ${p.amount} IDR\nCategory: ${p.category}\nAccount: ${p.account}\nWhen: ${when}`;
          if (p.description) {
            replyText += `\nDescription: ${p.description}`;
          }
          replyText += `\nRef: ${id}`;
          
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
        const outcomes = await queryOutcomes(dateParams);
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
        const summaries = await querySummaryData(months);
        const report = formatSummaryReport(summaries);
        await replyToTelegram(chatId, report);
        return new Response("ok");
      } catch (error) {
        await replyToTelegram(chatId, `❌ Error: ${error.message}`);
        return new Response("ok");
      }
    }
    
    // Handle regular text transaction
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

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");

loadDotEnv(resolve(process.cwd(), ".env"));
loadDotEnv(resolve(PROJECT_DIR, ".env"));

const DEFAULT_CATEGORY = process.env.JENIUS_DEFAULT_CATEGORY || "Payment";
const DEFAULT_ACCOUNT = "Jenius";
const DEFAULT_USER_ID = process.env.DEFAULT_SUPABASE_USER_ID || null;
const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CONFIRM_CHAT_ID ||
  (process.env.ALLOWED_CHAT_IDS || "").split(",").map((item) => item.trim()).filter(Boolean)[0];

function loadDotEnv(path) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
}

function usage() {
  console.log(`Usage: node scripts/import-jenius-pdf.mjs <statement.pdf> [--dry-run] [--month YYYY-MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD]

Required env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CONFIRM_CHAT_ID or ALLOWED_CHAT_IDS

Optional env:
  DEFAULT_SUPABASE_USER_ID
  JENIUS_DEFAULT_CATEGORY=Uncategorized`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeAmount(raw) {
  const cleaned = String(raw || "").replace(/[^\d,.-]/g, "");
  if (!cleaned) return NaN;
  const sign = cleaned.startsWith("-") ? -1 : 1;
  const unsigned = cleaned.replace(/^-/, "");
  const commaCount = (unsigned.match(/,/g) || []).length;
  const dotCount = (unsigned.match(/\./g) || []).length;
  const commaDecimal = commaCount === 1 && dotCount > 0 && /,\d{1,2}$/.test(unsigned);
  const plainDecimal = commaCount === 1 && dotCount === 0 && /,\d{1,2}$/.test(unsigned);

  if (commaDecimal || plainDecimal) {
    return sign * Number(unsigned.replace(/\./g, "").replace(",", "."));
  }

  return sign * Number(unsigned.replace(/[.,]/g, ""));
}

function jakartaDateToUtcDate(year, monthIndex, day, hour = 12, minute = 0, second = 0, millisecond = 0) {
  return new Date(Date.UTC(year, monthIndex, day, hour - 7, minute, second, millisecond));
}

function parseDate(raw, fallbackYear) {
  const text = raw.trim();
  let match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    const year = Number(yyyy.length === 2 ? `20${yyyy}` : yyyy);
    return jakartaDateToUtcDate(year, Number(mm) - 1, Number(dd));
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})?$/);
  if (match) {
    const months = {
      jan: 0, januari: 0, january: 0,
      feb: 1, februari: 1, february: 1,
      mar: 2, maret: 2, march: 2,
      apr: 3, april: 3,
      mei: 4, may: 4,
      jun: 5, juni: 5, june: 5,
      jul: 6, juli: 6, july: 6,
      agu: 7, agustus: 7, aug: 7, august: 7,
      sep: 8, sept: 8, september: 8,
      okt: 9, oktober: 9, oct: 9, october: 9,
      nov: 10, november: 10,
      des: 11, desember: 11, dec: 11, december: 11
    };
    const [, dd, monthRaw, yyyy] = match;
    const month = months[monthRaw.toLowerCase()];
    if (month === undefined) return null;
    const year = yyyy ? Number(yyyy.length === 2 ? `20${yyyy}` : yyyy) : fallbackYear;
    return jakartaDateToUtcDate(year, month, Number(dd));
  }

  return null;
}

function inferStatementYear(text) {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  return years.length ? years.sort((a, b) => b - a)[0] : new Date().getFullYear();
}

function getArgValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];

  return null;
}

function parseLocalDateBoundary(value, endOfDay = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  const [, yyyy, mm, dd] = match;
  const date = endOfDay
    ? jakartaDateToUtcDate(Number(yyyy), Number(mm) - 1, Number(dd), 23, 59, 59, 999)
    : jakartaDateToUtcDate(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0, 0);
  if (isNaN(date.getTime())) throw new Error(`Invalid date: ${value}.`);
  return date;
}

function parseDateFilter(args) {
  const month = getArgValue(args, "--month");
  const from = getArgValue(args, "--from");
  const to = getArgValue(args, "--to");

  if (month && (from || to)) {
    throw new Error("Use either --month or --from/--to, not both.");
  }

  if (month) {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error(`Invalid month: ${month}. Use YYYY-MM.`);
    const [, yyyy, mm] = match;
    const year = Number(yyyy);
    const monthIndex = Number(mm) - 1;
    if (monthIndex < 0 || monthIndex > 11) throw new Error(`Invalid month: ${month}.`);
    return {
      label: month,
      from: jakartaDateToUtcDate(year, monthIndex, 1, 0, 0, 0, 0),
      to: jakartaDateToUtcDate(year, monthIndex + 1, 1, 0, 0, 0, 0)
    };
  }

  if (from || to) {
    return {
      label: [from || "beginning", to || "end"].join(" to "),
      from: from ? parseLocalDateBoundary(from) : null,
      to: to ? parseLocalDateBoundary(to, true) : null
    };
  }

  return null;
}

function applyDateFilter(rows, filter) {
  if (!filter) return rows;
  return rows.filter((row) => {
    const occurred = new Date(row.occurred_at);
    if (filter.from && occurred < filter.from) return false;
    if (filter.to && occurred >= filter.to) return false;
    return true;
  });
}

function extractTextFromPdf(pdfPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "jenius-pdf-"));
  const txtPath = join(tempDir, "statement.txt");
  try {
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath], { stdio: "pipe" });
    return readFileSync(txtPath, "utf8");
  } catch (error) {
    throw new Error("Could not extract PDF text. Install Poppler first: brew install poppler");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function inferCategory(description) {
  const text = description.toLowerCase();
  const rules = [
    ["Bills", /\b(cloudflare|google|instagram|meta|pln|pdam|indihome|telkom|netflix|spotify|subscription|tagihan|bill)\b/],
    ["Food", /\b(nasi|uduk|jco|marugame|udon|sukiya|solaria|coffee|kopi|cafe|restaurant|resto|food|makan|ayam|bakmi|sate|burger|pizza)\b/],
    ["Transport", /\b(gojek|grab|taxi|bluebird|mrt|krl|kereta|tol|parking|parkir|shell|pertamina|bp\b)\b/],
    ["Transfer", /\b(transfer|top up|topup|gopay|ovo|dana|shopeepay|feesible|bxc|yuni kue|axxxx|rxxxxx|sxxxxx)\b/],
    ["Shopping", /\b(tokopedia|shopee|lazada|blibli|bukalapak|tiktok shop|zalora|uniqlo|ikea)\b/],
    ["Health", /\b(apotek|pharmacy|doctor|dokter|clinic|klinik|hospital|rumah sakit|halodoc)\b/],
    ["Entertainment", /\b(cinema|bioskop|xxi|cgv|game|steam|playstation|nintendo)\b/],
    ["Travel", /\b(travel|hotel|flight|tiket|booking|airbnb|agoda|traveloka)\b/]
  ];

  return rules.find(([, pattern]) => pattern.test(text))?.[0] || DEFAULT_CATEGORY;
}

function findStatementAmount(rest) {
  const amountPattern = /(?<![\w])(?<sign>-)?\s*(?<amount>\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?![\w])/g;
  const matches = [...rest.matchAll(amountPattern)];
  if (!matches.length) return null;

  const signed = matches.find((match) => match.groups?.sign === "-");
  if (signed) return signed;

  const moneyLike = matches.filter((match) => /[.,]/.test(match.groups?.amount || match[0]));
  if (moneyLike.length) return moneyLike[moneyLike.length >= 2 ? moneyLike.length - 2 : moneyLike.length - 1];

  return matches[matches.length >= 2 ? matches.length - 2 : matches.length - 1];
}

function parseJeniusTransactions(text, sourceFile) {
  const fallbackYear = inferStatementYear(text);
  const rows = [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const datePattern = /^(?<date>(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|(?:\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{2,4})?))\s+(?<rest>.+)$/;

  for (const line of lines) {
    if (/angga\s+radifan\s+sumarna/i.test(line)) continue;

    const dateMatch = line.match(datePattern);
    if (!dateMatch?.groups) continue;

    const transactionDateRaw = dateMatch.groups.date;
    const occurred = parseDate(transactionDateRaw, fallbackYear);
    if (!occurred) continue;

    const rest = dateMatch.groups.rest;
    const amountMatch = findStatementAmount(rest);
    if (!amountMatch) continue;

    const sign = amountMatch.groups?.sign === "-" ? "-" : "";
    const signedAmount = normalizeAmount(`${sign}${amountMatch.groups?.amount || amountMatch[0]}`);
    if (!Number.isFinite(signedAmount) || signedAmount === 0) continue;

    const description = rest
      .slice(0, amountMatch.index)
      .replace(/\s+[-–]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description || /saldo|balance|total|mutasi|rekening|periode/i.test(description)) continue;

    rows.push({
      type: signedAmount < 0 ? "outcome" : "income",
      amount: Math.abs(signedAmount),
      categoryName: inferCategory(description),
      accountName: DEFAULT_ACCOUNT,
      occurred_at: occurred.toISOString(),
      description: description.slice(0, 500),
      metadata: {
        source: "jenius_pdf",
        source_file: basename(sourceFile),
        transaction_date: occurred.toISOString().slice(0, 10),
        transaction_date_raw: transactionDateRaw,
        raw_line: line
      }
    });
  }

  return rows;
}

async function supabaseRequest(path, options = {}) {
  const url = `${requireEnv("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`;
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const method = options.method || "GET";
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    console.error("Supabase request failed before receiving a response.", {
      method,
      url,
      message: error instanceof Error ? error.message : String(error),
      cause: error?.cause
    });
    throw error;
  }

  const text = await response.text();
  if (!response.ok) {
    console.error("Supabase returned an error response.", {
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      body: text
    });
    throw new Error(`Supabase ${path} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithRetry(url, options, label) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      const code = error?.cause?.code;
      const retryable = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code);
      if (!retryable || attempt === maxAttempts) throw error;

      const delay = attempt * 1000;
      console.warn(`${label} failed with ${code}; retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
      await sleep(delay);
    }
  }
}

async function getOrCreate(table, name, extra = {}) {
  const encoded = encodeURIComponent(name);
  const found = await supabaseRequest(`${table}?select=id&name=ilike.${encoded}&limit=1`);
  if (found?.[0]) return found[0].id;

  const inserted = await supabaseRequest(`${table}?select=id`, {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ name, ...extra })
  });
  return inserted[0].id;
}

async function findDuplicate(row) {
  const occurred = encodeURIComponent(row.occurred_at);
  const amount = encodeURIComponent(String(row.amount));
  const description = encodeURIComponent(row.description);
  const existing = await supabaseRequest(
    `transaction_staging?select=id,status&status=neq.rejected&occurred_at=eq.${occurred}&amount=eq.${amount}&description=eq.${description}&limit=1`
  );
  return existing?.[0] || null;
}

async function insertStaging(row) {
  const category_id = await getOrCreate("categories", row.categoryName, { allowed_type: "both" });
  const account_id = await getOrCreate("accounts", row.accountName);
  const duplicate = await findDuplicate(row);
  if (duplicate) return { id: duplicate.id, duplicate: true };

  const inserted = await supabaseRequest("transaction_staging?select=id", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      type: row.type,
      amount: row.amount,
      category_id,
      account_id,
      user_id: DEFAULT_USER_ID,
      currency: "IDR",
      occurred_at: row.occurred_at,
      description: row.description,
      status: "pending",
      metadata: row.metadata
    })
  });

  return { id: inserted[0].id, duplicate: false };
}

async function sendTelegramConfirmation(stagingId, row, duplicate) {
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  if (!TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_CONFIRM_CHAT_ID or ALLOWED_CHAT_IDS");

  const when = new Date(row.occurred_at).toLocaleString("en-GB", {
    timeZone: "Asia/Jakarta",
    hour12: false
  });
  const title = duplicate ? "Jenius PDF transaction already staged" : "Jenius PDF transaction detected";
  let response;
  try {
    response = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        parse_mode: "HTML",
        text: `<b>${title}</b>\n\nType: ${row.type}\nAmount: ${row.amount.toLocaleString("id-ID")} IDR\nCategory: ${row.categoryName}\nAccount: ${row.accountName}\nWhen: ${when}\nDescription: ${row.description}\n\nSave this transaction?`,
        reply_markup: {
          inline_keyboard: [[
            { text: "Confirm", callback_data: `confirm:${stagingId}` },
            { text: "Reject", callback_data: `reject:${stagingId}` }
          ]]
        }
      })
    }, "Telegram sendMessage");
  } catch (error) {
    console.error("Telegram request failed before receiving a response.", {
      url: "https://api.telegram.org/bot<redacted>/sendMessage",
      chatId: TELEGRAM_CHAT_ID,
      message: error instanceof Error ? error.message : String(error),
      cause: error?.cause
    });
    throw error;
  }

  const payload = await response.json();
  if (!payload.ok) {
    console.error("Telegram returned an error response.", {
      status: response.status,
      statusText: response.statusText,
      payload
    });
    throw new Error(payload?.description || `Telegram error: ${response.status}`);
  }

  await supabaseRequest(`transaction_staging?id=eq.${encodeURIComponent(stagingId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      metadata: {
        ...row.metadata,
        telegram_chat_id: String(payload.result.chat.id),
        telegram_message_id: payload.result.message_id
      }
    })
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const pdfArg = args.find((arg) => !arg.startsWith("--"));

  if (!pdfArg) {
    usage();
    process.exitCode = 1;
    return;
  }

  const pdfPath = resolve(pdfArg);
  if (!existsSync(pdfPath) || !statSync(pdfPath).isFile()) throw new Error(`PDF not found: ${pdfPath}`);

  const text = extractTextFromPdf(pdfPath);
  const dateFilter = parseDateFilter(args);
  const allRows = parseJeniusTransactions(text, pdfPath);
  const rows = applyDateFilter(allRows, dateFilter);
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);

  console.log(`Found ${allRows.length} candidate transactions in ${basename(pdfPath)} (${fingerprint}).`);
  if (dateFilter) {
    console.log(`Date filter ${dateFilter.label}: ${rows.length} transaction(s) selected.`);
  }
  if (!rows.length) {
    console.log("No rows imported. Run pdftotext manually and adjust parser patterns for this statement layout.");
    return;
  }

  if (dryRun) {
    console.table(rows.map((row) => ({
      type: row.type,
      amount: row.amount,
      category: row.categoryName,
      account: row.accountName,
      occurred_at: row.occurred_at.slice(0, 10),
      date_raw: row.metadata.transaction_date_raw,
      description: row.description
    })));
    return;
  }

  for (const row of rows) {
    row.metadata.statement_fingerprint = fingerprint;
    const { id, duplicate } = await insertStaging(row);
    await sendTelegramConfirmation(id, row, duplicate);
    console.log(`${duplicate ? "Skipped duplicate" : "Staged"} ${id}: ${row.type} ${row.amount} ${row.description}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

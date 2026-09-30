#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");

loadDotEnv(resolve(process.cwd(), ".env"));
loadDotEnv(resolve(PROJECT_DIR, ".env"));

const DEFAULT_CATEGORY = process.env.JENIUS_DEFAULT_CATEGORY || "Payment";
const DEFAULT_ACCOUNT = "Jenius";
const MANDIRI_ACCOUNT = "Mandiri";
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
  console.log(`Usage: node scripts/import-bank-pdf.mjs <statement.pdf> [--dry-run] [--month YYYY-MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--ask-password | --password-stdin]

Protected PDFs:
  --ask-password    Prompt securely for the PDF password (input is hidden)
  --password-stdin  Read the PDF password from standard input

Required env:
  SUPABASE_URL
  SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (temporary compatibility)
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

function getSupabaseSecretKey() {
  return process.env.SUPABASE_SECRET_KEY || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
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

function commandFailureMessage(error) {
  return [error?.stderr, error?.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""))
    .join("\n")
    .trim();
}

function isMissingCommand(error, command) {
  return error?.code === "ENOENT" || commandFailureMessage(error).includes(`spawnSync ${command} ENOENT`);
}

function readPasswordFromStdin() {
  const password = readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
  if (!password) throw new Error("No PDF password was provided on standard input.");
  return password;
}

function promptHiddenPassword(prompt = "PDF password: ") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--ask-password needs an interactive terminal. Use --password-stdin for automation.");
  }

  return new Promise((resolvePassword, rejectPassword) => {
    const input = process.stdin;
    let password = "";

    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) rejectPassword(error);
      else if (!password) rejectPassword(new Error("PDF password cannot be empty."));
      else resolvePassword(password);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Password entry cancelled."));
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else if (character >= " ") {
          password += character;
        }
      }
    };

    input.on("data", onData);
  });
}

function decryptPdf(pdfPath, password, tempDir) {
  const decryptedPath = join(tempDir, "statement-unlocked.pdf");
  try {
    execFileSync(
      "qpdf",
      ["--password-file=-", "--decrypt", pdfPath, decryptedPath],
      { input: `${password}\n`, stdio: ["pipe", "pipe", "pipe"] }
    );
    chmodSync(decryptedPath, 0o600);
    return decryptedPath;
  } catch (error) {
    if (isMissingCommand(error, "qpdf")) {
      throw new Error("Protected PDF support requires qpdf. Install it with: brew install qpdf");
    }
    const detail = commandFailureMessage(error);
    if (/invalid password|incorrect password/i.test(detail)) {
      throw new Error("The PDF password is incorrect.");
    }
    throw new Error(`Could not unlock the protected PDF${detail ? `: ${detail}` : "."}`);
  }
}

function extractTextFromPdf(pdfPath, password = null) {
  const tempDir = mkdtempSync(join(tmpdir(), "jenius-pdf-"));
  chmodSync(tempDir, 0o700);
  const txtPath = join(tempDir, "statement.txt");
  try {
    const readablePdfPath = password ? decryptPdf(pdfPath, password, tempDir) : pdfPath;
    execFileSync("pdftotext", ["-layout", readablePdfPath, txtPath], { stdio: "pipe" });
    chmodSync(txtPath, 0o600);
    return readFileSync(txtPath, "utf8");
  } catch (error) {
    if (error instanceof Error && /qpdf|password|unlock/i.test(error.message)) throw error;
    if (isMissingCommand(error, "pdftotext")) {
      throw new Error("Could not find pdftotext. Install Poppler first: brew install poppler");
    }
    const detail = commandFailureMessage(error);
    if (!password && /password|encrypted/i.test(detail)) {
      throw new Error("This PDF is protected. Run again with --ask-password or --password-stdin.");
    }
    throw new Error(`Could not extract PDF text${detail ? `: ${detail}` : "."}`);
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
    ["Transfer", /\b(transfer|bi fast|ke bank|top up|topup|gopay|ovo|dana|shopeepay|feesible|bxc|yuni kue|axxxx|rxxxxx|sxxxxx)\b/],
    ["Fees", /\b(biaya administrasi|admin fee|service fee)\b/],
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

function isMandiriStatement(text) {
  return /Nominal\s*\(IDR\)[\s\S]{0,120}Saldo\s*\(IDR\)/i.test(text) ||
    /Amount\s*\(IDR\)[\s\S]{0,120}Balance\s*\(IDR\)/i.test(text);
}

function applyMandiriTime(row, timeRaw) {
  const dateMatch = row.metadata.transaction_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeRaw.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return;

  const [, year, month, day] = dateMatch;
  const [, hour, minute, second] = timeMatch;
  row.occurred_at = jakartaDateToUtcDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).toISOString();
  row.metadata.transaction_time_raw = `${timeRaw} WIB`;
}

function isMandiriTransactionPrefix(line) {
  return /^(?:biaya\s+transaksi\s+bank|transfer(?:\s+bi\s+fast|\s+online)?|pembayaran|pembelian|top\s*up|tarik\s+tunai|setoran|penerimaan|refund)\b/i.test(line.trim());
}

function isMandiriBoilerplate(line) {
  return /(?:PT Bank Mandiri \(Persero\)|Otoritas Jasa Keuangan|Mandiri Call 14000|Lembaga Penjamin Simpanan|e-Statement|Menara Mandiri|Jalan Jenderal Sudirman|Nama\/Name\s*:|Periode\/Period\s*:|Cabang\/Branch\s*:|Dicetak pada\/Issued on\s*:|ini adalah batas akhir transaksi|Disclaimer from Bank Mandiri|Customer'?s role responsibility|Nasabah tunduk dan terikat|Customers are subject to and bound|Livin'? Term(?:s)? and Conditions|\b\d+\s+dari\s+\d+\b|\b\d+\s+of\s+\d+\b)/i.test(line);
}

function cleanMandiriDescription(description, dateRaw) {
  const withoutDate = description
    .replace(/\s+(?:ini adalah batas akhir transaksi|Disclaimer from Bank Mandiri|Customer'?s role responsibility|\d+\.\s*Nasabah tunduk dan terikat|Nasabah tunduk dan terikat|Customers are subject to and bound)[\s\S]*$/i, " ")
    .replace(new RegExp(`\\b${dateRaw.replace(/\s+/g, "\\s+")}\\b`, "gi"), " ")
    .replace(/\b\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\b/gi, " ");
  const seenReferences = new Set();
  return withoutDate
    .replace(/\b\d{8,}\b/g, (reference) => {
      if (seenReferences.has(reference)) return " ";
      seenReferences.add(reference);
      return reference;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function parseMandiriTransactions(text, sourceFile) {
  const fallbackYear = inferStatementYear(text);
  const rows = [];
  const skippedNumbers = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const datePattern = /^(?<date>\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})(?:\s+(?<detail>.+))?$/;
  const amountPattern = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g;
  const timePattern = /\b\d{2}:\d{2}:\d{2}\s+WIB\b/i;
  let currentDateRaw = null;
  let currentBlock = null;
  let lastTransactionNumber = null;
  let pendingPrefixLines = [];

  const addPendingPrefix = (line) => {
    const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized || pendingPrefixLines.some((item) => item.toLowerCase() === normalized)) return;
    pendingPrefixLines.push(line.replace(/\s+/g, " ").trim());
  };

  const flushBlock = () => {
    if (!currentBlock) return;

    const block = currentBlock;
    currentBlock = null;
    lastTransactionNumber = block.number;
    const content = block.lines.join(" ").replace(/\s+/g, " ").trim();
    const moneyMatches = [...content.matchAll(amountPattern)];
    if (moneyMatches.length < 2) {
      skippedNumbers.push(block.number);
      return;
    }

    const nominalMatch = moneyMatches[moneyMatches.length - 2];
    const balanceMatch = moneyMatches[moneyMatches.length - 1];
    const signedAmount = normalizeAmount(nominalMatch[0]);
    const occurred = parseDate(block.dateRaw, fallbackYear);
    if (!occurred || !Number.isFinite(signedAmount) || signedAmount === 0) {
      skippedNumbers.push(block.number);
      return;
    }

    const timeRaw = content.match(/\b(\d{2}:\d{2}:\d{2})\s+WIB\b/i)?.[1] || null;
    const beforeNominal = content.slice(0, nominalMatch.index);
    const afterBalance = content.slice((balanceMatch.index || 0) + balanceMatch[0].length);
    const cleanDetail = (value) => value
      .replace(/\b\d{2}:\d{2}:\d{2}\s+WIB\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const description = cleanMandiriDescription(
      [cleanDetail(beforeNominal), cleanDetail(afterBalance)].filter(Boolean).join(" "),
      block.dateRaw
    ).slice(0, 500);
    if (!description) {
      skippedNumbers.push(block.number);
      return;
    }

    const row = {
      type: signedAmount < 0 ? "outcome" : "income",
      amount: Math.abs(signedAmount),
      categoryName: inferCategory(description),
      accountName: MANDIRI_ACCOUNT,
      occurred_at: occurred.toISOString(),
      description,
      metadata: {
        source: "mandiri_pdf",
        source_file: basename(sourceFile),
        transaction_number: block.number,
        transaction_date: occurred.toISOString().slice(0, 10),
        transaction_date_raw: block.dateRaw,
        balance: normalizeAmount(balanceMatch[0]),
        raw_line: block.lines.join(" | ")
      }
    };
    if (timeRaw) applyMandiriTime(row, timeRaw);
    rows.push(row);
  };

  for (const line of lines) {
    const dateMatch = line.match(datePattern);
    if (dateMatch?.groups) {
      flushBlock();
      currentDateRaw = dateMatch.groups.date;
      if (dateMatch.groups.detail && !isMandiriBoilerplate(dateMatch.groups.detail)) {
        addPendingPrefix(dateMatch.groups.detail);
      }
      continue;
    }

    if (isMandiriBoilerplate(line) || /^(?:No|Tanggal|Date|Keterangan|Remarks|Nominal|Amount|Saldo|Balance|Halaman|Page|Bank Mandiri|Rekening|Account|Periode|Period)(?:\s|$)/i.test(line)) {
      continue;
    }

    const numberMatch = line.match(/^(?<number>\d{1,4})(?:\s+(?<rest>.*))?$/);
    if (numberMatch?.groups && currentDateRaw) {
      const number = Number(numberMatch.groups.number);
      const expectedNumber = currentBlock ? currentBlock.number + 1 : lastTransactionNumber === null ? number : lastTransactionNumber + 1;
      if (number === expectedNumber || number === 1) {
        flushBlock();
        const numberedDetail = numberMatch.groups.rest || "";
        const uniquePrefixes = pendingPrefixLines.filter((prefix) =>
          !numberedDetail.toLowerCase().includes(prefix.toLowerCase())
        );
        currentBlock = {
          number,
          dateRaw: currentDateRaw,
          lines: [
            ...uniquePrefixes,
            ...(numberedDetail ? [numberedDetail] : [])
          ],
          sawTime: timePattern.test(numberedDetail)
        };
        pendingPrefixLines = [];
        continue;
      }
    }

    if (currentBlock) {
      const hasAmounts = [...currentBlock.lines.join(" ").matchAll(amountPattern)].length >= 2;
      if (line.match(timePattern)) {
        currentBlock.lines.push(line);
        currentBlock.sawTime = true;
      } else if ((hasAmounts && isMandiriTransactionPrefix(line)) || pendingPrefixLines.length) {
        addPendingPrefix(line);
      } else {
        currentBlock.lines.push(line);
      }
      continue;
    }
  }

  flushBlock();

  for (const row of rows) {
    row.categoryName = inferCategory(row.description);
  }
  if (skippedNumbers.length) {
    console.warn(`Skipped Mandiri transaction number(s) that could not be parsed: ${skippedNumbers.join(", ")}.`);
  }
  return rows;
}

async function supabaseRequest(path, options = {}) {
  const url = `${requireEnv("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`;
  const key = getSupabaseSecretKey();
  const method = options.method || "GET";
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        apikey: key,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    console.error("Supabase request failed before receiving a response.", {
      method,
      url,
      code: error?.cause?.code
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

async function getOrCreateAccount(name) {
  const inserted = await supabaseRequest("accounts?select=id&on_conflict=name", {
    method: "POST",
    headers: { prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ name })
  });
  return inserted[0].id;
}

async function findDuplicate(row) {
  const occurred = encodeURIComponent(row.occurred_at);
  const amount = encodeURIComponent(String(row.amount));
  const description = encodeURIComponent(row.description);
  const existing = await supabaseRequest(
    `transaction_staging?select=id,status&user_id=eq.${encodeURIComponent(requireEnv("DEFAULT_SUPABASE_USER_ID"))}&status=neq.rejected&occurred_at=eq.${occurred}&amount=eq.${amount}&description=eq.${description}&limit=1`
  );
  return existing?.[0] || null;
}

async function insertStaging(row) {
  const userId = requireEnv("DEFAULT_SUPABASE_USER_ID");
  const category_id = await supabaseRequest("rpc/backend_resolve_category", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_name: row.categoryName })
  });
  const account_id = await getOrCreateAccount(row.accountName);
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
      user_id: userId,
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
  const title = duplicate
    ? `${row.accountName} PDF transaction already staged`
    : `${row.accountName} PDF transaction detected`;
  let response;
  try {
    response = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        parse_mode: "HTML",
        text: `<b>${title}</b>\n\nType: ${row.type}\nAmount: ${row.amount.toLocaleString("id-ID")} IDR\nCategory: ${row.categoryName}\nAccount: ${row.accountName}\nWhen: ${when}\nDescription: ${row.description}\n\nReview the category and account, then confirm to save.`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Confirm", callback_data: `confirm:${stagingId}` },
              { text: "Reject", callback_data: `reject:${stagingId}` }
            ],
            [
              { text: "Edit category", callback_data: `ec:${stagingId}:0` },
              { text: "Edit account", callback_data: `ea:${stagingId}:0` }
            ]
          ]
        }
      })
    }, "Telegram sendMessage");
  } catch (error) {
    console.error("Telegram request failed before receiving a response.", {
      url: "https://api.telegram.org/bot<redacted>/sendMessage",
      chatId: TELEGRAM_CHAT_ID,
      code: error?.cause?.code
    });
    throw new Error("Telegram request failed.");
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
  const askPassword = args.includes("--ask-password");
  const passwordStdin = args.includes("--password-stdin");
  const pdfArg = args.find((arg) => !arg.startsWith("--"));

  if (askPassword && passwordStdin) {
    throw new Error("Use either --ask-password or --password-stdin, not both.");
  }

  if (!pdfArg) {
    usage();
    process.exitCode = 1;
    return;
  }

  const pdfPath = resolve(pdfArg);
  if (!existsSync(pdfPath) || !statSync(pdfPath).isFile()) throw new Error(`PDF not found: ${pdfPath}`);

  const password = askPassword
    ? await promptHiddenPassword()
    : passwordStdin
      ? readPasswordFromStdin()
      : null;
  const text = extractTextFromPdf(pdfPath, password);
  const dateFilter = parseDateFilter(args);
  const statementType = isMandiriStatement(text) ? "Mandiri" : "Jenius";
  const allRows = statementType === "Mandiri"
    ? parseMandiriTransactions(text, pdfPath)
    : parseJeniusTransactions(text, pdfPath);
  const rows = applyDateFilter(allRows, dateFilter);
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);

  console.log(`Detected ${statementType} statement.`);
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
      occurred_at: row.metadata.transaction_date,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { applyDateFilter, parseDateFilter, parseMandiriTransactions };

here’s a clean, copy-paste **README** you can drop into your repo 👇

# Telegram ➜ Supabase Edge Function (Personal Finance Logger)

Log income/outcome transactions from Telegram directly into your Supabase Postgres.
Supports category, account, optional local date/time (Asia/Jakarta), and auto-replies with a receipt.

---

## Features

* Parse messages like:
  `outcome 75000 Food BCA Lunch at warung`
  `income 10000000 Salary BCA [2025-08-29 11:30] August salary`
* **Accounts** and **Categories** auto-created if missing
* **Amounts always positive**; `type` is `income|outcome`
* **Timezone aware**: optional `[YYYY-MM-DD HH:MM]` is treated as **Jakarta** time and stored as UTC
* Telegram **reply** confirming saved txn (shows Jakarta time)

---

## Prereqs

* Supabase project (Postgres schema created: `accounts`, `categories`, `transactions`, trigger optional)
* Telegram bot token from **@BotFather**
* Supabase CLI installed (optional if deploying from dashboard)

---

## Database Setup

### Option A: Using Migrations (Recommended)

This project includes database migrations for easy setup:

1. **Apply migrations via Supabase CLI:**
   ```bash
   # From project root
   supabase link --project-ref <YOUR_PROJECT_REF>
   supabase db push
   ```

2. **Or apply manually via Dashboard:**
   - Go to **Dashboard → SQL Editor**
   - Run migration files in order from `supabase/migrations/`:
     1. `20250109010001_initial_schema.sql`
     2. `20250109010002_seed_data.sql`

### Option B: Manual Schema Creation

If you prefer to create tables manually:

* `transactions(type, amount, category_id, account_id, currency default 'IDR', occurred_at, description, created_at default now())`
* `categories(name unique, allowed_type default 'both')`
* `accounts(name unique)`

> **Note:** Using migrations is recommended as they include indexes, validation, and seed data.

### Database Schema Details

- **accounts**: Bank accounts and payment methods (BCA, OVO, Cash, etc.)
- **categories**: Transaction categories with type restrictions (Food, Salary, etc.)
- **transactions**: Financial records linking accounts and categories
- **Includes**: Indexes, validation triggers, and helper views
- **Seed data**: Common Indonesian accounts and categories

---

## Function Source

The function file is `index.ts` (Deno runtime).
It:

* Verifies Telegram webhook via `x-telegram-bot-api-secret-token`
* Parses text, resolves/creates category & account, inserts transaction
* Converts optional `[YYYY-MM-DD HH:MM]` from **Asia/Jakarta** to UTC
* Replies back in Telegram with a receipt

> Keep the imports exactly like this for Supabase Edge Functions:

```ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
```

---

## Deploy (two ways)

### A) From Supabase Dashboard (simplest)

1. **Edge Functions → Open Editor** → **Create function** → name: `telegram-webhook`
2. Paste the full `index.ts` content.
3. Function settings: **Disable “Verify JWT”**.
4. **Secrets** (Edge Functions → Secrets):

   * `SUPABASE_URL` = `https://<PROJECT-REF>.supabase.co`
   * `SUPABASE_SERVICE_ROLE_KEY` = your service role key
   * `TELEGRAM_SECRET_TOKEN` = any long random string (you will reuse below)
   * `TELEGRAM_BOT_TOKEN` = from BotFather
   * `ALLOWED_CHAT_IDS` = your Telegram user ID (e.g. `123456789`) or blank
5. Click **Deploy**; copy the function URL:
   `https://<PROJECT-REF>.supabase.co/functions/v1/telegram-webhook`

### B) From CLI

```bash
npm i -g supabase
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase functions new telegram-webhook   # creates folder & index.ts
# paste code, then:
supabase secrets set \
  SUPABASE_URL=https://<PROJECT-REF>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
  TELEGRAM_SECRET_TOKEN=<RANDOM_SECRET> \
  TELEGRAM_BOT_TOKEN=<BOTFATHER_TOKEN> \
  ALLOWED_CHAT_IDS=123456789
supabase functions deploy telegram-webhook --no-verify-jwt
```

---

## Set Telegram Webhook

Call Telegram’s API to register your function as the webhook:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<PROJECT-REF>.supabase.co/functions/v1/telegram-webhook",
    "secret_token": "<TELEGRAM_SECRET_TOKEN>"
  }'
```

* The `secret_token` **must match** your `TELEGRAM_SECRET_TOKEN`.
* Telegram will include it in every request header:
  `x-telegram-bot-api-secret-token: <...>`

---

## Message Format

```
<type> <amount> <category> <account> [optional [YYYY-MM-DD HH:MM]] <description>
```

**Examples**

```
outcome 75000 Food BCA Lunch at warung
income  10000000 Salary BCA [2025-08-29 11:30] August salary
```

**Rules**

* `type`: `income` or `outcome`
* `amount`: positive number; `75.000` and `75,000.50` are accepted
* `category`: single token (e.g., `Food`, `Salary`)
* `account`: single token (e.g., `BCA`, `OVO`, `Cash`)
* `[date]` optional; if present, treated as **Asia/Jakarta**, converted to **UTC** for storage
* `description` optional (free text)

> (You can extend the parser later for multi-word category/account and `Rp75.000` formats.)

---

## Timezone Behavior

* **Without `[date]`**: uses the exact function trigger time (`new Date()` in UTC).
* **With `[date]`**: `YYYY-MM-DD HH:MM` is interpreted as **Jakarta (UTC+7)**, converted to UTC before insert.
* Bot replies show the stored time rendered in **Asia/Jakarta** for clarity.

---

## Testing

1. DM your bot:

   ```
   outcome 76000 Food BCA [2025-08-29 11:30] Koi Teppanyaki
   ```
2. Expect a reply:

   ```
   ✅ Saved outcome 76000 IDR
   Category: Food
   Account: BCA
   When: 29/08/2025, 11:30:00
   Description: Koi Teppanyaki
   Ref: <uuid>
   ```
3. Check **Supabase → Database → Table Editor → transactions** for the row.
4. Use **Edge Functions → Logs** to debug parsing or DB errors.

---

## Troubleshooting

* **401 Unauthorized** → `TELEGRAM_SECRET_TOKEN` mismatch with `setWebhook` value.
* **403 forbidden** → Your `chat.id` not in `ALLOWED_CHAT_IDS`.
* **Insert error** → Check DB constraints (e.g., enums), table names, or function logs.
* **Wrong time in reply** → Verify you included date in Jakarta, or you’re viewing reply formatted with `Asia/Jakarta`.

---

## Security Notes

* Keep **service role key** in function **secrets** only (never in client).
* Restrict writers with `ALLOWED_CHAT_IDS`.
* Optionally enable **RLS** if you later expose REST/RPC to clients (function can keep service role).

---

## Optional Enhancements

* Multi-word category/account support (`"Food&Drink"`, `"Bank Central Asia"`)
* Amount formats like `Rp75.000`, `75k`
* Emoji-based replies for income (`💰`) vs outcome (`💸`)
* Commands: `/out 75000 Food BCA Lunch`
* Analytics RPCs: monthly summary, top categories
* Budget tables and alerts

---

## Unregister Webhook (if needed)

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook"
```

---

**That’s it.** Paste this into your repo as `README.md`, and you’re good to go ✨

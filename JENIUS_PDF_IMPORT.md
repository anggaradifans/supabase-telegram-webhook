# Jenius PDF Import

This repo includes a local importer that extracts candidate transactions from a Jenius transaction history PDF, inserts them into `transaction_staging`, and sends Telegram inline buttons for confirmation. Confirmed rows are handled by the existing `telegram-webhook` callback flow.

## Setup

Install Poppler so the script can run `pdftotext`:

```bash
brew install poppler
```

Set the required environment variables:

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
export TELEGRAM_CONFIRM_CHAT_ID="your-chat-id"
```

You can also put these values in `.env` in the Supabase project root. The script loads `.env` automatically.

Optional:

```bash
export DEFAULT_SUPABASE_USER_ID="your-supabase-user-id"
export JENIUS_ACCOUNT="Jenius"
export JENIUS_DEFAULT_CATEGORY="Uncategorized"
```

## Run

Preview extracted rows without writing anything:

```bash
node scripts/import-jenius-pdf.mjs ~/Downloads/jenius.pdf --dry-run
```

Preview only September 2026:

```bash
node scripts/import-jenius-pdf.mjs ~/Downloads/jenius.pdf --month 2026-09 --dry-run
```

Preview a custom date range:

```bash
node scripts/import-jenius-pdf.mjs ~/Downloads/jenius.pdf --from 2026-09-01 --to 2026-09-30 --dry-run
```

Stage rows and send Telegram confirmations:

```bash
node scripts/import-jenius-pdf.mjs ~/Downloads/jenius.pdf
```

Stage only September 2026:

```bash
node scripts/import-jenius-pdf.mjs ~/Downloads/jenius.pdf --month 2026-09
```

## Notes

The parser is intentionally conservative and should be tested with `--dry-run` against your real Jenius PDF first. Statement layouts vary, and the script stores the original line in `transaction_staging.metadata.raw_line` so it is easier to tune if a row is parsed incorrectly.

Amount signs follow the Jenius statement value: negative values such as `-90,000` are staged as `outcome` with amount `90000`, while values without `-` are staged as `income`. Lines containing `Angga Radifan Sumarna` are ignored.

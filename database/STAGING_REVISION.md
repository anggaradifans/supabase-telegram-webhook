# Revise a pending receipt in Telegram

New email receipt confirmations have **Edit category** and **Edit account** buttons. The menu shows eight existing choices per page, marks the current selection, and offers Previous, Next, and Back to review. Choosing a value updates the pending receipt and restores Confirm/Reject. It does not save a transaction until Confirm is pressed.

Categories are limited to the owner's private categories and shared defaults compatible with the receipt's income/outcome type. Accounts use the existing shared account catalog. The database verifies the active Telegram sender and receipt owner on every menu request and selection. Edits and confirmations lock the same staging row; confirmed or rejected receipts cannot be revised.

Edits apply only to that receipt. There is no merchant learning, category creation from the menu, or automatic repair of historical transactions. Older Telegram messages retain their original buttons.

## Rollout

1. Verify the prerequisites in `TELEGRAM_COMPATIBILITY.md` have been deployed, including the browser RLS migration and `20260915_backend_compatibility.sql`. Do not replay historical setup or seed migrations.
2. Apply `database/20260917_staging_revision.sql` to the intended Supabase project. It adds one service-role-only RPC; it does not modify existing receipt data.
3. Deploy `functions/telegram-webhook/index.ts` before `functions/receipt-email-worker/index.ts` so new buttons have a handler.
4. Deploy the Cloudflare `receipt-email-worker` for merchant-aware classification.
5. With an authorized test receipt, verify category selection, account selection, Back, Confirm, and Reject in the private bot chat. Confirm the saved transaction uses the reviewed values.

For rollback, deploy the previous email handler first to stop emitting new buttons; keep the revision RPC and Telegram handler available for already-sent messages.

## Local validation

```sh
node --test database/tests/handlers.test.cjs
python3 database/tests/run.py
```

The handler tests mock Telegram/Supabase transport and cover menu navigation, selection, HTML escaping, callback sizes, invalid selections, and failure reporting. Compact UUIDs keep both record IDs within Telegram's [64-byte callback limit](https://core.telegram.org/bots/api#inlinekeyboardbutton).

The database suite creates a disposable local PostgreSQL cluster. It requires the sibling `supabase-registration` fixture/migration and local PostgreSQL tools, exercises ownership, category visibility/type, pending status, and revised confirmation values, and races edits against confirmation. It never uses production connection settings.

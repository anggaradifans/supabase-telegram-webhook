# Mark a pending receipt as a transfer to your own account

Outgoing receipt confirmations (email, and PDF imports) have an **🔁 Own account** button. It opens the account picker (eight accounts per page, same currency as the receipt, never the source account). Choosing one turns the review into `From: <source>` / `To: <destination>`, replaces the category line, and adds **↩ Not a transfer** and **Change destination**. Confirm then saves both transfer legs (a debit on the source, a credit on the destination) instead of one spending row, so nothing counts as spending, income or budget use.

Nothing decides on its own that an account is yours: the destination is always picked by hand. Detecting it automatically (a registry of your own account numbers) is a later phase.

## Things to know

- Only an **outgoing** receipt can be a transfer, and it needs a source account. If the source shows the generic `Bank` account, use **Edit account** first.
- Both accounts must use the receipt's currency; cross-currency transfers wait for the multi-currency work.
- Receipts are not paired. If the destination bank also emails you a credit for the same movement, that is a separate receipt: **reject it**, or the destination is credited twice. The confirmation message says so.
- `/confirm_all` confirms a receipt that carries a destination as a transfer, like the button does.
- The destination is stored in `transaction_staging.transfer_to_account_id`, not in `metadata`, so writers that replace `metadata` cannot drop it.
- That column is a foreign key to `accounts`, so a **pending** receipt with a destination stops that account being deleted (the dashboard cannot see staging rows to explain it). Rejecting a receipt releases the destination; a confirmed transfer pins the account through its legs like any transaction.

## Where the SQL lives

The database side is `supabase/migrations/20261031120000_staged_transfers.sql` in **financial-tracker-dashboard**, on top of `20261031100000_transfer_types.sql` and `20261031110000_linked_transfers.sql`. It replaces `backend_revise_staged_transaction` and `backend_process_staged_transaction` and adds the column. The files in this folder that first defined those functions are superseded and carry a note:

- `20260915_backend_compatibility.sql` uses plain `CREATE FUNCTION`, so running it again fails on the first existing object.
- `20260917_staging_revision.sql` uses `CREATE OR REPLACE`. Running it again silently restores the old revise function; the new buttons then answer "Invalid revision action". Do not re-run it.

## Rollout

0. **The dashboard must handle transfer legs before the new webhook ships.** Once the webhook is live, confirming from Telegram creates real transfer legs, and today's dashboard mishandles them: the account balance subtracts both legs, the transaction list shows both as red spending, the time-series chart counts both as outcome, and deleting or editing a leg does nothing (the delete is a plain update that the database now refuses to match, so the row disappears from the screen until the next refresh). A transfer confirmed by mistake could not be undone from the dashboard at all. Minimum before deploying: correct balance and sign handling, delete a leg through `delete_transfer`, hide edit on legs, and give `getTimeSeriesData` an explicit income/outcome branch instead of a bare `else`. The migrations can ship alone; the webhook cannot.
1. In financial-tracker-dashboard, apply the three transfer migrations in order, **each as its own transaction** (`supabase db push` does this; in the SQL Editor run one file at a time). The goals migration `20261030120000` must already be applied.
2. Deploy `functions/telegram-webhook/index.ts` **before** `functions/receipt-email-worker/index.ts`, so the new button has a handler.
3. `scripts/import-bank-pdf.mjs` is run by hand; it shows the button once you use the new version.
4. With a test outgoing receipt in the private bot chat: Own account → pick the destination → check the review → Confirm. Check the Transactions page shows one debit and one credit with no category, then repeat with **↩ Not a transfer** and with Reject.

Rollback: deploy the previous email worker first so no new button is emitted, then the previous webhook. Old messages that still show the button answer "Unknown action" on the old webhook. Before rolling back the database functions, confirm or reject every receipt that carries a destination; the old confirm would save it as ordinary spending.

## Validation

```sh
node --test database/tests/handlers.test.cjs
```

The handler tests mock Telegram and Supabase and cover the picker, selection, clearing, the route in the review, the confirm messages for the button and the reply path, budgets staying untouched, and the email/PDF keyboards. They load TypeScript from `../financial-tracker-dashboard/node_modules` (the sibling repo was renamed from `supabase-registration`).

The database behaviour (picker rules, ownership, confirm creating both legs, replays, all-or-nothing failures, and concurrent confirm/edit races) is tested in financial-tracker-dashboard with `bash database/tests/run.sh`. `database/tests/run.py` here still points at the old repo name and was not run.

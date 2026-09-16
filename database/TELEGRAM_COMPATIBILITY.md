# Telegram backend compatibility audit

September 15, 2026. **Production is not ready for rollout. Local fixes are prepared and tested.**

Original local source commit: `d322129`.

## Verified production state

- Supabase project `csyudifshyrxksebhlma`: `telegram-webhook` v32 and `receipt-email-worker` v5 are active with gateway JWT verification disabled. Their downloaded sources exactly match the original local Git HEAD files. Telegram `getWebhookInfo` points to this project's `telegram-webhook` URL.
- Telegram source SHA-256: `72adfffea85b29e786a33271c911cdb4f342d4cfe71ca75cf93b7f504940d1b1`.
- Receipt source SHA-256: `a521264eadc69a1226f92b9b063aee0dd73274b465835e2142c00ce45db5ed80`.
- The browser migration is **unapplied**: `categories.user_id` is absent, `categories_name_key` remains globally unique, and public tables have four policies total. Existing service-role table grants remain present.
- The old privileged credential in the frontend's local environment is **still accepted**: a zero-row REST query returned HTTP 200. No credential value was printed or saved in this report.
- The deployed frontend bundle/version was not independently identified or checked. The prepared frontend changes remain local in `supabase-registration`; this task did not change them.
- The production category-alignment trigger selects by category ID and checks `allowed_type`; it neither looks up names nor changes categories. Its audited body is included in the disposable test fixture. The timestamp trigger only sets `updated_at`.
- Aggregate preflight: zero pending staging rows have NULL owners; zero existing transactions have the new `telegram_update_id` metadata field. These are point-in-time checks.

## Identity and receipt-routing verification

Completed September 16, 2026. The account owner confirmed this mapping is correct:

| Role | Verified value |
| --- | --- |
| Telegram sender | `@anggaradifans` / `5028026567` |
| Supabase account | `anggaradifans@gmail.com` / `ccbd26d4-51e1-4925-ba12-c516f5c584d1` |
| Receipt/PDF owner | The same Supabase user ID |
| Confirmation chat | The same Telegram ID; Telegram reports it as a private chat |

- There is one active `telegram_users` mapping. It owns all 918 transactions and has no pending staging rows.
- The deployed `ALLOWED_CHAT_IDS`, `DEFAULT_SUPABASE_USER_ID`, bot token, and service-role-key secret digests match their local backend counterparts. `TELEGRAM_CONFIRM_CHAT_ID` is local-only; the deployed receipt function falls back to the matching allowed-chat setting.
- Telegram reports the expected webhook URL, no pending updates, no reported webhook error, and the expected message, edited-message, and callback-query update types.
- Cloudflare Email Routing is ready and enabled for `radifans.my.id`. Its enabled rule sends `receipts@radifans.my.id` to `receipt-email-worker`.
- The deployed Worker has encrypted `EMAIL_WEBHOOK_SECRET` and `SUPABASE_EMAIL_RECEIPT_WEBHOOK_URL` bindings. Cloudflare does not reveal their values through the API. Historical delivery provides the final-path evidence: two email receipts and 15 PDF receipts were staged for the confirmed owner and private Telegram chat, with no delivery to another chat; all are resolved.

## Findings and prepared changes

Original line numbers below refer to the downloaded deployment/original Git HEAD, not the edited working file. Links point to the corresponding local fixes.

| Finding in deployed source | Local preparation |
| --- | --- |
| Telegram lines 68–78 and receipt lines 61–75 use unrestricted `ilike(name).maybeSingle()`, ignore lookup errors, and insert categories without owners. PDF lines 347–358 use unrestricted name lookup with `limit=1`. | [Category resolver](/Users/22070064/Documents/Tilaka/supabase/database/20260915_backend_compatibility.sql:6), [receipt caller](/Users/22070064/Documents/Tilaka/supabase/functions/receipt-email-worker/index.ts:61), and [PDF caller](/Users/22070064/Documents/Tilaka/supabase/scripts/import-jenius-pdf.mjs:363) use a service-only SQL function. |
| `/register` checks whether a supplied Supabase UUID exists, then links or replaces the Telegram mapping without proof of account ownership (Telegram lines 124–172 and 1359–1395). | [Handler](/Users/22070064/Documents/Tilaka/supabase/functions/telegram-webhook/index.ts:849) disables UUID-based registration. Existing active mappings must be independently verified before deployment. Frontend registration remains unchanged and creates no Telegram profile. |
| Unlinked users can reach reports without an owner filter; direct transaction writes allow NULL owners (Telegram lines 311–324, 666–681, 773–791). | [Transactions](/Users/22070064/Documents/Tilaka/supabase/functions/telegram-webhook/index.ts:248) require mapped ownership; [reports](/Users/22070064/Documents/Tilaka/supabase/functions/telegram-webhook/index.ts:461) reject missing ownership. Financial operations require private chats to avoid disclosing records in a shared chat. |
| Staging confirmation/rejection fetches by ID without checking the sender's ownership. Bulk commands fall back to all pending rows when the user's queue is empty (Telegram lines 344–464 and 1064–1188). | [Atomic staging function](/Users/22070064/Documents/Tilaka/supabase/database/20260915_backend_compatibility.sql:40) resolves the active sender mapping, locks only that owner's staging row, validates its category, and atomically saves the transaction and status. Both callback and reply paths use it. Bulk fallback is removed. |
| Confirmation claims a row before transaction creation in separate requests; a crash can strand it as confirmed. Direct messages have no durable deduplication. | Staged retries return the saved transaction ID. [Direct-message function](/Users/22070064/Documents/Tilaka/supabase/database/20260915_backend_compatibility.sql:121) serializes by Telegram update ID and saves that ID in a service-only deduplication table. Edited messages are ignored so an edit cannot create another transaction. |
| Service-role requests bypass the new browser category policies. | [Owner-check triggers](/Users/22070064/Documents/Tilaka/supabase/database/20260915_backend_compatibility.sql:96) reject transaction/budget references to another user's private category, including service-role writes. |
| Email owner can be NULL; PDF duplicate detection crosses users. | Email/PDF require a configured owner with an active Telegram mapping; duplicate lookup is scoped to that owner. Accounts remain shared and account upserts still target their unchanged global name constraint. |
| Raw exception text can escape through webhook responses/logging. `/repair_webhook` lets a chat command mutate global bot configuration. | Webhook HTTP failures are generic, Telegram error replies redact configured credentials, raw backend exceptions are removed from logs, and runtime webhook repair is removed. Configure the webhook during deployment. |

### Category behavior

Resolution checks the owner's private categories first, then shared defaults. Within each scope an exact name wins; a single case-insensitive match is accepted. Multiple case variants without an exact match fail explicitly. `%` and `_` are literal characters, never lookup wildcards. A private category matching a default's name wins for its owner only. A missing name creates a private category with explicit `user_id`; no runtime path creates shared defaults.

The SQL resolver uses `ON CONFLICT (user_id, name) WHERE user_id IS NOT NULL` and serializes backend requests for the same owner/case-folded name. It does not attempt to target partial indexes through REST `onConflict` columns. See [PostgreSQL INSERT](https://www.postgresql.org/docs/18/sql-insert.html).

The new `telegram_processed_updates` table is inaccessible to browser roles; editable transaction metadata is not trusted as the deduplication ledger.

The functions are invoker functions with browser/PUBLIC execution revoked and service-role execution granted. They validate owners through active `telegram_users.supabase_user_id` mappings: live `service_role` cannot SELECT `auth.users`. Their search path includes `public` because the existing invoker type-alignment trigger declares an unqualified `cat_allowed_type`.

### Other dependencies inspected

- [Cloudflare Worker](/Users/22070064/Documents/Tilaka/cloudflare/receipt-email-worker/src/index.ts) classifies receipt facts into names and forwards them with an email webhook secret. It has no database client, category-ID cache, or name-to-ID map. Backend resolution now scopes those names to the configured owner. Its README endpoint was corrected to the deployed `receipt-email-worker` slug.
- The historical category seed migration still contains `ON CONFLICT (name) DO NOTHING`. Do not replay it after the browser migration. A future shared-default seed must explicitly insert NULL owners and target `ON CONFLICT (name) WHERE user_id IS NULL`. The accounts seed remains compatible.
- The staging cleanup job deletes completed/rejected rows older than 30 days; it has no category-name dependency. No additional category cache, shared database helper, or backend budget-creation handler was found in these repositories. Backend budgets are read for alerts; budget creation was exercised through SQL/browser roles.
- The frontend example uses old Telegram RPCs and does not describe production. No production handler calls those RPCs. It was not promoted into production code.

## Verification

Run from the `supabase` repository:

```sh
python3 database/tests/run.py
node --test database/tests/handlers.test.cjs
node --check scripts/import-jenius-pdf.mjs
```

- Disposable PostgreSQL checks passed: two owners with identically named categories; shared defaults; private/default name collision; literal wildcard names; ambiguous spelling rejection; transaction and budget creation; cross-user category rejection; foreign/inactive sender rejection; confirmation/rejection retries; and rollback on the audited production type trigger's failure.
- Browser transaction and budget insertion using shared defaults passed alongside the new backend triggers.
- **36 concurrent database requests passed**: 12 for category creation, 12 for staged confirmation, and 12 for direct transaction insertion. Each group returned one ID; both transaction groups created one row each.
- **11 mocked source tests passed**, covering webhook authentication/method checks, disabled registration, missing mappings, private-chat enforcement, scoped reports/bulk operations, callback/reply sender propagation, direct update IDs, email ownership, and PDF duplicate scope.
- Local TypeScript checks of both handlers with external runtime imports stubbed: zero diagnostics. Importer syntax and Git whitespace checks passed. This is not a Deno deployment/bundle validation.
- No real Telegram messages were sent. Production access was limited to source download, metadata/aggregate queries, webhook metadata, and a zero-row credential check. No application tables, migrations, functions, keys, or deployments were changed live.

## Remaining rollout dependencies and limits

1. Independently verify existing Telegram-to-Supabase links. The previous UUID registration command makes `is_active=true` insufficient evidence of a legitimate link. Establish an authenticated one-time linking flow or an administrator verification process; do not restore UUID-only registration.
2. Confirm email/PDF `DEFAULT_SUPABASE_USER_ID` has the intended active mapping, and confirmation messages go to that user's **private** bot chat. The live Cloudflare secret values, receipt destination, and routing configuration were not exported. In particular, verify the configured URL uses `/functions/v1/receipt-email-worker`, not the stale README slug.
3. Review/backup the database and coordinate an ingestion pause. Apply the prepared browser migration, then **this repository's `database/20260915_backend_compatibility.sql`**, then deploy both edited functions and the frontend in one controlled window. The backend SQL is deliberately outside automatic historical migrations. Do not blindly run `supabase db push`, replay old setup/seed SQL, or deploy these callers before their RPCs exist.
4. Rotate/revoke the exposed credential and update server consumers. Removing the browser environment variable does not invalidate it. Verify the old credential is rejected and inspect the deployed frontend bundle.
5. Reconcile any old confirmed staging rows lacking a saved transaction ID if encountered. The new retry path refuses to guess whether an old confirmation created a transaction. Unowned rows are rejected rather than assigned a fallback owner.
6. Receipt **ingestion** remains best effort: duplicate email delivery and concurrent PDF imports can create separate staging rows. Atomic confirmation prevents duplicate saves of one staging ID, but does not merge independently staged copies. Email message IDs are available from Cloudflare but are not yet used as durable ingestion keys. Email/PDF notification delivery also has no durable outbox. These existing delivery limitations are separate from category compatibility and should be addressed before promising exactly-once ingestion.
7. Deno remote imports remain unpinned; local tests stub network libraries. Validate deployment packaging and the actual REST/RPC transport in a non-production environment. OCR's in-memory pending map and missing photo ingestion in the audited source were not redesigned. Telegram operations assume the one audited bot; a second bot would need a bot-specific deduplication namespace.

Webhook secret authentication remains in place, matching Telegram's documented [secret-token header](https://core.telegram.org/bots/api#setwebhook). Gateway `verify_jwt=false` is compatible with this dedicated authentication; it does not remove the requirement to validate the sender mapping and enforce ownership before service-role operations.

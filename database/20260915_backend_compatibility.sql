-- Apply only after supabase-registration/database/migrations/20260915_browser_rls.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.backend_resolve_category(p_user_id uuid, p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  category_id uuid;
  matches uuid[];
  owner_scope uuid;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.telegram_users WHERE supabase_user_id = p_user_id AND is_active = true) THEN
    RAISE EXCEPTION 'Valid category owner required';
  END IF;
  p_name := btrim(p_name);
  IF p_name IS NULL OR p_name = '' THEN RAISE EXCEPTION 'Category name required'; END IF;
  -- Serialize backend spelling variants; browser uniqueness remains case-sensitive.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || lower(p_name), 0));
  FOREACH owner_scope IN ARRAY ARRAY[p_user_id, NULL::uuid] LOOP
    SELECT id INTO category_id FROM public.categories
      WHERE user_id IS NOT DISTINCT FROM owner_scope AND name = p_name;
    IF FOUND THEN RETURN category_id; END IF;
    SELECT array_agg(id) INTO matches FROM public.categories
      WHERE user_id IS NOT DISTINCT FROM owner_scope AND lower(name) = lower(p_name);
    IF cardinality(matches) > 1 THEN RAISE EXCEPTION 'Ambiguous category spelling; use exact name'; END IF;
    IF cardinality(matches) = 1 THEN RETURN matches[1]; END IF;
  END LOOP;
  INSERT INTO public.categories (name, allowed_type, user_id)
    VALUES (p_name, 'both', p_user_id)
    ON CONFLICT (user_id, name) WHERE user_id IS NOT NULL
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO category_id;
  RETURN category_id;
END;
$$;
REVOKE ALL ON FUNCTION public.backend_resolve_category(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backend_resolve_category(uuid, text) TO service_role;

CREATE FUNCTION public.backend_process_staged_transaction(p_staging_id uuid, p_telegram_user_id bigint, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  owner_id uuid;
  staged public.transaction_staging%ROWTYPE;
  txn public.transactions%ROWTYPE;
  category_owner uuid;
BEGIN
  IF p_action NOT IN ('confirm', 'reject') OR p_action IS NULL THEN RAISE EXCEPTION 'Invalid action'; END IF;
  SELECT supabase_user_id INTO owner_id FROM public.telegram_users
    WHERE telegram_user_id = p_telegram_user_id AND is_active = true FOR SHARE;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Active Telegram link required'; END IF;
  SELECT * INTO staged FROM public.transaction_staging
    WHERE id = p_staging_id AND user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction unavailable'; END IF;
  IF staged.status = 'confirmed' AND p_action = 'confirm' THEN
    SELECT * INTO txn FROM public.transactions
      WHERE id = (staged.metadata->>'transaction_id')::uuid AND user_id = owner_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Previously confirmed row requires reconciliation'; END IF;
    RETURN jsonb_build_object('stagingData', to_jsonb(staged), 'txn', to_jsonb(txn));
  END IF;
  IF staged.status = 'rejected' AND p_action = 'reject' THEN
    RETURN jsonb_build_object('stagingData', to_jsonb(staged));
  END IF;
  IF staged.status <> 'pending' THEN RAISE EXCEPTION 'Already processed'; END IF;
  IF p_action = 'reject' THEN
    UPDATE public.transaction_staging SET status = 'rejected', rejected_at = now() WHERE id = staged.id;
    RETURN jsonb_build_object('stagingData', to_jsonb(staged));
  END IF;
  IF staged.category_id IS NULL THEN
    staged.category_id := public.backend_resolve_category(owner_id, 'Uncategorized');
  END IF;
  SELECT user_id INTO category_owner FROM public.categories WHERE id = staged.category_id FOR SHARE;
  IF NOT FOUND OR (category_owner IS NOT NULL AND category_owner <> owner_id) THEN
    RAISE EXCEPTION 'Category unavailable';
  END IF;
  IF staged.account_id IS NULL THEN
    INSERT INTO public.accounts (name) VALUES ('Bank')
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id INTO staged.account_id;
  END IF;
  -- Populate against the actual transaction enum/column types.
  SELECT * INTO txn FROM jsonb_populate_record(NULL::public.transactions,
    jsonb_build_object('type', staged.type, 'currency', staged.currency));
  INSERT INTO public.transactions (amount, description, occurred_at, type, category_id, account_id, user_id, currency)
    VALUES (staged.amount, staged.description, staged.occurred_at, txn.type,
      staged.category_id, staged.account_id, owner_id, txn.currency) RETURNING * INTO txn;
  UPDATE public.transaction_staging SET status = 'confirmed', confirmed_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('transaction_id', txn.id)
    WHERE id = staged.id;
  RETURN jsonb_build_object('stagingData', to_jsonb(staged), 'txn', to_jsonb(txn));
END;
$$;
REVOKE ALL ON FUNCTION public.backend_process_staged_transaction(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backend_process_staged_transaction(uuid, bigint, text) TO service_role;

-- Service-role writes bypass browser policies, including category visibility.
CREATE FUNCTION public.backend_check_category_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE category_owner uuid;
BEGIN
  SELECT user_id INTO category_owner FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND OR NEW.user_id IS NULL OR (category_owner IS NOT NULL AND category_owner <> NEW.user_id) THEN
    RAISE EXCEPTION 'Category unavailable for transaction or budget owner';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.backend_check_category_owner() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER backend_transaction_category_owner BEFORE INSERT OR UPDATE OF category_id, user_id
  ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.backend_check_category_owner();
CREATE TRIGGER backend_budget_category_owner BEFORE INSERT OR UPDATE OF category_id, user_id
  ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.backend_check_category_owner();

CREATE TABLE public.telegram_processed_updates (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL
);
ALTER TABLE public.telegram_processed_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_processed_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.telegram_processed_updates TO service_role;
CREATE FUNCTION public.backend_save_telegram_transaction(p_user_id uuid, p_update_id bigint, p_transaction jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  txn public.transactions%ROWTYPE;
  category_id uuid;
  account_id uuid;
  transaction_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_update_id IS NULL OR p_update_id < 0 THEN RAISE EXCEPTION 'Owner and update required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('telegram-update:' || p_update_id::text, 0));
  SELECT u.transaction_id INTO transaction_id FROM public.telegram_processed_updates u
    WHERE u.update_id = p_update_id AND u.user_id = p_user_id;
  IF FOUND THEN
    IF transaction_id IS NULL THEN RAISE EXCEPTION 'Previously processed transaction was deleted'; END IF;
    RETURN transaction_id;
  END IF;
  category_id := public.backend_resolve_category(p_user_id, p_transaction->>'categoryName');
  IF nullif(btrim(p_transaction->>'accountName'), '') IS NULL THEN RAISE EXCEPTION 'Account required'; END IF;
  INSERT INTO public.accounts (name) VALUES (btrim(p_transaction->>'accountName'))
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id INTO account_id;
  SELECT * INTO txn FROM jsonb_populate_record(NULL::public.transactions, p_transaction);
  INSERT INTO public.transactions (user_id, category_id, account_id, type, amount, occurred_at, description, currency, metadata)
    VALUES (p_user_id, category_id, account_id, txn.type, txn.amount, txn.occurred_at, txn.description, 'IDR',
      jsonb_build_object('telegram_update_id', p_update_id::text)) RETURNING id INTO transaction_id;
  INSERT INTO public.telegram_processed_updates (update_id, user_id, transaction_id)
    VALUES (p_update_id, p_user_id, transaction_id);
  RETURN transaction_id;
END;
$$;
REVOKE ALL ON FUNCTION public.backend_save_telegram_transaction(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backend_save_telegram_transaction(uuid, bigint, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

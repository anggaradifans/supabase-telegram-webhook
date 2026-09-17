-- Apply after 20260915_backend_compatibility.sql, before deploying the revised handlers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.backend_revise_staged_transaction(
  p_staging_id uuid, p_telegram_user_id bigint, p_action text,
  p_choice_id uuid DEFAULT NULL, p_page integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  owner_id uuid;
  staged public.transaction_staging%ROWTYPE;
  choices jsonb := '[]'::jsonb;
  category_name text;
  account_name text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('view', 'categories', 'accounts', 'category', 'account') THEN
    RAISE EXCEPTION 'Invalid revision action';
  END IF;
  IF p_page IS NULL OR p_page < 0 OR p_page > 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT supabase_user_id INTO owner_id FROM public.telegram_users
    WHERE telegram_user_id = p_telegram_user_id AND is_active = true FOR SHARE;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Active Telegram link required'; END IF;
  -- Use the same row lock as confirmation so an edit cannot change a saved receipt.
  SELECT * INTO staged FROM public.transaction_staging
    WHERE id = p_staging_id AND user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction unavailable'; END IF;
  IF staged.status <> 'pending' THEN RAISE EXCEPTION 'Already processed'; END IF;

  IF p_action = 'category' THEN
    PERFORM 1 FROM public.categories WHERE id = p_choice_id
      AND (user_id IS NULL OR user_id = owner_id)
      AND allowed_type::text IN ('both', staged.type) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Category unavailable for this transaction'; END IF;
    UPDATE public.transaction_staging SET category_id = p_choice_id
      WHERE id = staged.id RETURNING * INTO staged;
  ELSIF p_action = 'account' THEN
    -- Accounts are shared in the existing application schema.
    PERFORM 1 FROM public.accounts WHERE id = p_choice_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable'; END IF;
    UPDATE public.transaction_staging SET account_id = p_choice_id
      WHERE id = staged.id RETURNING * INTO staged;
  ELSIF p_action = 'categories' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.name, c.id), '[]'::jsonb) INTO choices
    FROM (SELECT id, name FROM public.categories
      WHERE (user_id IS NULL OR user_id = owner_id) AND allowed_type::text IN ('both', staged.type)
      ORDER BY name, id LIMIT 9 OFFSET p_page * 8) c;
  ELSIF p_action = 'accounts' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.name, a.id), '[]'::jsonb) INTO choices
    FROM (SELECT id, name FROM public.accounts ORDER BY name, id LIMIT 9 OFFSET p_page * 8) a;
  END IF;
  SELECT name INTO category_name FROM public.categories WHERE id = staged.category_id
    AND (user_id IS NULL OR user_id = owner_id);
  SELECT name INTO account_name FROM public.accounts WHERE id = staged.account_id;
  RETURN jsonb_build_object('stagingData', to_jsonb(staged), 'categoryName', category_name,
    'accountName', account_name, 'choices', choices, 'page', p_page);
END;
$$;
REVOKE ALL ON FUNCTION public.backend_revise_staged_transaction(uuid, bigint, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backend_revise_staged_transaction(uuid, bigint, text, uuid, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

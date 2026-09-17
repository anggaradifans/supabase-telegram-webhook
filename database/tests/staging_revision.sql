CREATE FUNCTION pg_temp.check_revision(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END; $$;
SET ROLE service_role;
DO $$
DECLARE
  owner_id uuid := '00000000-0000-0000-0000-000000000001';
  staging_id uuid := '30000000-0000-0000-0000-000000000017';
  category_id uuid;
  foreign_id uuid;
  income_id uuid;
  account_id uuid;
  result jsonb;
  action text;
BEGIN
  category_id := public.backend_resolve_category(owner_id, 'Revised Food');
  foreign_id := public.backend_resolve_category('00000000-0000-0000-0000-000000000002', 'Hidden Food');
  INSERT INTO public.categories(name,user_id,allowed_type) VALUES('Revision income only',owner_id,'income') RETURNING id INTO income_id;
  SELECT id INTO account_id FROM public.accounts ORDER BY name LIMIT 1;
  INSERT INTO public.transaction_staging(id,user_id,type,amount,occurred_at,description)
    VALUES(staging_id,owner_id,'outcome',111,now(),'Keep description');
  FOREACH action IN ARRAY ARRAY['view','categories','accounts','category','account'] LOOP
    BEGIN
      PERFORM public.backend_revise_staged_transaction(staging_id,202,action,category_id);
      RAISE EXCEPTION 'missed foreign owner';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed foreign owner' THEN RAISE; END IF; END;
  END LOOP;
  FOR result IN SELECT public.backend_revise_staged_transaction(staging_id,101,'categories',NULL,p) FROM generate_series(0,10) p LOOP
    PERFORM pg_temp.check_revision(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result->'choices') c WHERE (c->>'id')::uuid IN (foreign_id,income_id)), 'only visible, compatible categories listed');
    PERFORM pg_temp.check_revision(jsonb_array_length(result->'choices') <= 9, 'page bounded');
  END LOOP;
  BEGIN PERFORM public.backend_revise_staged_transaction(staging_id,101,'category',foreign_id); RAISE EXCEPTION 'missed foreign category';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed foreign category' THEN RAISE; END IF; END;
  BEGIN PERFORM public.backend_revise_staged_transaction(staging_id,101,'category',income_id); RAISE EXCEPTION 'missed incompatible category';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed incompatible category' THEN RAISE; END IF; END;
  BEGIN PERFORM public.backend_revise_staged_transaction(staging_id,101,'account',gen_random_uuid()); RAISE EXCEPTION 'missed deleted account';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed deleted account' THEN RAISE; END IF; END;
  UPDATE public.telegram_users SET is_active=false WHERE telegram_user_id=101;
  BEGIN PERFORM public.backend_revise_staged_transaction(staging_id,101,'view'); RAISE EXCEPTION 'missed inactive sender';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed inactive sender' THEN RAISE; END IF; END;
  UPDATE public.telegram_users SET is_active=true WHERE telegram_user_id=101;
  PERFORM public.backend_revise_staged_transaction(staging_id,101,'category',category_id);
  result := public.backend_revise_staged_transaction(staging_id,101,'account',account_id);
  PERFORM pg_temp.check_revision(result->>'categoryName'='Revised Food', 'review returns revised category');
  PERFORM pg_temp.check_revision((result->'stagingData'->>'account_id')::uuid=account_id, 'review returns revised account');
  PERFORM pg_temp.check_revision(result->'stagingData'->>'status'='pending', 'edit leaves receipt pending');
  result := public.backend_process_staged_transaction(staging_id,101,'confirm');
  PERFORM pg_temp.check_revision((result->'txn'->>'category_id')::uuid=category_id AND (result->'txn'->>'account_id')::uuid=account_id, 'confirmation saves revised values');
  PERFORM pg_temp.check_revision(result->'txn'->>'description'='Keep description' AND (result->'txn'->>'amount')::numeric=111, 'revision preserves other fields');
  BEGIN PERFORM public.backend_revise_staged_transaction(staging_id,101,'category',category_id); RAISE EXCEPTION 'missed confirmed status';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed confirmed status' THEN RAISE; END IF; END;
  INSERT INTO public.transaction_staging(id,user_id,type,amount,occurred_at)
    VALUES('30000000-0000-0000-0000-000000000018',owner_id,'outcome',112,now());
  PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000018',101,'reject');
  BEGIN PERFORM public.backend_revise_staged_transaction('30000000-0000-0000-0000-000000000018',101,'account',account_id); RAISE EXCEPTION 'missed rejected status';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed rejected status' THEN RAISE; END IF; END;
END;
$$;
RESET ROLE;
SELECT pg_temp.check_revision(NOT has_function_privilege('anon','public.backend_revise_staged_transaction(uuid,bigint,text,uuid,integer)','EXECUTE'), 'anon cannot revise');
SELECT pg_temp.check_revision(NOT has_function_privilege('authenticated','public.backend_revise_staged_transaction(uuid,bigint,text,uuid,integer)','EXECUTE'), 'browser cannot forge sender');
SELECT 'Staging revision checks passed';

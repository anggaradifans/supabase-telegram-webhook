CREATE FUNCTION pg_temp.check_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END; $$;
SET ROLE service_role;
DO $$
DECLARE
 a uuid := '00000000-0000-0000-0000-000000000001';
 b uuid := '00000000-0000-0000-0000-000000000002';
 ca uuid; cb uuid; shared uuid; shadow uuid; tid uuid; result jsonb; repeated jsonb;
BEGIN
 ca := public.backend_resolve_category(a, 'Same');
 cb := public.backend_resolve_category(b, 'Same');
 PERFORM pg_temp.check_ok(ca <> cb, 'same-name private categories differ');
 PERFORM pg_temp.check_ok(public.backend_resolve_category(a, 'same') = ca, 'case insensitive own lookup');
 shared := public.backend_resolve_category(a, 'Default 1');
 PERFORM pg_temp.check_ok(shared = public.backend_resolve_category(b, 'Default 1'), 'shared default');
 INSERT INTO public.categories(name,user_id) VALUES ('Default 1',a) RETURNING id INTO shadow;
 PERFORM pg_temp.check_ok(public.backend_resolve_category(a,'default 1') = shadow, 'private takes precedence');
 PERFORM pg_temp.check_ok(public.backend_resolve_category(b,'Default 1') = shared, 'other user cannot see shadow');
 PERFORM pg_temp.check_ok(public.backend_resolve_category(a,'100%_literal') <> ca, 'wildcards are literal');
 INSERT INTO public.categories(name,user_id) VALUES ('CASE',a),('case',a);
 BEGIN PERFORM public.backend_resolve_category(a,'Case'); RAISE EXCEPTION 'missed ambiguous name';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed ambiguous name' THEN RAISE; END IF; END;
 PERFORM public.backend_resolve_category(a,'CASE');
 BEGIN PERFORM public.backend_resolve_category(NULL,'Missing'); RAISE EXCEPTION 'missed null owner';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed null owner' THEN RAISE; END IF; END;
 tid := public.backend_save_telegram_transaction(a, 42, '{"categoryName":"Same","accountName":"Account 1","type":"outcome","amount":25,"occurred_at":"2026-09-15T00:00:00Z"}');
 PERFORM pg_temp.check_ok(tid = public.backend_save_telegram_transaction(a,42,'{}'), 'direct transaction retry');
 PERFORM pg_temp.check_ok((SELECT user_id=a AND category_id=ca FROM public.transactions WHERE id=tid), 'transaction ownership');
 INSERT INTO public.budgets(user_id,category_id,amount,period,start_date) VALUES(a,ca,100,'weekly',now());
 BEGIN
  INSERT INTO public.budgets(user_id,category_id,amount,period,start_date) VALUES(a,cb,100,'weekly',now());
  RAISE EXCEPTION 'missed private budget category';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed private budget category' THEN RAISE; END IF; END;
 BEGIN
  INSERT INTO public.transactions(user_id,category_id,type,amount,occurred_at) VALUES(a,cb,'outcome',10,now());
  RAISE EXCEPTION 'missed private transaction category';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed private transaction category' THEN RAISE; END IF; END;
 INSERT INTO public.transaction_staging(id,user_id,category_id,type,amount,occurred_at)
 VALUES('30000000-0000-0000-0000-000000000001',a,ca,'outcome',123,now());
 BEGIN PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000001',202,'confirm'); RAISE EXCEPTION 'missed foreign staging';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed foreign staging' THEN RAISE; END IF; END;
 BEGIN PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000001',202,'reject'); RAISE EXCEPTION 'missed foreign rejection';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed foreign rejection' THEN RAISE; END IF; END;
 result := public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000001',101,'confirm');
 repeated := public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000001',101,'confirm');
 PERFORM pg_temp.check_ok(result->'txn'->>'id' = repeated->'txn'->>'id', 'staging retry');
 INSERT INTO public.transaction_staging(id,user_id,category_id,type,amount,occurred_at)
 VALUES('30000000-0000-0000-0000-000000000002',a,cb,'outcome',124,now());
 BEGIN PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000002',101,'confirm'); RAISE EXCEPTION 'missed foreign staged category';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed foreign staged category' THEN RAISE; END IF; END;
 PERFORM pg_temp.check_ok((SELECT status='pending' FROM public.transaction_staging WHERE id='30000000-0000-0000-0000-000000000002'), 'failed confirmation stays pending');
 PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000002',101,'reject');
 PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000002',101,'reject');
 INSERT INTO public.categories(name,user_id,allowed_type) VALUES('Income only',a,'income') RETURNING id INTO ca;
 INSERT INTO public.transaction_staging(id,user_id,category_id,type,amount,occurred_at)
 VALUES('30000000-0000-0000-0000-000000000003',a,ca,'outcome',124,now());
 BEGIN PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000003',101,'confirm'); RAISE EXCEPTION 'missed type mismatch';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed type mismatch' THEN RAISE; END IF; END;
 PERFORM pg_temp.check_ok((SELECT status='pending' FROM public.transaction_staging WHERE id='30000000-0000-0000-0000-000000000003'), 'production trigger failure rolls back claim');
 UPDATE public.telegram_users SET is_active=false WHERE telegram_user_id=101;
 BEGIN PERFORM public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000003',101,'reject'); RAISE EXCEPTION 'missed inactive sender';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'missed inactive sender' THEN RAISE; END IF; END;
 UPDATE public.telegram_users SET is_active=true WHERE telegram_user_id=101;
END;
$$;
RESET ROLE;
SELECT pg_temp.check_ok(NOT has_function_privilege('anon','public.backend_resolve_category(uuid,text)','EXECUTE'), 'anon RPC denied');
SELECT pg_temp.check_ok(NOT has_function_privilege('authenticated','public.backend_save_telegram_transaction(uuid,bigint,jsonb)','EXECUTE'), 'browser write RPC denied');
SELECT pg_temp.check_ok(NOT has_function_privilege('authenticated','public.backend_process_staged_transaction(uuid,bigint,text)','EXECUTE'), 'browser staging RPC denied');
SELECT pg_temp.check_ok((SELECT count(*)=8 FROM public.accounts WHERE name LIKE 'Account %'), 'existing shared accounts preserved');
INSERT INTO public.transaction_staging(id,user_id,type,amount,occurred_at)
 VALUES('30000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','outcome',777,now());
SELECT 'Sequential compatibility checks passed';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
INSERT INTO public.transactions(user_id,category_id,type,amount,occurred_at)
 VALUES('00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','outcome',10,now());
INSERT INTO public.budgets(user_id,category_id,amount,period,start_date)
 VALUES('00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',10,'daily',now());
RESET ROLE;
SELECT 'Browser shared-category transaction and budget inserts passed';

SELECT pg_temp.check_ok(NOT has_table_privilege('authenticated','public.telegram_processed_updates','INSERT'), 'browser cannot forge processed update IDs');
SELECT pg_temp.check_ok(NOT has_table_privilege('anon','public.telegram_processed_updates','SELECT'), 'anonymous cannot read processed updates');

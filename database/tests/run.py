#!/usr/bin/env python3
import concurrent.futures
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
frontend = root.parent / 'supabase-registration'
cluster = Path(tempfile.mkdtemp(prefix='telegram-compat-'))
def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout
psql = ['psql', '-X', '-h', str(cluster), '-p', '55440', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq']
started = False
try:
    run(['initdb', '-D', str(cluster/'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    run(['pg_ctl', '-D', str(cluster/'data'), '-l', str(cluster/'server.log'), '-o', f"-k {cluster} -p 55440 -c listen_addresses=''", 'start'])
    started = True
    for file in [frontend/'database/tests/fixture.sql', root/'database/tests/setup.sql', frontend/'database/migrations/20260915_browser_rls.sql', root/'database/20260915_backend_compatibility.sql', root/'database/20260917_staging_revision.sql', root/'database/tests/compatibility.sql', root/'database/tests/staging_revision.sql']:
        print(run(psql+['-f',str(file)]).strip())
    statements = [
      "SELECT public.backend_resolve_category('00000000-0000-0000-0000-000000000001','Concurrent');",
      "SELECT public.backend_process_staged_transaction('30000000-0000-0000-0000-000000000004',101,'confirm')->'txn'->>'id';",
      "SELECT public.backend_save_telegram_transaction('00000000-0000-0000-0000-000000000001',99,'{\"categoryName\":\"Concurrent\",\"accountName\":\"Account 1\",\"type\":\"outcome\",\"amount\":5,\"occurred_at\":\"2026-09-15T00:00:00Z\"}');"
    ]
    for sql in statements:
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: run(psql+['-c','SET ROLE service_role; '+sql]).strip(), range(12)))
        assert len(set(results)) == 1, results
    assert run(psql+['-c',"SELECT count(*) FROM public.transactions WHERE metadata->>'telegram_update_id'='99'"]).strip() == '1'
    assert run(psql+['-c',"SELECT count(*) FROM public.transactions WHERE amount=777"]).strip() == '1'
    print('PASS: 36 concurrent requests; one category and one transaction per operation.')
    race_id = '30000000-0000-0000-0000-000000000019'
    run(psql+['-c', f"INSERT INTO public.transaction_staging(id,user_id,type,amount,occurred_at,account_id) VALUES('{race_id}','00000000-0000-0000-0000-000000000001','outcome',119,now(),(SELECT id FROM public.accounts ORDER BY name LIMIT 1 OFFSET 1));"])
    edit = f"SELECT public.backend_revise_staged_transaction('{race_id}',101,'account',(SELECT id FROM public.accounts ORDER BY name LIMIT 1));"
    confirm = f"SELECT public.backend_process_staged_transaction('{race_id}',101,'confirm');"
    def race(sql):
        try:
            run(psql+['-c', 'SET ROLE service_role; '+sql])
            return 'ok'
        except subprocess.CalledProcessError as error:
            if sql == edit and 'Already processed' in error.stderr:
                return 'processed'
            raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(race, [edit, confirm] * 6))
    assert 'ok' in outcomes
    assert run(psql+['-c', f"SELECT s.status='confirmed' AND s.account_id IS NOT DISTINCT FROM t.account_id FROM public.transaction_staging s JOIN public.transactions t ON t.id=(s.metadata->>'transaction_id')::uuid WHERE s.id='{race_id}'"]).strip() == 't'
    assert run(psql+['-c', "SELECT count(*) FROM public.transactions WHERE amount=119"]).strip() == '1'
    print('PASS: 12 competing edit/confirm requests; saved account matches staging and only one transaction exists.')
except subprocess.CalledProcessError as e:
    print(e.stdout, e.stderr)
    raise
finally:
    if started: run(['pg_ctl','-D',str(cluster/'data'),'-m','fast','stop'])
    print('Local logs:',cluster)

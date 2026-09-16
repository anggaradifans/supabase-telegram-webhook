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
    for file in [frontend/'database/tests/fixture.sql', root/'database/tests/setup.sql', frontend/'database/migrations/20260915_browser_rls.sql', root/'database/20260915_backend_compatibility.sql', root/'database/tests/compatibility.sql']:
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
except subprocess.CalledProcessError as e:
    print(e.stdout, e.stderr)
    raise
finally:
    if started: run(['pg_ctl','-D',str(cluster/'data'),'-m','fast','stop'])
    print('Local logs:',cluster)

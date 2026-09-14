create extension if not exists pg_cron with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cleanup_transaction_staging_30d';

select cron.schedule(
  'cleanup_transaction_staging_30d',
  '15 3 * * *',
  $$
  delete from public.transaction_staging
  where status in ('confirmed', 'rejected')
    and coalesce(confirmed_at, rejected_at, created_at) < now() - interval '30 days';
  $$
);

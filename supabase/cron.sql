-- =====================================================================
-- Месечен график: на 1-во число в 01:00 UTC (03:00 зимно / 04:00 лятно време София)
-- Преди това: Database → Extensions → включи pg_cron и pg_net
-- Замени двете стойности в <...> и пусни в SQL Editor.
-- =====================================================================

-- Тайните се пазят във Vault, а не в текста на задачата
select vault.create_secret('https://<PROJECT-REF>.supabase.co', 'project_url');
select vault.create_secret('<същият CRON_SECRET като в Edge Function Secrets>', 'cron_secret');

select cron.schedule(
  'netfleet-monthly-snapshot',
  '0 1 1 * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/netfleet-snapshot',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Резервен опит в 07:00 UTC същия ден (презаписва със същите данни, безопасно е)
select cron.schedule(
  'netfleet-monthly-snapshot-retry',
  '0 7 1 * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/netfleet-snapshot',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Проверка:
-- select * from cron.job;
-- select * from cron.job_run_details order by start_time desc limit 10;
-- select * from public.fetch_log order by run_at desc limit 10;

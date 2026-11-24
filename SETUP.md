# Контрол на горивото: стъпка по стъпка

## Част А — Supabase (≈1 час)

### А1. Нов проект
supabase.com → **New project**
- Name: `fuel-control`
- Database password: генерирай и **запиши** в password manager
- Region: **Central EU (Frankfurt)**
- Изчакай 1–2 минути да се създаде.

### А2. База (SQL Editor → New query → постави → Run), по ред:
1. `supabase/migrations/20261120000001_fuel_schema.sql`
2. `supabase/migrations/20261120000002_lukoil_import.sql`
3. `supabase/migrations/20261124000003_allocation.sql`

Очаквано: „Success. No rows returned“. NOTICE съобщенията са нормални.

### А3. Реални данни
4. `supabase/seed/seed_01_razpredelenie_09_2026.sql` → `{"rows": 75, "new_vehicles": 75, ...}`
5. `supabase/seed/seed_02_lukoil_10_2026.sql` → `{"total": 223, "inserted": 223, "matched_rows": 146, ...}`

Проверка в **Table Editor**: `vehicles` 75 реда, `fuel_balances` 75, `refuels` 223.

### А4. Secrets
**Edge Functions → Secrets** (или Project Settings → Edge Functions):
- `NETFLEET_API_KEY` = ключът от Нетера
- `CRON_SECRET` = дълга произволна парола (40+ знака, от password manager)

### А5. Функция за Нетера
**Edge Functions → Deploy a new function → Via Editor**
- Име: `netfleet-snapshot` (точно така)
- Изтрий примерния код, постави `supabase/functions/netfleet-snapshot/index.ts` → **Deploy**
- В настройките на функцията изключи **Verify JWT with legacy secret / Enforce JWT verification** → Save

### А6. Тест с Нетера
В страницата на функцията → **Test**:
- Method `POST`
- Headers: `x-cron-secret` = твоя CRON_SECRET
- Body: `{"month": "2026-10"}`

След това в SQL Editor:
```sql
select * from fetch_log order by run_at desc;
select snap_date, count(*) from snapshots group by 1;
select * from v_monthly_fuel order by "Рег. номер";
```
Прати ми резултата, и при грешка.

### А7. График (след успешен тест)
**Database → Extensions** → включи `pg_cron` и `pg_net`.
SQL Editor → `supabase/cron.sql` → замени `<PROJECT-REF>` и `<CRON_SECRET>` → Run.
PROJECT-REF е частта от адреса: https://**abcdefgh**.supabase.co

## Част Б — проектна папка (≈30 мин)

### Б1. Папка и проект
```bash
cd C:\Projects            # или където държиш JD Telemetry
npm create vite@latest fuel-control -- --template react-ts
cd fuel-control
npm install
npm install @supabase/supabase-js xlsx
```

### Б2. Копирай от архива
- `supabase/` → в `fuel-control/supabase/`
- `src/lib/*.ts` → в `fuel-control/src/lib/`
- `templates/` → в `fuel-control/templates/`
- `SETUP.md` → в корена

### Б3. Ключове за приложението
Supabase → **Project Settings → API Keys** (или Data API): Project URL + **anon / publishable** ключ
(НЕ service_role / secret). Създай файл `fuel-control/.env.local`:
```
VITE_SUPABASE_URL=https://<PROJECT-REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon или publishable ключ>
```

### Б4. Git
```bash
git init
git add .
git commit -m "Начална структура"
```
Провери, че `.env.local` НЕ е в commit-а (Vite го слага в `.gitignore` по подразбиране: `*.local`).
После нов **private** репо в GitHub и `git push`.

### Б5. Потребители
Supabase → **Authentication → Users → Add user** → създай себе си (имейл + парола, „Auto Confirm“).
**Authentication → Sign In / Providers**: изключи „Allow new users to sign up“, за да няма външни регистрации.

## Част В — интерфейс
Следва: вход, машини, импорт Лукойл, поставяне от Excel, месечно разпределение, експорт.

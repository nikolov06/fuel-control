-- =====================================================================
-- Контрол на горивото: автомобили и камиони (Netfleet + Лукойл)
-- Пусни целия файл веднъж в Supabase → SQL Editor
-- =====================================================================

-- ---------- Помощни функции ----------
create or replace function public.normalize_plate(p text)
returns text language sql immutable as $$
  -- 'СВ 1234 АВ' / 'cb-1234-ab' -> 'CB1234AB' (кирилица към латиница, без интервали и тирета)
  select nullif(regexp_replace(translate(upper(coalesce(p, '')),
         'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[\s\-]', '', 'g'), '')
$$;

create or replace function public.fuel_liters(raw numeric, unit text, tank numeric)
returns numeric language sql immutable as $$
  -- Ниво от Нетера -> литри. При '%' се смята резервоар × % / 100.
  select case
    when raw is null then null
    when unit = '%' then case when tank > 0 then round(tank * raw / 100, 1) end
    else raw end
$$;

-- ---------- Таблици ----------
create table if not exists public.vehicles (
  plate            text primary key,
  name             text,
  tank_liters      numeric,
  fuel_level_unit  text not null default 'l' check (fuel_level_unit in ('l', '%')),
  fuel_type        text,
  norm_l_100km     numeric,
  lukoil_card      text,
  has_gps          boolean not null default true,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.snapshots (
  snap_date            date not null,
  plate                text not null references public.vehicles(plate) on update cascade,
  gps_odometer         numeric,
  can_odometer         numeric,
  gps_engine_hours     numeric,
  can_engine_hours     numeric,
  can_fuel_level       numeric,          -- сурово: литри или %, според vehicles.fuel_level_unit
  can_total_fuel_used  numeric,
  source               text not null default 'api' check (source in ('api', 'manual')),
  fetched_at           timestamptz not null default now(),
  raw                  jsonb,
  primary key (snap_date, plate)
);

create table if not exists public.refuels (
  id           bigint generated always as identity primary key,
  ts           timestamp not null,         -- местно време (София), както е във файла на Лукойл
  plate        text references public.vehicles(plate) on update cascade,
  card         text,
  fuel_type    text,
  liters       numeric not null,
  station      text,
  source_file  text,
  row_hash     text unique,                -- защита от двойно импортиране
  imported_at  timestamptz not null default now(),
  imported_by  uuid default auth.uid()
);
create index if not exists refuels_plate_ts on public.refuels (plate, ts);

create table if not exists public.fetch_log (
  id              bigint generated always as identity primary key,
  run_at          timestamptz not null default now(),
  snap_date       date,
  status          text,          -- ok / error
  vehicles_count  int,
  message         text,
  triggered_by    text           -- cron / user email
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists vehicles_touch on public.vehicles;
create trigger vehicles_touch before update on public.vehicles
  for each row execute function public.touch_updated_at();

-- ---------- Месечна сметка (за интерфейса и Power BI) ----------
create or replace view public.v_monthly_fuel
with (security_invoker = true) as
with month_ends as (
  select distinct snap_date as end_date
  from public.snapshots
  where snap_date = (date_trunc('month', snap_date) + interval '1 month - 1 day')::date
),
months as (
  select to_char(end_date, 'YYYY-MM') as ym,
         (date_trunc('month', end_date) - interval '1 day')::date as start_date,
         end_date
  from month_ends me
  -- само месеци, за които има и начална снимка (първият месец е само база)
  where exists (select 1 from public.snapshots x
                where x.snap_date = (date_trunc('month', me.end_date) - interval '1 day')::date)
),
base as (
  select m.ym, m.start_date, m.end_date, v.*,
         s.can_fuel_level as raw_s, e.can_fuel_level as raw_e,
         coalesce(nullif(s.can_odometer, 0), s.gps_odometer) as odo_s,
         coalesce(nullif(e.can_odometer, 0), e.gps_odometer) as odo_e,
         s.can_total_fuel_used as cfu_s, e.can_total_fuel_used as cfu_e,
         (s.plate is not null) as has_s, (e.plate is not null) as has_e,
         coalesce((select sum(r.liters) from public.refuels r
                   where r.plate = v.plate
                     and r.ts >  m.start_date + time '23:59:59'
                     and r.ts <= m.end_date   + time '23:59:59'
                     and coalesce(r.fuel_type, '') not ilike '%adblue%'), 0) as refueled
  from months m
  cross join public.vehicles v
  left join public.snapshots s on s.plate = v.plate and s.snap_date = m.start_date
  left join public.snapshots e on e.plate = v.plate and e.snap_date = m.end_date
  where v.active
),
calc as (
  select b.*,
         b.odo_e - b.odo_s as km,
         public.fuel_liters(b.raw_s, b.fuel_level_unit, b.tank_liters) as fuel_s,
         public.fuel_liters(b.raw_e, b.fuel_level_unit, b.tank_liters) as fuel_e,
         case when b.cfu_s > 0 and b.cfu_e > 0 then b.cfu_e - b.cfu_s end as can_used
  from base b
),
calc2 as (
  select c.*,
         c.fuel_s + c.refueled - c.fuel_e as used,
         case when c.km > 0 then round((c.fuel_s + c.refueled - c.fuel_e) / c.km * 100, 2) end as l_100km
  from calc c
)
select
  ym                       as "Месец",
  plate                    as "Рег. номер",
  name                     as "Име",
  tank_liters              as "Резервоар (л)",
  odo_s                    as "Одометър начало",
  odo_e                    as "Одометър край",
  km                       as "Км",
  fuel_s                   as "Гориво начало (л)",
  refueled                 as "Заредено (л)",
  fuel_e                   as "Гориво край (л)",
  round(used, 2)           as "Изразходвано (л)",
  l_100km                  as "л/100 км",
  norm_l_100km             as "Норма л/100км",
  case when l_100km is not null and norm_l_100km > 0
       then round((l_100km - norm_l_100km) / norm_l_100km * 100, 1) end as "Откл. от норма %",
  round(can_used, 2)       as "CAN разход (л)",
  array_to_string(array_remove(array[
    case when not has_s then 'няма начална снимка' end,
    case when not has_e then 'няма крайна снимка' end,
    case when has_s and has_e and raw_s is null then 'няма ниво на горивото (CAN)' end,
    case when fuel_level_unit = '%' and coalesce(tank_liters, 0) = 0
              and (raw_s is not null or raw_e is not null) then 'ниво в %, но няма въведен резервоар' end,
    case when fuel_level_unit = 'l' and tank_liters > 150 and raw_s between 0 and 100
              and raw_e between 0 and 100 then 'ниво ≤100 при голям резервоар — провери дали не е в %' end,
    case when km < 0 then 'отрицателен пробег' end,
    case when km > 25000 then 'нереален пробег' end,
    case when tank_liters > 0 and (fuel_s > tank_liters * 1.05 or fuel_e > tank_liters * 1.05)
         then 'ниво > резервоар' end,
    case when used < 0 then 'отрицателен разход' end,
    case when refueled > 0 and km = 0 then 'зареждане без пробег' end,
    case when l_100km is not null and norm_l_100km > 0
              and abs(l_100km - norm_l_100km) / norm_l_100km > 0.15
         then case when l_100km > norm_l_100km then 'над нормата' else 'под нормата' end end,
    case when used > 0 and can_used is not null and abs(can_used - used) / used > 0.10
         then 'CAN брояч ≠ баланс' end
  ], null), '; ')          as "Бележки",
  start_date               as "Начална дата",
  end_date                 as "Крайна дата"
from calc2;

-- ---------- Достъп (RLS) ----------
-- Всеки влязъл потребител вижда и редактира. Ролите (само четене/редакция) ще ги добавим после.
alter table public.vehicles  enable row level security;
alter table public.snapshots enable row level security;
alter table public.refuels   enable row level security;
alter table public.fetch_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['vehicles', 'snapshots', 'refuels'] loop
    execute format('drop policy if exists "auth_all" on public.%I', t);
    execute format('create policy "auth_all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
  drop policy if exists "auth_read" on public.fetch_log;
  create policy "auth_read" on public.fetch_log for select to authenticated using (true);
end $$;

grant select on public.v_monthly_fuel to authenticated;

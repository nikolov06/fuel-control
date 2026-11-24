-- =====================================================================
-- Импорт от Лукойл: допълнителни колони + функция за импорт
-- Пусни в SQL Editor след 20261120000001_fuel_schema.sql (може и повторно)
-- =====================================================================

alter table public.vehicles add column if not exists company text;   -- фирма от справката на Лукойл

alter table public.refuels add column if not exists company       text;
alter table public.refuels add column if not exists invoice_no    text;
alter table public.refuels add column if not exists invoice_date  date;
alter table public.refuels add column if not exists receipt_no    text;     -- номер на бон
alter table public.refuels add column if not exists product       text;     -- стоката, както е във файла
alter table public.refuels add column if not exists fuel_category text;     -- Дизел / Бензин / AdBlue / Друго
alter table public.refuels add column if not exists unit_price    numeric;
alter table public.refuels add column if not exists amount        numeric;  -- стойност
alter table public.refuels add column if not exists plate_raw     text;     -- рег. номер, както е във файла
alter table public.refuels add column if not exists source        text default 'lukoil';  -- lukoil / manual

-- Зарежданията пазят рег. номера като текст, без задължителна връзка към vehicles.
-- Така се записват и редовете за чужди фирми/МПС, но в сметката влизат само нашите машини.
-- Ако по-късно добавиш машина (напр. без GPS), старите ѝ зареждания се засичат автоматично.
alter table public.refuels drop constraint if exists refuels_plate_fkey;

-- Импорт на редове от парсера (JSON масив). Дублираните (същата карта + бон + стока + час + количество)
-- се пропускат, така че един и същ файл може да се качи повторно без проблем.
-- Машини НЕ се създават: номенклатурата идва от Нетера + ръчно добавените.
drop function if exists public.import_lukoil(jsonb, text);
drop function if exists public.import_refuels(jsonb, text, text);
create or replace function public.import_refuels(p_rows jsonb, p_file text default null, p_source text default 'lukoil')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total int; v_inserted int; v_matched int; v_unmatched_plates jsonb;
begin
  create temp table _in on commit drop as
  select public.normalize_plate(r->>'plate_raw')            as plate,
         r->>'plate_raw'                                   as plate_raw,
         nullif(r->>'card', '')                            as card,
         (r->>'ts')::timestamp                             as ts,
         nullif(r->>'receipt_no', '')                      as receipt_no,
         r->>'product'                                     as product,
         r->>'fuel_category'                               as fuel_category,
         (r->>'unit_price')::numeric                       as unit_price,
         (r->>'liters')::numeric                           as liters,
         (r->>'amount')::numeric                           as amount,
         r->>'station'                                     as station,
         r->>'company'                                     as company,
         r->>'invoice_no'                                  as invoice_no,
         nullif(r->>'invoice_date', '')::date              as invoice_date
  from jsonb_array_elements(p_rows) r;

  get diagnostics v_total = row_count;

  -- Само за съществуващи машини: попълва фирма и карта, ако са празни
  update public.vehicles v
     set company     = coalesce(v.company, x.company),
         lukoil_card = coalesce(v.lukoil_card, x.card)
    from (select distinct on (plate) plate, company, card from _in
          where plate is not null order by plate, ts desc) x
   where v.plate = x.plate and (v.company is null or v.lukoil_card is null);

  with ins as (
    insert into public.refuels (ts, plate, plate_raw, card, fuel_type, fuel_category, product, liters,
                                unit_price, amount, station, company, invoice_no, invoice_date,
                                receipt_no, source_file, source, row_hash)
    select ts, plate, plate_raw, card, fuel_category, fuel_category, product, liters,
           unit_price, amount, station, company, invoice_no, invoice_date, receipt_no, p_file, p_source,
           case when card is null and receipt_no is null
                -- ръчни редове без карта и бон: ключът включва машината и станцията
                then md5(concat_ws('|', 'manual', plate, station, product, ts::text, liters::text))
                else md5(concat_ws('|', card, receipt_no, product, ts::text, liters::text)) end
    from _in
    on conflict (row_hash) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  select count(*) into v_matched from _in i where exists (select 1 from public.vehicles v where v.plate = i.plate);

  select coalesce(jsonb_agg(jsonb_build_object('plate', plate, 'company', company, 'rows', n, 'liters', l)
                            order by company, plate), '[]'::jsonb)
    into v_unmatched_plates
    from (select plate, max(company) as company, count(*) as n, sum(liters) as l
          from _in i where not exists (select 1 from public.vehicles v where v.plate = i.plate)
          group by plate) u;

  return jsonb_build_object('total', v_total, 'inserted', v_inserted, 'duplicates', v_total - v_inserted,
                            'matched_rows', v_matched, 'unmatched_rows', v_total - v_matched,
                            'unmatched_plates', v_unmatched_plates);
end $$;

-- Зареждания без машина в базата (за екран "Неразпознати" — оттам може да се добави машина)
create or replace view public.v_unmatched_refuels
with (security_invoker = true) as
select r.plate, max(r.plate_raw) as plate_raw, max(r.company) as company,
       to_char(r.ts, 'YYYY-MM') as month, count(*) as rows, sum(r.liters) as liters, sum(r.amount) as amount
from public.refuels r
where not exists (select 1 from public.vehicles v where v.plate = r.plate)
group by r.plate, to_char(r.ts, 'YYYY-MM');

grant select on public.v_unmatched_refuels to authenticated;

-- Кратко име за импорта от Лукойл
create or replace function public.import_lukoil(p_rows jsonb, p_file text default null)
returns jsonb language sql security invoker set search_path = public as $$
  select public.import_refuels(p_rows, p_file, 'lukoil')
$$;

grant execute on function public.import_refuels(jsonb, text, text) to authenticated;
grant execute on function public.import_lukoil(jsonb, text) to authenticated;

-- ---------- Обновен изглед: броят се само Дизел и Бензин ----------
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
         rf.refueled, rf.refuel_amount, rf.categories
  from months m
  cross join public.vehicles v
  left join public.snapshots s on s.plate = v.plate and s.snap_date = m.start_date
  left join public.snapshots e on e.plate = v.plate and e.snap_date = m.end_date
  left join lateral (
    select coalesce(sum(r.liters), 0) as refueled,
           coalesce(sum(r.amount), 0) as refuel_amount,
           array_agg(distinct r.fuel_category) filter (where r.fuel_category is not null) as categories
    from public.refuels r
    where r.plate = v.plate
      and r.ts >  m.start_date + time '23:59:59'
      and r.ts <= m.end_date   + time '23:59:59'
      and coalesce(r.fuel_category, r.fuel_type, 'Дизел') not in ('AdBlue', 'Друго')
      and coalesce(r.fuel_type, '') not ilike '%adblue%'
  ) rf on true
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
    case when refueled > 0 and not has_e then 'зареждания, но няма GPS данни' end,
    case when fuel_type is not null and categories is not null
              and not (fuel_type = all(categories)) then 'заредено различно гориво от вида на машината' end,
    case when l_100km is not null and norm_l_100km > 0
              and abs(l_100km - norm_l_100km) / norm_l_100km > 0.15
         then case when l_100km > norm_l_100km then 'над нормата' else 'под нормата' end end,
    case when used > 0 and can_used is not null and abs(can_used - used) / used > 0.10
         then 'CAN брояч ≠ баланс' end
  ], null), '; ')          as "Бележки",
  start_date               as "Начална дата",
  end_date                 as "Крайна дата",
  round(refuel_amount, 2)  as "Стойност зареждания",
  company                  as "Фирма"
from calc2;

grant select on public.v_monthly_fuel to authenticated;

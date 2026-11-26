-- =====================================================================
-- Пътни листове за коли без GPS (мениджърски коли)
-- Дневни км по шофьор + норма; заредено идва от refuels (Лукойл/ръчни)
-- Пусни в SQL Editor (може и повторно)
-- =====================================================================

create table if not exists public.trip_days (
  plate      text not null references public.vehicles(plate) on update cascade,
  day        date not null,
  driver     text,
  km         numeric,
  norm       numeric,          -- норма за деня; празно = нормата на машината
  note       text,
  updated_at timestamptz not null default now(),
  primary key (plate, day)
);

create table if not exists public.trip_months (
  plate          text not null references public.vehicles(plate) on update cascade,
  month          text not null check (month ~ '^\d{4}-\d{2}$'),
  odometer_start numeric,      -- километраж към 1-во число
  opening_fuel   numeric,      -- остатък гориво от предходния месец
  km_total       numeric,
  refueled       numeric,
  consumed       numeric,
  closing_fuel   numeric,      -- остатък в края на месеца
  updated_at     timestamptz not null default now(),
  updated_by     text,
  primary key (plate, month)
);

alter table public.trip_days   enable row level security;
alter table public.trip_months enable row level security;
drop policy if exists "auth_all" on public.trip_days;
drop policy if exists "auth_all" on public.trip_months;
create policy "auth_all" on public.trip_days   for all to authenticated using (true) with check (true);
create policy "auth_all" on public.trip_months for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.trip_days, public.trip_months to authenticated;
grant all on public.trip_days, public.trip_months to service_role;

-- Запис на цял месец наведнъж (атомарно): изтрива дните на месеца и записва новите
create or replace function public.save_trip_month(
  p_plate text, p_month text, p_days jsonb,
  p_odometer_start numeric, p_opening numeric,
  p_km numeric, p_refueled numeric, p_consumed numeric, p_closing numeric)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_from date := (p_month || '-01')::date;
begin
  delete from public.trip_days
   where plate = p_plate and day >= v_from and day < (v_from + interval '1 month');

  insert into public.trip_days (plate, day, driver, km, norm, note)
  select p_plate, (d->>'day')::date, nullif(d->>'driver', ''),
         nullif(d->>'km', '')::numeric, nullif(d->>'norm', '')::numeric, nullif(d->>'note', '')
  from jsonb_array_elements(p_days) d;

  insert into public.trip_months (plate, month, odometer_start, opening_fuel, km_total, refueled, consumed, closing_fuel, updated_by)
  values (p_plate, p_month, p_odometer_start, p_opening, p_km, p_refueled, p_consumed, p_closing,
          coalesce(auth.jwt()->>'email', 'user'))
  on conflict (plate, month) do update set
    odometer_start = excluded.odometer_start, opening_fuel = excluded.opening_fuel,
    km_total = excluded.km_total, refueled = excluded.refueled, consumed = excluded.consumed,
    closing_fuel = excluded.closing_fuel, updated_at = now(), updated_by = excluded.updated_by;
end $$;

grant execute on function public.save_trip_month(text, text, jsonb, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;

-- Мениджърските коли без GPS
update public.vehicles set has_gps = false
 where plate in ('CB0469OP', 'CB4893TK', 'B3820TC', 'B8985TM', 'CB1651PO');

-- Машините, дошли само от Нетера (камиони, техника), не са в разпределението
update public.vehicles set in_allocation = false
 where plate not in (select plate from public.fuel_balances);

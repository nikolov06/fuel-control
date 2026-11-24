-- =====================================================================
-- Разпределение на горивото (замества ръчния Excel файл)
--  * номенклатура: фирма-собственик, отдел, модел, статус, бележка
--  * fuel_balances: месечни салда по машина (Кол-во / За изписване / Остатък)
--  * import_allocation: импорт на стар ръчен файл (начални остатъци + номенклатура)
-- Пусни в SQL Editor след 001 и 002 (може и повторно)
-- =====================================================================

-- vehicles.company вече е ФИРМАТА-СОБСТВЕНИК (от файла за разпределение / ръчно),
-- а не фирмата, платила картата в Лукойл (тя е в refuels.company).
alter table public.vehicles add column if not exists department int;      -- отдел 1000 / 3000 / 9000
alter table public.vehicles add column if not exists model      text;     -- марка/модел
alter table public.vehicles add column if not exists status     text not null default 'active';
alter table public.vehicles add column if not exists note       text;     -- водач, особености
alter table public.vehicles add column if not exists in_allocation boolean not null default true;  -- влиза в разпределението

do $$ begin
  alter table public.vehicles add constraint vehicles_status_chk
    check (status in ('active', 'for_sale', 'stored', 'damaged', 'sold'));
exception when duplicate_object then null; end $$;

-- Импортът от Лукойл повече не пипа фирмата на машината (само празна карта)
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

  update public.vehicles v
     set lukoil_card = x.card
    from (select distinct on (plate) plate, card from _in
          where plate is not null and card is not null order by plate, ts desc) x
   where v.plate = x.plate and v.lukoil_card is null;

  with ins as (
    insert into public.refuels (ts, plate, plate_raw, card, fuel_type, fuel_category, product, liters,
                                unit_price, amount, station, company, invoice_no, invoice_date,
                                receipt_no, source_file, source, row_hash)
    select ts, plate, plate_raw, card, fuel_category, fuel_category, product, liters,
           unit_price, amount, station, company, invoice_no, invoice_date, receipt_no, p_file, p_source,
           case when card is null and receipt_no is null
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

-- ---------- Месечни салда ----------
create table if not exists public.fuel_balances (
  month          text not null check (month ~ '^\d{4}-\d{2}$'),   -- YYYY-MM
  plate          text not null references public.vehicles(plate) on update cascade,
  company        text,               -- фирма-собственик към момента на приключване
  department     int,
  opening        numeric,            -- остатък от предходния месец (null при стар импорт)
  refueled       numeric,            -- заредено през месеца (null при стар импорт)
  qty_available  numeric not null,   -- Кол-во към дата = opening + refueled
  written_off    numeric not null,   -- За изписване
  closing        numeric generated always as (qty_available - written_off) stored,  -- Остатък
  method         text,               -- excel / gps / norm / manual
  note           text,
  source         text not null default 'calc',   -- excel / calc
  approved_at    timestamptz,
  approved_by    text,
  updated_at     timestamptz not null default now(),
  primary key (month, plate)
);

alter table public.fuel_balances enable row level security;
drop policy if exists "auth_all" on public.fuel_balances;
create policy "auth_all" on public.fuel_balances for all to authenticated using (true) with check (true);

-- Заключеният (одобрен) месец не може да се променя
create or replace function public.fuel_balances_guard() returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.approved_at is not null
     and not coalesce(current_setting('fuel.unlock', true), '') = 'on' then
    raise exception 'Месец % е одобрен и заключен (машина %)', old.month, old.plate;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists fuel_balances_guard on public.fuel_balances;
create trigger fuel_balances_guard before update or delete on public.fuel_balances
  for each row execute function public.fuel_balances_guard();

-- ---------- Импорт на ръчен файл за разпределение ----------
-- p_rows: изходът на parseAllocationRows; p_month: 'YYYY-MM'
-- Обновява номенклатурата (фирма, отдел, модел; статус и бележка само ако са празни/active)
-- и записва салдата за месеца като одобрени (source = excel).
create or replace function public.import_allocation(p_rows jsonb, p_month text, p_by text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare v_total int; v_new int; v_bal int;
begin
  create temp table _a on commit drop as
  select public.normalize_plate(r->>'plate') as plate, r->>'company' as company,
         nullif(r->>'department', '')::int as department, r->>'model' as model,
         (r->>'qty_available')::numeric as qty, (r->>'written_off')::numeric as wo,
         r->>'note' as note, coalesce(r->>'status', 'active') as status
  from jsonb_array_elements(p_rows) r;
  get diagnostics v_total = row_count;

  with up as (
    insert into public.vehicles (plate, company, department, model, status, note, has_gps)
    select plate, company, department, model, status, note, true from _a
    on conflict (plate) do update set
      company    = excluded.company,
      department = excluded.department,
      model      = coalesce(nullif(excluded.model, ''), public.vehicles.model),
      status     = case when public.vehicles.status = 'active' then excluded.status else public.vehicles.status end,
      note       = coalesce(public.vehicles.note, excluded.note)
    returning (xmax = 0) as is_new
  )
  select count(*) filter (where is_new) into v_new from up;

  perform set_config('fuel.unlock', 'on', true);   -- позволява презапис на стар импорт
  insert into public.fuel_balances (month, plate, company, department, qty_available, written_off,
                                    method, note, source, approved_at, approved_by)
  select p_month, plate, company, department, qty, wo, 'excel', note, 'excel', now(), coalesce(p_by, 'import')
  from _a
  on conflict (month, plate) do update set
    company = excluded.company, department = excluded.department,
    qty_available = excluded.qty_available, written_off = excluded.written_off,
    note = excluded.note, approved_at = excluded.approved_at, approved_by = excluded.approved_by
  where public.fuel_balances.source = 'excel';      -- изчислените от системата месеци не се пипат
  get diagnostics v_bal = row_count;
  perform set_config('fuel.unlock', 'off', true);

  return jsonb_build_object('rows', v_total, 'new_vehicles', v_new, 'balances_written', v_bal);
end $$;

grant execute on function public.import_allocation(jsonb, text, text) to authenticated;

-- ---------- Изрични права за приложението (само за влезли потребители) ----------
-- Нужно, когато в проекта е изключено "Grant API access to new tables automatically".
-- Ролята anon (невлезли) не получава нищо.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.vehicles, public.snapshots, public.refuels, public.fuel_balances to authenticated;
grant select on public.fetch_log, public.v_monthly_fuel, public.v_unmatched_refuels to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.normalize_plate(text), public.fuel_liters(numeric, text, numeric) to authenticated;

-- Права за service_role (Edge Function-ите пишат с нея).
-- Нужно, когато е изключено "Grant API access to new tables automatically".
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

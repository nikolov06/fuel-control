-- =====================================================================
-- Импорт на цял Excel файл с пътни листове (всички месеци наведнъж)
-- Пусни в SQL Editor след 004 (може и повторно)
-- =====================================================================

-- p_months: масив от месеци [{month, odometer_start, opening, km, refueled, consumed, closing,
--            default_norm, fuel, model, days:[{day, driver, km, norm, refueled}]}]
-- Зарежданията от файла се записват само за месеци, в които за колата НЯМА данни от Лукойл/ръчни
-- (за да няма двойно броене). Повторен импорт презаписва същите месеци.
create or replace function public.import_trip_workbook(p_plate text, p_months jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  m jsonb; v_from date; v_to date; v_has_other boolean;
  v_n int := 0; v_ref_ins int := 0; v_ref_skipped text[] := '{}';
  v_fuel text;
begin
  if not exists (select 1 from public.vehicles where plate = p_plate) then
    raise exception 'Машина % я няма в базата', p_plate;
  end if;

  -- Норма, гориво и модел на машината, ако са празни (от последния месец във файла)
  m := p_months -> (jsonb_array_length(p_months) - 1);
  update public.vehicles set
    norm_l_100km = coalesce(norm_l_100km, nullif(m->>'default_norm', '')::numeric),
    fuel_type    = coalesce(fuel_type, nullif(m->>'fuel', '')),
    model        = coalesce(model, nullif(m->>'model', ''))
  where plate = p_plate;
  select coalesce(fuel_type, 'Дизел') into v_fuel from public.vehicles where plate = p_plate;

  for m in select * from jsonb_array_elements(p_months) loop
    v_from := ((m->>'month') || '-01')::date;
    v_to   := (v_from + interval '1 month')::date;

    -- дни
    delete from public.trip_days where plate = p_plate and day >= v_from and day < v_to;
    insert into public.trip_days (plate, day, driver, km, norm)
    select p_plate, (d->>'day')::date, nullif(d->>'driver', ''),
           nullif(d->>'km', '')::numeric, nullif(d->>'norm', '')::numeric
    from jsonb_array_elements(m->'days') d
    where nullif(d->>'km', '') is not null or nullif(d->>'driver', '') is not null;

    -- зареждания от файла (само ако няма други за месеца)
    delete from public.refuels where plate = p_plate and source = 'putni_list' and ts >= v_from and ts < v_to;
    select exists (select 1 from public.refuels where plate = p_plate and ts >= v_from and ts < v_to
                   and coalesce(source, 'lukoil') <> 'putni_list') into v_has_other;
    if v_has_other then
      v_ref_skipped := v_ref_skipped || (m->>'month');
    else
      insert into public.refuels (ts, plate, plate_raw, fuel_type, fuel_category, product, liters, station, source, source_file, row_hash)
      select ((d->>'day') || ' 12:00:00')::timestamp, p_plate, p_plate, v_fuel, v_fuel, v_fuel,
             (d->>'refueled')::numeric, 'по пътен лист', 'putni_list', 'пътен лист ' || (m->>'month'),
             md5(concat_ws('|', 'putni_list', p_plate, d->>'day', d->>'refueled'))
      from jsonb_array_elements(m->'days') d
      where nullif(d->>'refueled', '') is not null and (d->>'refueled')::numeric > 0
      on conflict (row_hash) do nothing;
      get diagnostics v_n = row_count;
      v_ref_ins := v_ref_ins + v_n;
    end if;

    -- месец
    insert into public.trip_months (plate, month, odometer_start, opening_fuel, km_total, refueled, consumed, closing_fuel, updated_by)
    values (p_plate, m->>'month', nullif(m->>'odometer_start', '')::numeric, (m->>'opening')::numeric,
            (m->>'km')::numeric, (m->>'refueled')::numeric, (m->>'consumed')::numeric, (m->>'closing')::numeric,
            coalesce(auth.jwt()->>'email', 'import'))
    on conflict (plate, month) do update set
      odometer_start = excluded.odometer_start, opening_fuel = excluded.opening_fuel, km_total = excluded.km_total,
      refueled = excluded.refueled, consumed = excluded.consumed, closing_fuel = excluded.closing_fuel,
      updated_at = now(), updated_by = excluded.updated_by;
  end loop;

  return jsonb_build_object('months', jsonb_array_length(p_months), 'refuels_inserted', v_ref_ins,
                            'refuels_skipped_months', to_jsonb(v_ref_skipped));
end $$;

grant execute on function public.import_trip_workbook(text, jsonb) to authenticated;

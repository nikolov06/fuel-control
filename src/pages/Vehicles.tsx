import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { STATUS_LABEL } from "../lib/types";
import type { Vehicle, VehicleStatus } from "../lib/types";
import { Notice, errText, toNum, downloadXlsx } from "../lib/ui";
import { normalizePlate } from "../lib/lukoilParser.ts";

type Draft = Record<string, string | boolean>;

// Редактируеми колони
const COLS: { key: keyof Vehicle; label: string; kind: "text" | "num" | "bool" | "status" | "unit" | "fuel"; w?: number }[] = [
  { key: "company", label: "Фирма", kind: "text", w: 160 },
  { key: "department", label: "Отдел", kind: "num", w: 60 },
  { key: "model", label: "Модел", kind: "text", w: 190 },
  { key: "status", label: "Статус", kind: "status", w: 115 },
  { key: "fuel_type", label: "Гориво", kind: "fuel", w: 85 },
  { key: "tank_liters", label: "Резервоар л", kind: "num", w: 70 },
  { key: "fuel_level_unit", label: "Ниво в", kind: "unit", w: 55 },
  { key: "norm_l_100km", label: "Норма л/100", kind: "num", w: 70 },
  { key: "has_gps", label: "GPS", kind: "bool" },
  { key: "in_allocation", label: "В разпр.", kind: "bool" },
  { key: "note", label: "Бележка", kind: "text", w: 220 },
];

function toDraftValue(v: unknown, kind: string): string | boolean {
  if (kind === "bool") return Boolean(v);
  if (v === null || v === undefined) return "";
  return String(v);
}

export default function Vehicles() {
  const [rows, setRows] = useState<Vehicle[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState("");
  const [onlyAlloc, setOnlyAlloc] = useState(true);
  const [newPlate, setNewPlate] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newModel, setNewModel] = useState("");

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("vehicles").select("*").order("company", { nullsFirst: false }).order("plate");
    setLoading(false);
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setRows((data ?? []) as Vehicle[]);
    setDrafts({});
  }
  useEffect(() => {
    load();
  }, []);

  const companies = useMemo(
    () => [...new Set(rows.map((r) => r.company).filter((c): c is string => !!c))].sort(),
    [rows],
  );

  const shown = useMemo(() => {
    const s = q.trim().toUpperCase();
    const sp = normalizePlate(q);
    return rows.filter(
      (r) =>
        (!onlyAlloc || r.in_allocation) &&
        (!company || (company === "—" ? !r.company : r.company === company)) &&
        (!status || r.status === status) &&
        (!s || r.plate.includes(sp) || (r.model ?? "").toUpperCase().includes(s) || (r.note ?? "").toUpperCase().includes(s)),
    );
  }, [rows, q, company, status, onlyAlloc]);

  function val(r: Vehicle, key: keyof Vehicle, kind: string): string | boolean {
    const d = drafts[r.plate];
    if (d && key in d) return d[key as string];
    return toDraftValue(r[key], kind);
  }

  function setVal(plate: string, key: string, v: string | boolean) {
    setDrafts((p) => ({ ...p, [plate]: { ...(p[plate] ?? {}), [key]: v } }));
  }

  function patchFor(plate: string): Partial<Vehicle> {
    const d = drafts[plate] ?? {};
    const out: Record<string, unknown> = {};
    for (const c of COLS) {
      if (!(c.key in d)) continue;
      const v = d[c.key as string];
      if (c.kind === "bool") out[c.key] = Boolean(v);
      else if (c.kind === "num") out[c.key] = toNum(String(v));
      else out[c.key] = String(v).trim() === "" ? null : String(v).trim();
    }
    if (out.fuel_level_unit === null) out.fuel_level_unit = "l";
    if (out.status === null) out.status = "active";
    return out as Partial<Vehicle>;
  }

  const dirty = Object.keys(drafts).filter((p) => Object.keys(drafts[p]).length > 0);

  async function saveAll() {
    setMsg(null);
    const results = await Promise.all(
      dirty.map((plate) => supabase.from("vehicles").update(patchFor(plate)).eq("plate", plate)),
    );
    const failed = results.filter((r) => r.error);
    if (failed.length) setMsg({ kind: "err", text: `Грешка при запис: ${errText(failed[0].error)}` });
    else setMsg({ kind: "ok", text: `Записани промени: ${dirty.length} машини.` });
    await load();
  }

  async function addVehicle() {
    const plate = normalizePlate(newPlate);
    if (!plate) return;
    const { error } = await supabase.from("vehicles").insert({
      plate,
      company: newCompany.trim() || null,
      model: newModel.trim() || null,
      has_gps: false,
    });
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setMsg({ kind: "ok", text: `Добавена машина ${plate}.` });
    setNewPlate("");
    setNewModel("");
    await load();
  }

  function exportXlsx() {
    downloadXlsx(
      shown.map((r) => ({
        "Рег. номер": r.plate, Фирма: r.company, Отдел: r.department, Модел: r.model,
        Статус: STATUS_LABEL[r.status] ?? r.status, Гориво: r.fuel_type, "Резервоар л": r.tank_liters,
        "Ниво в": r.fuel_level_unit, "Норма л/100км": r.norm_l_100km, GPS: r.has_gps ? "да" : "не",
        "В разпределение": r.in_allocation ? "да" : "не", Бележка: r.note,
      })),
      "Машини",
      "mashini.xlsx",
    );
  }

  return (
    <div>
      <div className="page-head">
        <h2>Машини</h2>
        <span className="muted">
          {shown.length} от {rows.length}
        </span>
      </div>

      <div className="toolbar">
        <input placeholder="Търси рег. №, модел, бележка…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        <select value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">Всички фирми</option>
          {companies.map((c) => (
            <option key={c}>{c}</option>
          ))}
          <option value="—">(без фирма)</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Всички статуси</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={onlyAlloc} onChange={(e) => setOnlyAlloc(e.target.checked)} /> само в разпределението
        </label>
        <span className="spacer" />
        <button className="btn" onClick={exportXlsx}>Excel</button>
        <button className="btn primary" disabled={!dirty.length} onClick={saveAll}>
          Запиши промените{dirty.length ? ` (${dirty.length})` : ""}
        </button>
      </div>

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {loading && <p className="muted">Зареждане…</p>}

      <div className="table-wrap">
        <table className="grid editable">
          <thead>
            <tr>
              <th>Рег. номер</th>
              {COLS.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th>Карта Лукойл</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.plate} className={drafts[r.plate] ? "dirty" : ""}>
                <td className="mono strong">{r.plate}</td>
                {COLS.map((c) => {
                  const v = val(r, c.key, c.kind);
                  const set = (x: string | boolean) => setVal(r.plate, c.key, x);
                  if (c.kind === "bool")
                    return (
                      <td key={c.key} className="center">
                        <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(e.target.checked)} />
                      </td>
                    );
                  if (c.kind === "status")
                    return (
                      <td key={c.key}>
                        <select value={String(v)} onChange={(e) => set(e.target.value as VehicleStatus)} className={`st-${v}`}>
                          {Object.entries(STATUS_LABEL).map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  if (c.kind === "unit")
                    return (
                      <td key={c.key}>
                        <select value={String(v) || "l"} onChange={(e) => set(e.target.value)}>
                          <option value="l">л</option>
                          <option value="%">%</option>
                        </select>
                      </td>
                    );
                  if (c.kind === "fuel")
                    return (
                      <td key={c.key}>
                        <select value={String(v)} onChange={(e) => set(e.target.value)}>
                          <option value="">—</option>
                          <option>Дизел</option>
                          <option>Бензин</option>
                        </select>
                      </td>
                    );
                  return (
                    <td key={c.key}>
                      <input
                        value={String(v)}
                        onChange={(e) => set(e.target.value)}
                        style={{ width: c.w }}
                        className={c.kind === "num" ? "num" : ""}
                        list={c.key === "company" ? "companies" : undefined}
                      />
                    </td>
                  );
                })}
                <td className="mono small">{r.lukoil_card ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="companies">
          {companies.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div className="card">
        <h3>Добави машина</h3>
        <p className="muted small">
          Напр. кола без GPS. Машините от Нетера се добавят автоматично. Резервоар и норма попълваш в таблицата горе.
        </p>
        <div className="toolbar">
          <input placeholder="Рег. номер" value={newPlate} onChange={(e) => setNewPlate(e.target.value)} style={{ width: 130 }} />
          <input placeholder="Фирма" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} list="companies" style={{ width: 160 }} />
          <input placeholder="Марка / модел" value={newModel} onChange={(e) => setNewModel(e.target.value)} style={{ width: 200 }} />
          <button className="btn" disabled={!normalizePlate(newPlate)} onClick={addVehicle}>
            Добави {normalizePlate(newPlate)}
          </button>
        </div>
      </div>
    </div>
  );
}

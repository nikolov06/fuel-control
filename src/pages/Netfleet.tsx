import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { FetchLog } from "../lib/types";
import { Notice, errText, prevMonth, fmt, downloadXlsx } from "../lib/ui";
import { normalizePlate } from "../lib/lukoilParser.ts";

type Raw = Record<string, unknown>;
interface SnapRow {
  plate: string;
  raw: Raw | null;
  fetched_at: string;
}
interface VehInfo {
  plate: string;
  company: string | null;
  model: string | null;
  in_allocation: boolean;
  tank_liters: number | null;
  fuel_level_unit: string;
}

// Описание на полетата от Нетера (по документацията)
const FIELD_LABEL: Record<string, string> = {
  plateNumber: "Име в Нетера",
  canFuelLevel: "Ниво гориво CAN",
  canTotalFuelUsed: "Общо изразходвано CAN (л)",
  gpsOdometer: "Одометър GPS (км)",
  canOdometer: "Одометър CAN (км)",
  gpsTotalEngineHours: "Моточасове GPS",
  canTotalEngineHours: "Моточасове CAN",
};

export default function Netfleet() {
  const [logs, setLogs] = useState<FetchLog[]>([]);
  const [counts, setCounts] = useState<[string, number][]>([]);
  const [month, setMonth] = useState(prevMonth());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Подробни данни за избрана дата
  const [selDate, setSelDate] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<SnapRow[]>([]);
  const [veh, setVeh] = useState<Map<string, VehInfo>>(new Map());
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "alloc" | "nofuel" | "other">("all");
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function load() {
    const [l, s] = await Promise.all([
      supabase.from("fetch_log").select("*").order("run_at", { ascending: false }).limit(30),
      supabase.from("snapshots").select("snap_date").limit(10000),
    ]);
    setLogs((l.data ?? []) as FetchLog[]);
    const m = new Map<string, number>();
    for (const r of (s.data ?? []) as { snap_date: string }[]) m.set(r.snap_date, (m.get(r.snap_date) ?? 0) + 1);
    setCounts([...m].sort((a, b) => b[0].localeCompare(a[0])));
  }
  useEffect(() => {
    load();
  }, []);

  async function openDate(d: string) {
    setSelDate(d);
    setLoadingDetail(true);
    const [s, v] = await Promise.all([
      supabase.from("snapshots").select("plate,raw,fetched_at").eq("snap_date", d).order("plate").limit(5000),
      supabase.from("vehicles").select("plate,company,model,in_allocation,tank_liters,fuel_level_unit"),
    ]);
    setLoadingDetail(false);
    if (s.error) return setMsg({ kind: "err", text: errText(s.error) });
    setSnaps((s.data ?? []) as SnapRow[]);
    setVeh(new Map(((v.data ?? []) as VehInfo[]).map((x) => [x.plate, x])));
  }

  // Всички полета, които Нетера е върнал (в реда от документацията, после останалите)
  const fields = useMemo(() => {
    const set = new Set<string>();
    for (const s of snaps) Object.keys(s.raw ?? {}).forEach((k) => set.add(k));
    const known = Object.keys(FIELD_LABEL).filter((k) => set.has(k));
    return [...known, ...[...set].filter((k) => !known.includes(k)).sort()];
  }, [snaps]);

  const shown = useMemo(() => {
    const p = normalizePlate(q);
    return snaps.filter((s) => {
      const v = veh.get(s.plate);
      const lvl = (s.raw ?? {})["canFuelLevel"];
      if (p && !s.plate.includes(p)) return false;
      if (filter === "alloc" && !v?.in_allocation) return false;
      if (filter === "other" && v?.in_allocation) return false;
      if (filter === "nofuel" && !(lvl === null || lvl === undefined)) return false;
      return true;
    });
  }, [snaps, veh, q, filter]);

  const noFuelCount = snaps.filter((s) => (s.raw ?? {})["canFuelLevel"] == null).length;

  function cell(v: unknown, key: string) {
    if (v === null || v === undefined) return <span className="null">—</span>;
    if (typeof v === "number") return fmt(v, key.toLowerCase().includes("odometer") || key.toLowerCase().includes("hours") ? 1 : 2);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function exportXlsx() {
    downloadXlsx(
      shown.map((s) => {
        const v = veh.get(s.plate);
        const row: Record<string, unknown> = {
          "Рег. номер": s.plate, Фирма: v?.company ?? "", Модел: v?.model ?? "",
          "В разпределение": v?.in_allocation ? "да" : "не", "Резервоар (л)": v?.tank_liters ?? "",
        };
        for (const f of fields) row[FIELD_LABEL[f] ?? f] = (s.raw ?? {})[f] ?? "";
        return row;
      }),
      selDate ?? "netera",
      `netera_${selDate}.xlsx`,
    );
  }

  async function fetchNow() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.functions.invoke("netfleet-snapshot", { body: { month } });
    setBusy(false);
    if (error) setMsg({ kind: "err", text: errText(error) });
    else {
      const res = (data?.results ?? []) as { date: string; status: string; saved?: number; message?: string }[];
      const bad = res.filter((r) => r.status !== "ok");
      setMsg(
        bad.length
          ? { kind: "err", text: bad.map((r) => `${r.date}: ${r.message}`).join("; ") }
          : { kind: "ok", text: res.map((r) => `${r.date}: ${r.saved} машини`).join(" · ") },
      );
    }
    load();
    if (selDate) openDate(selDate);
  }

  return (
    <div>
      <div className="page-head">
        <h2>Нетера (GPS)</h2>
      </div>
      <p className="muted">
        Автоматично на 1-во число в 03:00 се тегли пробег и гориво към края на предходния месец. Оттук можеш да изтеглиш ръчно.
      </p>
      <div className="toolbar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <button className="btn primary" onClick={fetchNow} disabled={busy}>
          {busy ? "Тегля…" : "Изтегли за месеца"}
        </button>
        <span className="muted small">тегли края на избрания и на предходния месец</span>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="two-col">
        <div>
          <h3>Налични снимки</h3>
          <table className="grid compact clickable">
            <thead>
              <tr><th>Към дата</th><th className="num">Машини</th></tr>
            </thead>
            <tbody>
              {counts.map(([d, n]) => (
                <tr key={d} onClick={() => openDate(d)} className={d === selDate ? "selected" : ""} title="Покажи подробно">
                  <td>{d.split("-").reverse().join(".")} ›</td>
                  <td className="num">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Кликни дата за всички данни от Нетера.</p>
        </div>
        <div>
          <h3>Последни тегления</h3>
          <table className="grid compact">
            <thead>
              <tr><th>Кога</th><th>Към дата</th><th>Статус</th><th className="num">Машини</th><th>Кой</th><th>Съобщение</th></tr>
            </thead>
            <tbody>
              {logs.slice(0, 8).map((l) => (
                <tr key={l.id} className={l.status === "error" ? "row-err" : ""}>
                  <td>{new Date(l.run_at).toLocaleString("bg-BG")}</td>
                  <td>{l.snap_date?.split("-").reverse().join(".")}</td>
                  <td>{l.status}</td>
                  <td className="num">{l.vehicles_count ?? ""}</td>
                  <td className="small">{l.triggered_by}</td>
                  <td className="small">{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selDate && (
        <div className="card">
          <div className="page-head">
            <h3>Данни от Нетера към {selDate.split("-").reverse().join(".")}</h3>
            <span className="muted small">
              {shown.length} от {snaps.length} · без ниво на горивото: {noFuelCount}
            </span>
            <button className="btn" onClick={exportXlsx} disabled={!shown.length}>Excel</button>
            <button className="btn" onClick={() => setSelDate(null)}>Затвори</button>
          </div>
          <div className="toolbar">
            <input placeholder="Рег. номер" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 130 }} />
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">Всички</option>
              <option value="alloc">Само в разпределението</option>
              <option value="other">Извън разпределението (камиони, техника)</option>
              <option value="nofuel">Без ниво на горивото</option>
            </select>
          </div>
          {loadingDetail ? (
            <p className="muted">Зареждане…</p>
          ) : (
            <div className="table-wrap">
              <table className="grid compact">
                <thead>
                  <tr>
                    <th>Рег. номер</th><th>Фирма</th><th>Модел</th><th className="num">Резервоар</th>
                    {fields.map((f) => (
                      <th key={f} className={f === "plateNumber" ? "" : "num"} title={f}>
                        {FIELD_LABEL[f] ?? f}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    const v = veh.get(s.plate);
                    const lvl = (s.raw ?? {})["canFuelLevel"];
                    const overTank = typeof lvl === "number" && v?.tank_liters && v.fuel_level_unit !== "%" && lvl > v.tank_liters * 1.05;
                    return (
                      <tr key={s.plate} className={v?.in_allocation ? "" : "dim"}>
                        <td className="mono strong">{s.plate}</td>
                        <td className="nowrap">{v?.company ?? ""}</td>
                        <td className="nowrap small">{v?.model ?? ""}</td>
                        <td className="num">{v?.tank_liters ?? ""}</td>
                        {fields.map((f) => (
                          <td
                            key={f}
                            className={`${f === "plateNumber" ? "" : "num"} ${f === "canFuelLevel" && (lvl == null ? "cell-warn" : overTank ? "cell-err" : "")}`}
                            title={f === "canFuelLevel" && overTank ? "Над резервоара — вероятно е в %" : undefined}
                          >
                            {cell((s.raw ?? {})[f], f)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            Жълто: Нетера не праща ниво на горивото. Червено: нивото е над резервоара, т.е. вероятно е в % (смени „Ниво в“ на % в Машини).
          </p>
        </div>
      )}
    </div>
  );
}

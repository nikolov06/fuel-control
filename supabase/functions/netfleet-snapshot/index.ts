// Supabase Edge Function: netfleet-snapshot
// Тегли от Netfleet данните към края на месеца и ги записва в public.snapshots.
//
// Тяло на заявката (JSON, всичко е по избор):
//   {}                       -> последният ден на миналия месец (по време София)
//   { "date": "2026-10-31" } -> конкретна дата
//   { "month": "2026-10" }   -> 30.09 и 31.10 (начална база + край)
//
// Достъп: или хедър x-cron-secret = CRON_SECRET (за графика),
//         или валиден вход на потребител от приложението (Authorization: Bearer <user JWT>).
// Secrets (Edge Functions → Secrets): NETFLEET_API_KEY, CRON_SECRET
// SUPABASE_URL, SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY се подават автоматично.

import { createClient } from "npm:@supabase/supabase-js@2";

const NETFLEET_URL = "https://api.netfleet.bg:8080";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type Summary = {
  plateNumber?: string;
  gpsTotalEngineHours?: number;
  gpsOdometer?: number;
  canOdometer?: number;
  canTotalEngineHours?: number;
  canFuelLevel?: number;
  canTotalFuelUsed?: number;
};

function normalizePlate(p?: string | null): string | null {
  if (!p) return null;
  const map: Record<string, string> = {
    А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
  };
  const s = p.toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => map[c]).replace(/[\s-]/g, "");
  return s || null;
}

// Днешна дата в България -> последният ден на миналия месец
function lastDayPrevMonthSofia(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 0)); // ден 0 на текущия месец = последен ден на предишния
  return d.toISOString().slice(0, 10);
}

function monthDates(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0));
  const start = new Date(Date.UTC(y, m - 1, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

async function fetchNetfleet(date: string, apiKey: string): Promise<Summary[]> {
  const r = await fetch(`${NETFLEET_URL}/api/company/latest-history-by-date/${date}`, {
    // В документацията хедърът е 'api-key', а в securitySchemes - 'x-api-key'. Пращаме и двата.
    headers: { "api-key": apiKey, "x-api-key": apiKey, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Netfleet ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // --- Проверка на достъпа ---
  let triggeredBy = "";
  const clean = (s: string | null | undefined) => (s ?? "").trim().replace(/^["']|["']$/g, "");
  const cronSecret = clean(Deno.env.get("CRON_SECRET"));
  const sentSecret = clean(req.headers.get("x-cron-secret"));
  if (cronSecret && sentSecret && sentSecret === cronSecret) {
    triggeredBy = "cron";
  } else if (sentSecret) {
    // Изпратен е x-cron-secret, но не съвпада -> ясна причина (без да се показва паролата)
    return json({
      error: "Unauthorized",
      reason: !cronSecret ? "CRON_SECRET не е зададен в Edge Function Secrets"
                          : `x-cron-secret не съвпада (изпратени ${sentSecret.length} знака, очаквани ${cronSecret.length})`,
    }, 401);
  } else {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = token ? await admin.auth.getUser(token) : { data: null, error: true };
    if (error || !data?.user) {
      return json({ error: "Unauthorized", reason: "няма хедър x-cron-secret и няма влязъл потребител" }, 401);
    }
    triggeredBy = data.user.email ?? data.user.id;
  }

  const apiKey = Deno.env.get("NETFLEET_API_KEY");
  if (!apiKey) return json({ error: "Липсва secret NETFLEET_API_KEY" }, 500);

  let body: { date?: string; month?: string } = {};
  try { body = await req.json(); } catch { /* празно тяло */ }

  const dates = body.month ? monthDates(body.month) : [body.date ?? lastDayPrevMonthSofia()];
  const results: unknown[] = [];

  for (const date of dates) {
    try {
      const rows = await fetchNetfleet(date, apiKey);

      // Ръчно въведените снимки не се презаписват
      const { data: manual } = await admin.from("snapshots").select("plate")
        .eq("snap_date", date).eq("source", "manual");
      const skip = new Set((manual ?? []).map((m) => m.plate));

      const recs = rows
        .map((r) => ({ r, plate: normalizePlate(r.plateNumber) }))
        .filter((x) => x.plate && !skip.has(x.plate))
        .map(({ r, plate }) => ({
          snap_date: date,
          plate: plate!,
          gps_odometer: r.gpsOdometer ?? null,
          can_odometer: r.canOdometer ?? null,
          gps_engine_hours: r.gpsTotalEngineHours ?? null,
          can_engine_hours: r.canTotalEngineHours ?? null,
          can_fuel_level: r.canFuelLevel ?? null,
          can_total_fuel_used: r.canTotalFuelUsed ?? null,
          source: "api",
          fetched_at: new Date().toISOString(),
          raw: r,
        }));

      // Нови машини -> в номенклатурата (резервоар, норма и т.н. се попълват от интерфейса)
      const plates = [...new Set(recs.map((x) => x.plate))].map((plate) => ({ plate }));
      if (plates.length) {
        const { error } = await admin.from("vehicles").upsert(plates, { onConflict: "plate", ignoreDuplicates: true });
        if (error) throw error;
      }
      if (recs.length) {
        const { error } = await admin.from("snapshots").upsert(recs, { onConflict: "snap_date,plate" });
        if (error) throw error;
      }

      await admin.from("fetch_log").insert({
        snap_date: date, status: "ok", vehicles_count: recs.length,
        message: `Netfleet върна ${rows.length}, ръчни пропуснати ${skip.size}`, triggered_by: triggeredBy,
      });
      results.push({ date, status: "ok", saved: recs.length, returned: rows.length });
    } catch (e) {
      const o = e as { message?: string; details?: string; hint?: string; code?: string };
      const msg = e instanceof Error ? e.message
        : (o && typeof o === "object")
          ? [o.code, o.message, o.details, o.hint].filter(Boolean).join(" | ") || JSON.stringify(e)
          : String(e);
      await admin.from("fetch_log").insert({ snap_date: date, status: "error", message: msg, triggered_by: triggeredBy });
      results.push({ date, status: "error", message: msg });
    }
  }

  const failed = results.some((r) => (r as { status: string }).status === "error");
  return json({ results }, failed ? 502 : 200);
});

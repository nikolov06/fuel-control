import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, configError } from "./lib/supabase";
import { Notice } from "./lib/ui";
import Login from "./pages/Login";
import Vehicles from "./pages/Vehicles";
import RefuelImport from "./pages/RefuelImport";
import Refuels from "./pages/Refuels";
import Unmatched from "./pages/Unmatched";
import MonthlyReport from "./pages/MonthlyReport";
import Netfleet from "./pages/Netfleet";
import TripLog from "./pages/TripLog";
import "./App.css";

const PAGES = [
  { id: "report", label: "Месечна справка", icon: "📊", el: <MonthlyReport /> },
  { id: "import", label: "Импорт на зареждания", icon: "⛽", el: <RefuelImport /> },
  { id: "refuels", label: "Зареждания", icon: "🧾", el: <Refuels /> },
  { id: "unmatched", label: "Неразпознати", icon: "❓", el: <Unmatched /> },
  { id: "trips", label: "Пътни листове", icon: "🗒️", el: <TripLog /> },
  { id: "vehicles", label: "Машини", icon: "🚗", el: <Vehicles /> },
  { id: "netfleet", label: "Нетера (GPS)", icon: "📡", el: <Netfleet /> },
];

// Стари адреси -> новия екран за импорт със съответния таб
const LEGACY: Record<string, string> = { lukoil: "import", manual: "import/manual" };

function currentPage(): string {
  let h = window.location.hash.replace("#", "");
  if (LEGACY[h]) {
    h = LEGACY[h];
    history.replaceState(null, "", `#${h}`);
  }
  const id = h.split("/")[0];
  return PAGES.some((p) => p.id === id) ? id : "report";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState(currentPage());

  useEffect(() => {
    document.title = "Контрол на горивото";
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  if (configError)
    return (
      <div className="login-wrap">
        <Notice kind="err">{configError}</Notice>
      </div>
    );
  if (!ready) return null;
  if (!session) return <Login />;

  const active = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">⛽ Гориво</div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={p.id === active.id ? "active" : ""}>
              <span className="ico">{p.icon}</span>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="user">
          <div className="small muted">{session.user.email}</div>
          <button className="btn small" onClick={() => supabase.auth.signOut()}>
            Изход
          </button>
        </div>
      </aside>
      <main className="content" key={active.id}>
        {active.el}
      </main>
    </div>
  );
}

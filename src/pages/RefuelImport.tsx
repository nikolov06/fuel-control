import { useEffect, useState } from "react";
import LukoilImport from "./LukoilImport";
import ManualPaste from "./ManualPaste";

type Tab = "lukoil" | "manual";

const TABS: { id: Tab; label: string; hash: string }[] = [
  { id: "lukoil", label: "Файл от Лукойл", hash: "#import" },
  { id: "manual", label: "Ръчно (поставяне от Excel)", hash: "#import/manual" },
];

function tabFromHash(): Tab {
  return window.location.hash === "#import/manual" ? "manual" : "lukoil";
}

export default function RefuelImport() {
  const [tab, setTab] = useState<Tab>(tabFromHash());

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div>
      <div className="page-head">
        <h2>Импорт на зареждания</h2>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t.id} href={t.hash} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " active" : ""}`}>
            {t.label}
          </a>
        ))}
      </div>
      {tab === "lukoil" ? <LukoilImport /> : <ManualPaste />}
    </div>
  );
}

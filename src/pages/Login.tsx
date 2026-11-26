import { useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { Notice } from "../lib/ui";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setErr(error.message === "Invalid login credentials" ? "Грешен имейл или парола." : error.message);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>⛽ Контрол на горивото</h1>
        <label>
          Имейл
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Парола
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <Notice kind="err">{err}</Notice>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Влизане…" : "Вход"}
        </button>
      </form>
    </div>
  );
}

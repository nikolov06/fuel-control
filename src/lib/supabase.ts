import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configError =
  !url || !key || url.includes("ТВОЯ") || key.includes("ПОСТАВИ")
    ? "Липсват ключовете в .env.local (VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY). След промяна спри и пусни отново npm run dev."
    : null;

export const supabase = createClient(url || "http://localhost", key || "missing");

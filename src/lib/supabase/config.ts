// Public Supabase settings. No "server-only" here: the browser client needs the URL and anon key too.
// NEXT_PUBLIC_* values are inlined at build time, so they must be read as literal `process.env.NEXT_PUBLIC_X`.

export type SupabaseConfig = { url: string; anonKey: string };

export class ConfigError extends Error {
  name = "ConfigError";
}

const clean = (v: string | undefined) => v?.trim() || undefined;

/**
 * - neither value set  -> null (local demo mode)
 * - both set and valid -> the config
 * - exactly one set, or a malformed URL -> throws, so a half-configured deploy fails loudly instead of
 *   quietly falling back to a shared local file.
 */
export function readSupabaseConfig(
  url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  anonKey = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
): SupabaseConfig | null {
  if (!url && !anonKey) return null;
  const missing = [!url && "NEXT_PUBLIC_SUPABASE_URL", !anonKey && "NEXT_PUBLIC_SUPABASE_ANON_KEY"].filter(Boolean);
  if (missing.length) throw new ConfigError(`Supabase is partly configured: ${missing.join(" and ")} missing.`);
  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    throw new ConfigError("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new ConfigError("NEXT_PUBLIC_SUPABASE_URL must be https (http is only allowed for localhost).");
  }
  return { url: parsed.origin, anonKey: anonKey! };
}

export function requireSupabaseConfig(): SupabaseConfig {
  const c = readSupabaseConfig();
  if (!c) throw new ConfigError("Supabase is not configured.");
  return c;
}

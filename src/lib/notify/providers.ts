import "server-only";
import { getEnv, type Env } from "../env";

// Email is the one outside channel, and it is optional. It needs EMAIL_PROVIDER, a key, a verified From address AND
// NOTIFICATIONS_ENABLE_SENDING=true. Without all four, nothing is ever sent: the delivery is recorded as skipped with the
// reason. Tests inject their own provider and never reach this file's network call.

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string; retryable: boolean };

export interface EmailProvider {
  name: string;
  /**
   * `idempotencyKey` is stable for one delivery attempt: if the process dies after the email went out but before that was
   * recorded, the retry carries the SAME key, so the provider can drop the duplicate instead of mailing the person twice.
   */
  send(to: string, subject: string, text: string, idempotencyKey?: string): Promise<SendResult>;
}

export function emailStatus(env: Env = getEnv()): { configured: boolean; reason: string } {
  if (env.EMAIL_PROVIDER === "none") return { configured: false, reason: "No email provider is configured (EMAIL_PROVIDER=none)." };
  const missing = (["EMAIL_API_KEY", "EMAIL_FROM"] as const).filter((k) => !env[k]);
  if (missing.length) return { configured: false, reason: `EMAIL_PROVIDER is set but ${missing.join(", ")} is not.` };
  if (env.NOTIFICATIONS_ENABLE_SENDING !== "true") return { configured: false, reason: "Real sending is switched off (set NOTIFICATIONS_ENABLE_SENDING=true to allow it)." };
  return { configured: true, reason: "Email provider configured (not verified by this check)." };
}

/** The configured email provider, or null. Never falls back to anything else. */
export function getEmailProvider(): EmailProvider | null {
  const env = getEnv();
  if (!emailStatus(env).configured) return null;
  const key = env.EMAIL_API_KEY!;
  const from = env.EMAIL_FROM!;
  return {
    name: "resend",
    async send(to, subject, text, idempotencyKey) {
      let res: Response;
      try {
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          // Resend remembers an Idempotency-Key for 24 hours (max 256 characters) and uses it to prevent duplicated emails
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {}) },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "The email service timed out." : "Could not reach the email service.", retryable: true };
      }
      if (res.ok) return { ok: true, id: ((await res.json().catch(() => null)) as { id?: string } | null)?.id ?? null };
      void res.body?.cancel().catch(() => {});
      // 429 and 5xx may work later; a 4xx (bad address, bad key, unverified sender) will not
      return { ok: false, error: `The email service refused it (HTTP ${res.status}).`, retryable: res.status === 429 || res.status >= 500 };
    },
  };
}

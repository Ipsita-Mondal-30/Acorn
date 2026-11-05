/** Tiny client helper for the JSON API: returns parsed JSON or throws with the server's error message. */
export const REQUEST_TIMEOUT_MS = 30_000;

export async function api<T>(url: string, init: { method: string; body?: unknown; form?: FormData; timeoutMs?: number }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: init.form ? undefined : { "content-type": "application/json" },
      body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      // a request that never answers must end in a visible error, not an endless "Saving…"
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))
      throw new Error("Acorn didn't answer in time. Reload the page to see whether it went through, then try again.");
    throw new Error("Couldn't reach Acorn. Check that the app is still running, then try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

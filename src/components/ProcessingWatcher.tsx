"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "./api";

const POLL_MS = 2_500;
const GIVE_UP_MS = 3 * 60_000;
/** A save is understood right after the reply; one still "pending" this long later lost its background run. */
const KICK_AFTER_MS = 10_000;

/**
 * Render this only while something on the page is pending or processing. It re-reads the page's server data until the
 * parent stops rendering it (everything finished), and gives up after a few minutes instead of polling forever.
 * `stalled` lists memories still "pending" (never started): each is nudged once through the same, atomic, process
 * endpoint a person would use with "Understand it now", so a restart between save and processing can't strand a save.
 */
export function ProcessingWatcher({ stalled = [] }: { stalled?: string[] }) {
  const router = useRouter();
  const kicked = useRef(new Set<string>());
  const stalledKey = stalled.join(",");

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) return clearInterval(timer);
      if (document.visibilityState === "visible") router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    const ids = stalledKey ? stalledKey.split(",") : [];
    const timers = ids
      .filter((id) => !kicked.current.has(id))
      .map((id) =>
        setTimeout(() => {
          kicked.current.add(id);
          api(`/api/memories/${id}`, { method: "POST", body: { op: "process" } })
            .catch(() => {}) // the memory records its own failure; the page shows it
            .finally(() => router.refresh());
        }, KICK_AFTER_MS),
      );
    return () => timers.forEach(clearTimeout);
  }, [stalledKey, router]);

  return null;
}

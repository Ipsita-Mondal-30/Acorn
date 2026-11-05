import { connection } from "next/server";
import { modeInfo } from "@/lib/env";

/** Always-visible honesty marker: which extraction backend is live right now. */
export async function ModeBadge() {
  await connection(); // env is runtime config, never bake it into the static shell
  const info = modeInfo();
  const tone =
    info.mode === "demo"
      ? "border-line bg-paper-deep text-ink-soft"
      : info.metaConfigured
        ? "border-moss/30 bg-moss-soft text-moss-ink"
        : "border-amber/40 bg-amber-soft text-amber-ink";
  const dot = info.mode === "demo" ? "bg-ink-faint" : info.metaConfigured ? "bg-moss" : "bg-amber";
  return (
    <p
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium ${tone}`}
      title={`Extraction model: ${info.extractionModel}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {info.label}
    </p>
  );
}

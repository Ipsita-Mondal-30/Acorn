import type { Artifact } from "@/lib/artifacts";
import { Tag } from "./ui";

/** Who made this, how it went. Mock output is never presented as a Meta result. */
export function ModelNote({ a, label }: { a: Pick<Artifact, "provider" | "model" | "latencyMs" | "usage" | "attempts" | "status">; label?: string }) {
  const real = a.provider === "meta";
  const secs = a.latencyMs ? `${(a.latencyMs / 1000).toFixed(1)} s` : null;
  const tokens = a.usage ? `${a.usage.promptTokens.toLocaleString("en-US")} in / ${a.usage.completionTokens.toLocaleString("en-US")} out tokens` : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint" data-testid="model-note">
      {real ? <Tag tone="lav">Powered by Meta {a.model}</Tag> : <Tag tone="amber">Demo stand-in · not a Meta model result</Tag>}
      {label && <span>{label}</span>}
      {secs && <span>{secs}</span>}
      {tokens && <span>{tokens}</span>}
      {a.attempts > 1 && <span>{a.attempts} attempts</span>}
    </p>
  );
}

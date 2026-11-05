import type { ContentType, Memory } from "@/lib/schema";

export const TYPE_LABEL: Record<ContentType, string> = {
  job: "Job",
  recipe: "Recipe",
  technical: "Technical",
  article: "Article",
  person: "Person",
  idea: "Idea",
  deadline: "Deadline",
  event: "Event",
  product: "Product",
  note: "Note",
  other: "Other",
};

export function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function sourceLabel(m: Memory): string {
  if (m.source.kind === "url") return domainOf(m.source.url) ?? "Link";
  if (m.source.kind === "image") return m.isSample && !m.source.fileName ? "Screenshot" : "Image";
  return "Note";
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(iso: string, now: Date): string {
  const s = (new Date(iso).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return formatDate(iso.slice(0, 10));
}

/** Whole days from today (local calendar) to a YYYY-MM-DD date. */
export function daysUntil(date: string, now: Date): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

export function daysLeftLabel(days: number): string {
  if (days < -1) return `${-days} days ago`;
  if (days === -1) return "Yesterday";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export function formatDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

/** Only http(s) links are ever rendered as hrefs — extracted or stored URLs could be `javascript:`. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

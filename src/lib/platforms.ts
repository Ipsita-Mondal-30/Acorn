// Sites whose posts need a signed-in session. A link to one is just a link: Acorn can't see the post, and must
// never imply it did. (A private Instagram reel or LinkedIn post fetched anonymously returns a login wall.)
const WALLED: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, "Facebook"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)(x|twitter)\.com$/, "X"],
];

/** Platform name when the URL is on a sign-in-walled site, else null. */
export function walledPlatform(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return WALLED.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

export const walledNote = (platform: string) =>
  `${platform} posts need a sign-in, so Acorn can't see this one. It only has the link${"" } and anything you typed with it.`;

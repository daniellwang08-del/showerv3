/** Pull unique http(s) job links from pasted text (newline / whitespace / punctuation separated). */
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`）\]}>，。；、]+/gi;

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/g, '');
}

export function extractHttpUrlsFromText(text: string): string[] {
  if (!text?.trim()) return [];
  const found = text.match(HTTP_URL_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const url = stripTrailingPunct(raw.trim());
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

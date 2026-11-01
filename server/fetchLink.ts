const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|m3u8)(\?|$)/i;
const MAX_CHARS = 6000;

export interface LinkText {
  url: string;
  text: string;
}

function eligible(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) && !SKIP_HOSTS.test(u.hostname) && !MEDIA_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

async function fetchOne(url: string): Promise<LinkText | null> {
  try {
    const proc = Bun.spawn(["curl_chrome", "-sL", "--max-time", "15", url], { stdout: "pipe", stderr: "ignore" });
    const [body, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const text = htmlToText(body);
    return text ? { url, text } : null;
  } catch {
    return null;
  }
}

export async function fetchLinks(links: string[]): Promise<LinkText[]> {
  const urls = [...new Set(links)].filter(eligible).slice(0, 3);
  const results = await Promise.all(urls.map(fetchOne));
  return results.filter((r): r is LinkText => r !== null);
}

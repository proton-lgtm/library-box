export const RELEASES_URL = "https://github.com/proton-lgtm/library-box/releases";
export const RELEASE_API = "https://api.github.com/repos/proton-lgtm/library-box/releases";
export const RELEASE_CACHE_SECONDS = 900;
const FALLBACK_TAG = "v0.1.3";

type DownloadKind = "windows-installer" | "windows-portable" | "linux-appimage" | "linux-deb" | "macos-dmg";
export type DownloadAsset = {
  name: string;
  url: string;
  kind: DownloadKind;
  architecture: string;
};
export type DesktopRelease = { tag: string | null; url: string; assets: DownloadAsset[] };
type CachedFetch = (input: string, init: RequestInit & { next: { revalidate: number } }) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableTag(value: unknown): value is string {
  if (typeof value !== "string" || !/^v\d+\.\d+\.\d+$/.test(value)) return false;
  const [major, minor, patch] = value.slice(1).split(".").map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && (major > 0 || minor > 1 || (minor === 1 && patch >= 3));
}

function architecture(name: string) {
  if (/(?:^|[-_. ])universal(?:[-_. ]|$)/i.test(name)) return "Universal (Intel + Apple silicon)";
  if (/(?:^|[-_. ])(?:arm64|aarch64)(?:[-_. ]|$)/i.test(name)) return "ARM64";
  if (/(?:^|[-_. ])(?:x64|x86_64|amd64)(?:[-_. ]|$)/i.test(name)) return "x64 (Intel / AMD)";
  if (/(?:^|[-_. ])(?:ia32|x86|i386|i686)(?:[-_. ]|$)/i.test(name)) return "x86 (32-bit)";
  return "Architecture not specified";
}

function assetKind(name: string): DownloadKind | null {
  if (!/^playmart[-_ ]/i.test(name)) return null;
  if (/\.exe$/i.test(name)) {
    if (/(?:^|[-_ ])portable(?:[-_. ]|$)/i.test(name)) return "windows-portable";
    if (/(?:^|[-_ ])(?:setup|installer)(?:[-_. ]|$)/i.test(name)) return "windows-installer";
    return null;
  }
  if (/\.AppImage$/i.test(name)) return "linux-appimage";
  if (/\.deb$/i.test(name)) return "linux-deb";
  if (/\.dmg$/i.test(name)) return "macos-dmg";
  return null;
}

export function parseDesktopRelease(value: unknown): DesktopRelease | null {
  if (!record(value) || value.draft !== false || value.prerelease !== false || !stableTag(value.tag_name)
    || typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))
    || value.html_url !== `${RELEASES_URL}/tag/${value.tag_name}` || !Array.isArray(value.assets)) return null;

  const assets: DownloadAsset[] = [];
  const seen = new Set<string>();
  for (const asset of value.assets) {
    if (!record(asset) || asset.state !== "uploaded" || typeof asset.size !== "number" || asset.size <= 0
      || typeof asset.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._ ()+-]*$/.test(asset.name)
      || typeof asset.browser_download_url !== "string" || seen.has(asset.name)) continue;
    const kind = assetKind(asset.name);
    if (!kind) continue;
    try {
      const url = new URL(asset.browser_download_url);
      const prefix = `${RELEASES_URL}/download/${value.tag_name}/`;
      if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(new URL(prefix).pathname)
        || decodeURIComponent(url.pathname.slice(new URL(prefix).pathname.length)) !== asset.name
        || asset.browser_download_url !== url.href) continue;
      seen.add(asset.name);
      assets.push({ name: asset.name, url: asset.browser_download_url, kind, architecture: architecture(asset.name) });
    } catch { continue; }
  }
  return { tag: value.tag_name, url: value.html_url, assets };
}

export async function getDesktopRelease({ fetch = globalThis.fetch, timeoutMs = 4000 }: {
  fetch?: CachedFetch;
  timeoutMs?: number;
} = {}): Promise<DesktopRelease> {
  for (const endpoint of ["latest", `tags/${FALLBACK_TAG}`]) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const release = await Promise.race([
        (async () => {
          const response = await fetch(`${RELEASE_API}/${endpoint}`, {
            headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
            redirect: "error",
            next: { revalidate: RELEASE_CACHE_SECONDS },
            signal: controller.signal,
          });
          return response.ok ? parseDesktopRelease(await response.json()) : null;
        })(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
        }),
      ]);
      if (release) return release;
    } catch {
      // Public API outages and rate limits must not prevent rendering the page.
    } finally {
      clearTimeout(timer);
    }
  }
  return { tag: null, url: RELEASES_URL, assets: [] };
}

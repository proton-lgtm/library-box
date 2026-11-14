import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopRelease, parseDesktopRelease, RELEASE_API, RELEASE_CACHE_SECONDS, RELEASES_URL } from "../src/lib/releases.ts";

function asset(name: string, tag = "v0.1.3") {
  return { name, state: "uploaded", size: 1234, browser_download_url: `${RELEASES_URL}/download/${tag}/${encodeURIComponent(name)}` };
}
function release(assets: unknown[] = [], tag = "v0.1.3") {
  return { tag_name: tag, html_url: `${RELEASES_URL}/tag/${tag}`, draft: false, prerelease: false, published_at: "2026-11-13T12:48:00Z", assets };
}

test("discovers actual Windows v0.1.3 assets without inventing Linux or macOS downloads", () => {
  const result = parseDesktopRelease(release([asset("Playmart-0.1.3-setup.exe"), asset("Playmart-0.1.3-portable.exe")]));
  assert.deepEqual(result?.assets.map(({ kind }) => kind), ["windows-installer", "windows-portable"]);
  assert.equal(result?.assets[0].url, asset("Playmart-0.1.3-setup.exe").browser_download_url);
  assert.equal(result?.assets[0].architecture, "Architecture not specified");
});

test("recognizes published packages and explicit architectures, ignoring updater metadata", () => {
  const result = parseDesktopRelease(release([
    ...["Playmart-0.1.3-x64.AppImage", "Playmart_0.1.3_amd64.deb", "Playmart-0.1.3-arm64.dmg", "Playmart-0.1.3-x64.dmg", "Playmart-0.1.3-universal.dmg", "Playmart-0.1.3-ia32-setup.exe"].map((name) => asset(name)),
    asset("latest.yml"), asset("Playmart-0.1.3-setup.exe.blockmap"), asset("Other-0.1.3.dmg"), asset("Playmart-0.1.3.exe"),
  ]));
  assert.deepEqual(result?.assets.map(({ kind, architecture }) => [kind, architecture]), [
    ["linux-appimage", "x64 (Intel / AMD)"], ["linux-deb", "x64 (Intel / AMD)"], ["macos-dmg", "ARM64"],
    ["macos-dmg", "x64 (Intel / AMD)"], ["macos-dmg", "Universal (Intel + Apple silicon)"], ["windows-installer", "x86 (32-bit)"],
  ]);
});

test("rejects unpublished, prerelease, old, malformed and foreign releases", () => {
  for (const value of [null, [], {}, release([], "v0.1.2"), release([], "v0.0.99"), release([], "v0.1.3-beta"),
    { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), published_at: null },
    { ...release(), html_url: "https://github.com/other/repo/releases/tag/v0.1.3" }, { ...release(), assets: null }]) {
    assert.equal(parseDesktopRelease(value), null);
  }
  for (const tag of ["v0.1.3", "v0.1.4", "v0.2.0", "v1.0.0"]) assert.equal(parseDesktopRelease(release([], tag))?.tag, tag);
});

test("rejects unsafe, mismatched, incomplete and duplicate asset links", () => {
  const valid = asset("Playmart-0.1.3-setup.exe");
  const unsafeUrls = ["javascript:alert(1)", valid.browser_download_url.replace("https:", "http:"),
    valid.browser_download_url.replace("github.com", "github.com.evil.example"), valid.browser_download_url.replace("github.com", "user:pass@github.com"),
    valid.browser_download_url.replace("library-box", "other"), valid.browser_download_url.replace("download/v0.1.3", "download/v0.1.4"),
    `${valid.browser_download_url}?redirect=evil`, `${valid.browser_download_url}#fragment`, `${valid.browser_download_url}/extra`,
    valid.browser_download_url.replace("setup.exe", "portable.exe")];
  const result = parseDesktopRelease(release([
    ...unsafeUrls.map((browser_download_url) => ({ ...valid, browser_download_url })),
    { ...valid, state: "new" }, { ...valid, size: 0 }, { ...valid, name: "../Playmart-setup.exe" }, valid, valid,
  ]));
  assert.deepEqual(result?.assets, [{ name: valid.name, url: valid.browser_download_url, kind: "windows-installer", architecture: "Architecture not specified" }]);
});

test("fetches latest server-side with revalidation, bounded signal and no redirects or credentials", async () => {
  const result = await getDesktopRelease({ fetch: async (input, init) => {
    assert.equal(input, `${RELEASE_API}/latest`);
    assert.deepEqual(init.next, { revalidate: RELEASE_CACHE_SECONDS });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return Response.json(release([asset("Playmart-0.2.0-x64.dmg", "v0.2.0")], "v0.2.0"));
  } });
  assert.equal(result.tag, "v0.2.0");
});

test("falls back to v0.1.3 on latest errors or invalid metadata", async () => {
  for (const failure of [new Response(null, { status: 403 }), Response.json(release([], "v0.1.2")), new Response("bad json")]) {
    const calls: string[] = [];
    const result = await getDesktopRelease({ fetch: async (input) => {
      calls.push(input);
      return calls.length === 1 ? failure : Response.json(release([asset("Playmart-0.1.3-setup.exe")]));
    } });
    assert.deepEqual(calls, [`${RELEASE_API}/latest`, `${RELEASE_API}/tags/v0.1.3`]);
    assert.equal(result.tag, "v0.1.3");
  }
});

test("does not mix old assets into a newer release missing a platform", async () => {
  let calls = 0;
  const result = await getDesktopRelease({ fetch: async () => { calls++; return Response.json(release([], "v0.2.0")); } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { tag: "v0.2.0", url: `${RELEASES_URL}/tag/v0.2.0`, assets: [] });
});

test("outages, malformed fallback and hung requests yield a truthful release-page fallback", async () => {
  for (const fetch of [async () => { throw new Error("offline"); }, async () => Response.json({}), async () => new Promise<Response>(() => {})]) {
    assert.deepEqual(await getDesktopRelease({ fetch, timeoutMs: 5 }), { tag: null, url: RELEASES_URL, assets: [] });
  }
});

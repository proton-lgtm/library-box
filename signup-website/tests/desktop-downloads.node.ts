import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { DesktopRelease } from "../src/lib/releases.ts";
import { RELEASES_URL } from "../src/lib/releases.ts";

// Use the existing compiler to render this server-only TSX component in Node's test runner.
const source = readFileSync(new URL("../src/components/desktop-downloads.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports: { DesktopDownloads?: (props: { release: DesktopRelease }) => ReturnType<typeof createElement> } = {};
runInNewContext(compiled, { exports, require: createRequire(import.meta.url) });
const DesktopDownloads = exports.DesktopDownloads!;

function render(release: DesktopRelease) {
  return renderToStaticMarkup(createElement(DesktopDownloads, { release }));
}

test("server-rendered downloads show only published assets and truthful per-format fallbacks", () => {
  const url = `${RELEASES_URL}/download/v0.1.3/Playmart-0.1.3-setup.exe`;
  const html = render({ tag: "v0.1.3", url: `${RELEASES_URL}/tag/v0.1.3`, assets: [
    { kind: "windows-installer", name: "Playmart-0.1.3-setup.exe", url, architecture: "Architecture not specified" },
  ] });
  assert.ok(html.includes(`href="${url}"`));
  assert.ok(html.includes("Download Installer (.exe)"));
  assert.equal((html.match(/Not published in this release\./g) || []).length, 4);
  assert.equal((html.match(/Check release files/g) || []).length, 4);
  assert.ok(!html.includes("Download AppImage"));
  assert.ok(!html.includes("<form"));
  assert.ok(!html.includes("<input"));
});

test("unconfirmed API availability is never described as a published or missing package", () => {
  const html = render({ tag: null, url: RELEASES_URL, assets: [] });
  assert.ok(html.includes("Release availability could not be checked."));
  assert.ok(html.includes(`href="${RELEASES_URL}"`));
  assert.equal((html.match(/Availability unconfirmed\./g) || []).length, 5);
  assert.ok(!html.includes("Not published"));
  assert.ok(!html.includes('class="download-button"'));
});

test("macOS links distinguish Apple silicon, Intel and universal packages", () => {
  const html = render({ tag: "v0.2.0", url: `${RELEASES_URL}/tag/v0.2.0`, assets: [
    { kind: "macos-dmg", name: "Playmart-arm64.dmg", url: `${RELEASES_URL}/download/v0.2.0/Playmart-arm64.dmg`, architecture: "ARM64" },
    { kind: "macos-dmg", name: "Playmart-x64.dmg", url: `${RELEASES_URL}/download/v0.2.0/Playmart-x64.dmg`, architecture: "x64 (Intel / AMD)" },
    { kind: "macos-dmg", name: "Playmart-universal.dmg", url: `${RELEASES_URL}/download/v0.2.0/Playmart-universal.dmg`, architecture: "Universal (Intel + Apple silicon)" },
  ] });
  for (const text of ["Apple silicon (ARM64)", "Intel (x64)", "Universal (Intel + Apple silicon)"]) assert.ok(html.includes(text));
  assert.equal((html.match(/class="download-button"/g) || []).length, 3);
});

test("landing page uses release discovery instead of legacy signup dependencies", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /await getDesktopRelease\(\)/);
  assert.match(page, /<DesktopDownloads release=\{release\}/);
  assert.doesNotMatch(page, /WaitlistForm|getWaitlistCount|process\.env|lib\/waitlist/);
});

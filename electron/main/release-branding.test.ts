import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopUserDataPath, portableUserDataPath } from "./portable-path";

const require = createRequire(import.meta.url);
const { releaseVersion, setReleaseVersion } = require("../../scripts/release-metadata.cjs") as {
  releaseVersion: (tag: string | undefined) => string;
  setReleaseVersion: (directory: string, tag: string) => string;
};
const directories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "playmart-release-"));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("release versions", () => {
  it.each([["v0.1.2", "0.1.2"], ["1.2.3", "1.2.3"], ["v2.0.0-beta.1", "2.0.0-beta.1"], ["v1.2.3+build.4", "1.2.3+build.4"]])("uses tag %s", (tag, expected) => {
    expect(releaseVersion(tag)).toBe(expected);
  });
  it.each([undefined, "", "v1.2", "v01.2.3", "v1.2.3-01", "v1.2.3\n", "v1.2.3;evil", "latest"])("rejects invalid tags %s", (tag) => {
    expect(() => releaseVersion(tag)).toThrow("semantic version");
  });
  it("updates both manifests without changing package identity or dependencies", () => {
    const directory = temporaryDirectory();
    const manifest = { name: "playmart", version: "0.1.0", dependencies: { example: "^1.0.0" } };
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ name: "playmart", version: "0.1.0", lockfileVersion: 3, packages: { "": manifest } }));
    expect(setReleaseVersion(directory, "v0.1.2")).toBe("0.1.2");
    expect(JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))).toEqual({ ...manifest, version: "0.1.2" });
    const lock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("0.1.2");
    expect(lock.packages[""].version).toBe("0.1.2");
    expect(() => setReleaseVersion(directory, "bad-tag")).toThrow();
    expect(JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))).toEqual({ ...manifest, version: "0.1.2" });
  });
});

describe("Playmart data paths", () => {
  it("always uses Playmart desktop storage regardless of older folders", () => {
    const directory = temporaryDirectory();
    mkdirSync(path.join(directory, "game-library"));
    mkdirSync(path.join(directory, "Library"));
    expect(desktopUserDataPath(directory)).toBe(path.join(directory, "Playmart"));
  });
  it("always uses Playmart Data for portable storage", () => {
    const directory = temporaryDirectory();
    mkdirSync(path.join(directory, "Library Data"));
    expect(portableUserDataPath(directory)).toBe(path.join(directory, "Playmart Data"));
  });
});

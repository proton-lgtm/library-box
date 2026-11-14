import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { validateEnvironment, releaseChannel, updateMetadataNames, macSigningEnvironment, packageNative, extractorPath, verifyPackagedExtractor, stageAssets, publishAssets } = require("./release-ci.cjs");
const yaml = createRequire(require.resolve("app-builder-lib"))("js-yaml");
const directories: string[] = [];
function fixture(version = "1.2.3") {
  const root = mkdtempSync(path.join(process.cwd(), ".release-ci-test-"));
  directories.push(root);
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const platforms = {
    "windows-x64": ["Playmart-1.2.3-x64-portable.exe", "Playmart-1.2.3-x64-setup.exe", "Playmart-1.2.3-x64-setup.exe.blockmap", "latest.yml"],
    "linux-x64": ["Playmart-1.2.3-x64.AppImage", "Playmart-1.2.3-x64.deb", "latest-linux.yml"],
    "macos-arm64": ["Playmart-1.2.3-arm64.dmg", "Playmart-1.2.3-arm64.zip", "Playmart-1.2.3-arm64.zip.blockmap", "latest-mac.yml"],
    "macos-x64": ["Playmart-1.2.3-x64.dmg", "Playmart-1.2.3-x64.zip", "Playmart-1.2.3-x64.zip.blockmap", "latest-mac.yml"],
  };
  for (const [platform, baseNames] of Object.entries(platforms)) {
    const names = baseNames.map((name) => name.replace("1.2.3", version).replace("latest", releaseChannel(version)));
    const directory = path.join(input, platform);
    mkdirSync(directory, { recursive: true });
    for (const name of names.filter((name) => !name.endsWith(".yml"))) writeFileSync(path.join(directory, name), name);
    const url = names.find((name) => /setup.*\.exe$|\.AppImage$|\.zip$/.test(name))!;
    const bytes = readFileSync(path.join(directory, url));
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    writeFileSync(path.join(directory, names.at(-1)!), yaml.dump({
      version, files: [{ url, sha512, size: bytes.length }], path: url, sha512, releaseDate: "2026-11-14T00:00:00.000Z",
    }));
  }
  return { input, output };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function mockGitHub(directory: string, options: { exists?: boolean; draft?: boolean; prerelease?: boolean; failUpload?: boolean; omitAsset?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "view" && args.at(-1) === "isDraft,isPrerelease") {
      if (options.exists === false) throw new Error("not found");
      return JSON.stringify({ isDraft: options.draft ?? false, isPrerelease: options.prerelease ?? false });
    }
    if (args[1] === "upload" && options.failUpload) throw new Error("upload failed");
    if (args[1] === "view" && args.at(-1) === "assets") {
      const names = readdirSync(directory);
      if (options.omitAsset) names.pop();
      return JSON.stringify({ assets: names.map((name) => ({ name, size: statSync(path.join(directory, name)).size })) });
    }
    return "";
  };
  return { calls, run };
}
const sha = "a".repeat(40);

describe("release CI staging", () => {
  it("merges both macOS architectures and retains the x64 legacy fallback", () => {
    const { input, output } = fixture();
    const names = stageAssets(input, output, "1.2.3");
    const metadata = yaml.load(readFileSync(path.join(output, "latest-mac.yml"), "utf8"));
    expect(metadata.files.map((file: { url: string }) => file.url)).toEqual(["Playmart-1.2.3-x64.zip", "Playmart-1.2.3-arm64.zip"]);
    expect(metadata.path).toBe("Playmart-1.2.3-x64.zip");
    expect(names).toHaveLength(14);
    expect(readdirSync(output)).toHaveLength(14);
  });
  it.each(["Playmart-1.2.3-arm64.zip", "Playmart-1.2.3-arm64.zip.blockmap", "latest-mac.yml"])("rejects an incomplete mac release without %s", (name) => {
    const { input, output } = fixture();
    rmSync(path.join(input, "macos-arm64", name));
    expect(() => stageAssets(input, output, "1.2.3")).toThrow("missing");
  });
  it("verifies updater asset hashes before staging", () => {
    const { input, output } = fixture();
    writeFileSync(path.join(input, "macos-arm64", "Playmart-1.2.3-arm64.zip"), "corrupt");
    expect(() => stageAssets(input, output, "1.2.3")).toThrow("integrity mismatch");
  });
  it("rejects metadata for another version", () => {
    const { input, output } = fixture();
    expect(() => stageAssets(input, output, "1.2.4")).toThrow("Invalid update metadata");
  });
  it("rejects binary filename collisions rather than overwriting another architecture", () => {
    const { input, output } = fixture();
    writeFileSync(path.join(input, "macos-arm64", "Playmart-1.2.3-x64.dmg"), "collision");
    expect(() => stageAssets(input, output, "1.2.3")).toThrow("filename collision");
  });
  it("merges additional updater channels as well as latest", () => {
    const { input, output } = fixture();
    for (const platform of ["macos-arm64", "macos-x64"]) {
      writeFileSync(path.join(input, platform, "beta-mac.yml"), readFileSync(path.join(input, platform, "latest-mac.yml")));
    }
    stageAssets(input, output, "1.2.3");
    expect(yaml.load(readFileSync(path.join(output, "beta-mac.yml"), "utf8")).files).toHaveLength(2);
  });
});

describe("installed electron-builder metadata compatibility", () => {
  it.each(["1.2.3", "1.2.3-beta.1"])("stages real builder-generated %s metadata including DMGs without size", async (version) => {
    const { input, output } = fixture(version);
    const { createUpdateInfoTasks, writeUpdateInfoFiles } = require("app-builder-lib/out/publish/updateInfoBuilder");
    const { Platform } = require("app-builder-lib");
    const { Arch } = require("builder-util");
    const manifest = require("../package.json");
    for (const platform of ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"]) {
      const directory = path.join(input, platform);
      const os = platform.startsWith("windows") ? Platform.WINDOWS : platform.startsWith("linux") ? Platform.LINUX : Platform.MAC;
      const nativeConfig = manifest.build[os.buildConfigurationKey];
      const packager = {
        platform: os, appInfo: { version }, config: manifest.build,
        platformSpecificBuildOptions: nativeConfig,
        info: { metadata: { dependencies: manifest.dependencies } },
        getResource: async () => null,
        emitArtifactCreated: async () => undefined,
      };
      const tasks = [];
      for (const name of readdirSync(directory).filter((name) => /setup\.exe$|\.AppImage$|\.zip$|\.dmg$/.test(name))) {
        const file = path.join(directory, name);
        const bytes = readFileSync(file);
        const updateInfo = name.endsWith(".dmg") ? undefined : {
          size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64"), blockMapSize: 20,
        };
        tasks.push(...await createUpdateInfoTasks({
          packager, target: { outDir: directory }, file,
          arch: platform.endsWith("arm64") ? Arch.arm64 : Arch.x64,
          updateInfo,
        }, [{ ...manifest.build.publish, channel: releaseChannel(version) }]));
      }
      await writeUpdateInfoFiles(tasks, packager);
    }
    stageAssets(input, output, version);
    const channel = releaseChannel(version);
    const mac = yaml.load(readFileSync(path.join(output, `${channel}-mac.yml`), "utf8"));
    expect(mac.files.filter((file: { url: string }) => file.url.endsWith(".dmg"))).toHaveLength(2);
    expect(mac.files.filter((file: { url: string }) => file.url.endsWith(".zip"))).toHaveLength(2);
    expect(mac.files.find((file: { url: string }) => file.url.endsWith(".dmg")).size).toBeUndefined();
    expect(readdirSync(output).some((name) => name.endsWith(".AppImage.blockmap"))).toBe(false);
  }, 20000);
  it.each([["v1.2.3", "latest"], ["v1.2.3-beta.1", "beta"], ["v1.2.3-rc-test.1+build.2", "rc-test"]])("explicitly configures the GitHub metadata channel for %s", (tag, channel) => {
    let actual: string[] = [];
    packageNative(["--linux", "AppImage", "deb", "--x64"], { RELEASE_TAG: tag }, "linux", (_command: string, args: string[]) => {
      actual = args;
      return { status: 0 };
    });
    expect(actual).toContain(`-c.publish.channel=${channel}`);
    expect(actual.slice(-2)).toEqual(["--publish", "never"]);
  });
});

describe("release CI publishing", () => {
  it("creates a draft, uploads binaries before metadata, verifies uploads and only then publishes", () => {
    const { input, output } = fixture();
    stageAssets(input, output, "1.2.3");
    const { calls, run } = mockGitHub(output, { exists: false });
    publishAssets(output, "v1.2.3", sha, run);
    expect(calls[1]).toContain("--draft");
    const uploads = calls.filter((args) => args[1] === "upload");
    expect(uploads).toHaveLength(2);
    expect(uploads[0].slice(3, -1).every((name) => !name.endsWith(".yml"))).toBe(true);
    expect(uploads[1].slice(3, -1).every((name) => name.endsWith(".yml"))).toBe(true);
    expect(calls.at(-2)?.at(-1)).toBe("assets");
    expect(calls.at(-1)).toEqual(["release", "edit", "v1.2.3", "--draft=false", "--prerelease=false"]);
  });
  it.each([{ failUpload: true }, { omitAsset: true }])("never publishes an incomplete draft: %o", (options) => {
    const { input, output } = fixture();
    stageAssets(input, output, "1.2.3");
    const { calls, run } = mockGitHub(output, { exists: false, ...options });
    expect(() => publishAssets(output, "v1.2.3", sha, run)).toThrow();
    expect(calls.some((args) => args[1] === "edit")).toBe(false);
  });
  it("updates an existing published release without creating another release", () => {
    const { input, output } = fixture();
    stageAssets(input, output, "1.2.3");
    const { calls, run } = mockGitHub(output);
    publishAssets(output, "v1.2.3", sha, run);
    expect(calls.some((args) => ["create", "edit"].includes(args[1]))).toBe(false);
  });
  it.each(["1.2.3-alpha.1", "1.2.3-beta.1", "1.2.3-rc.2", "1.2.3-1.0"])("publishes %s with its channel metadata and prerelease flag", (version) => {
    const { input, output } = fixture(version);
    stageAssets(input, output, version);
    const { calls, run } = mockGitHub(output, { exists: false });
    publishAssets(output, `v${version}`, sha, run);
    expect(calls[1]).toContain("--prerelease");
    expect(calls.at(-1)).toContain("--prerelease=true");
    expect(updateMetadataNames(version).every((name: string) => readdirSync(output).includes(name))).toBe(true);
    expect(readdirSync(output)).not.toContain("latest.yml");
  });
  it("preserves an existing prerelease and repairs a misclassified draft", () => {
    const { input, output } = fixture("1.2.3-beta.1");
    stageAssets(input, output, "1.2.3-beta.1");
    const existing = mockGitHub(output, { prerelease: true });
    publishAssets(output, "v1.2.3-beta.1", sha, existing.run);
    expect(existing.calls.some((args) => args[1] === "edit")).toBe(false);
    const draft = mockGitHub(output, { draft: true, prerelease: false });
    publishAssets(output, "v1.2.3-beta.1", sha, draft.run);
    expect(draft.calls.at(-1)).toContain("--prerelease=true");
  });
});

describe("optional macOS signing", () => {
  it("removes absent or partial notarization credentials from unsigned builds", () => {
    const result = macSigningEnvironment({ APPLE_ID: "test-id", APPLE_TEAM_ID: "test-team", CSC_KEY_PASSWORD: "test-password" });
    expect(result.signed).toBe(false);
    expect(result.notarized).toBe(false);
    expect(result.env).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });
  it("signs when a certificate is supplied and skips incomplete notarization", () => {
    const result = macSigningEnvironment({ CSC_LINK: "test-certificate", CSC_KEY_PASSWORD: "test-password", APPLE_ID: "test-id" });
    expect(result.signed).toBe(true);
    expect(result.notarized).toBe(false);
    expect(result.env.CSC_LINK).toBe("test-certificate");
    expect(result.env.CSC_KEY_PASSWORD).toBe("test-password");
    expect(result.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
    expect(result.env.APPLE_ID).toBeUndefined();
  });
  it("passes a complete notarization set only for signed builds", () => {
    const env = { CSC_LINK: "test-certificate", APPLE_ID: "test-id", APPLE_APP_SPECIFIC_PASSWORD: "test-password", APPLE_TEAM_ID: "test-team" };
    const result = macSigningEnvironment(env);
    expect(result.notarized).toBe(true);
    expect(result.env).toMatchObject(env);
  });
  it("requires requested signing to succeed and never enables builder publishing", () => {
    let invocation: { args: string[]; env: Record<string, string> } | undefined;
    packageNative(["--mac", "dmg", "zip", "--arm64"], {
      CSC_LINK: "test-certificate", APPLE_ID: "test-id", APPLE_APP_SPECIFIC_PASSWORD: "test-password", APPLE_TEAM_ID: "test-team",
    }, "darwin", (_command: string, args: string[], options: { env: Record<string, string> }) => {
      invocation = { args, env: options.env };
      return { status: 0 };
    });
    expect(invocation?.args).toContain("-c.forceCodeSigning=true");
    expect(invocation?.args.slice(-2)).toEqual(["--publish", "never"]);
    expect(invocation?.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
  });
});

describe("native packaged extractors", () => {
  it.each([
    ["win32", "x64", ["win-unpacked", "resources"]],
    ["linux", "x64", ["linux-unpacked", "resources"]],
    ["darwin", "arm64", ["mac-arm64", "Playmart.app", "Contents", "Resources"]],
    ["darwin", "x64", ["mac", "Playmart.app", "Contents", "Resources"]],
  ] as const)("checks the %s %s unpacked binary without modifying signed app contents", (platform, arch, resourceParts) => {
    const { input } = fixture();
    const root = path.join(input, "packaged");
    const binary = extractorPath(path.join(root, ...resourceParts), platform, arch);
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "test binary", { mode: 0o755 });
    const before = statSync(binary).mode;
    const calls: unknown[] = [];
    expect(verifyPackagedExtractor(root, platform, arch, (...args: unknown[]) => { calls.push(args); return { status: 0 }; })).toBe(binary);
    expect(calls).toEqual([[binary, ["i"], { stdio: "inherit" }]]);
    expect(statSync(binary).mode).toBe(before);
    expect(() => verifyPackagedExtractor(root, platform, arch, () => ({ status: 1 }))).toThrow("could not execute");
  });
  it("rejects a missing packaged extractor", () => {
    const { input } = fixture();
    expect(() => verifyPackagedExtractor(input, "linux", "x64")).toThrow("found 0");
  });
});

describe("release CI configuration", () => {
  it("requires production public secrets without logging their values", () => {
    expect(() => validateEnvironment({})).toThrow("prod environment");
    expect(() => validateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://example.com", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public" })).toThrow("HTTPS");
    expect(() => validateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.com", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public" })).not.toThrow();
  });
  it("uses four native builds and a single dependent publisher with scoped write access", () => {
    const workflow = yaml.load(readFileSync(path.join(process.cwd(), ".github", "workflows", "release-windows.yml"), "utf8"));
    expect(workflow.permissions.contents).toBe("read");
    expect(workflow.jobs.build.strategy.matrix.include.map((entry: { platform: string }) => entry.platform)).toEqual(["windows-x64", "linux-x64", "macos-arm64", "macos-x64"]);
    expect(workflow.jobs.build.environment).toBe("prod");
    expect(workflow.jobs.publish.needs).toEqual(["prepare", "build"]);
    expect(workflow.jobs.publish.permissions.contents).toBe("write");
    const packaging = workflow.jobs.build.steps.find((step: { name: string }) => step.name?.startsWith("Package native"));
    expect(packaging.run).toContain("release-ci.cjs package");
    expect(packaging.env.CSC_LINK).toContain("secrets.CSC_LINK");
    expect(packaging.env.APPLE_APP_SPECIFIC_PASSWORD).toContain("secrets.APPLE_APP_SPECIFIC_PASSWORD");
    expect(workflow.jobs.build.steps.some((step: { run?: string }) => step.run === "node scripts/release-ci.cjs prepare-extractor")).toBe(true);
    expect(workflow.jobs.build.steps.some((step: { run?: string }) => step.run === "node scripts/release-ci.cjs verify-extractor release")).toBe(true);
  });
});

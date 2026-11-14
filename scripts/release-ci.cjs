const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { releaseVersion } = require("./release-metadata.cjs");

const repository = "proton-lgtm/library-box";
const platforms = ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"];

function validateEnvironment(env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url?.trim() || !key?.trim()) {
    throw new Error("Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the prod environment before releasing.");
  }
  if (new URL(url).protocol !== "https:" || /\s/.test(key)) {
    throw new Error("The prod Supabase URL must use HTTPS and its public publishable key must not contain whitespace.");
  }
}

function releaseChannel(tag) {
  const version = releaseVersion(tag);
  const prerelease = version.split("+")[0].split("-").slice(1).join("-");
  return prerelease ? prerelease.split(".")[0] : "latest";
}

function updateMetadataNames(tag) {
  const channel = releaseChannel(tag);
  return [`${channel}.yml`, `${channel}-linux.yml`, `${channel}-mac.yml`];
}

function macSigningEnvironment(env) {
  const result = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  const credentials = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  for (const name of credentials) delete result[name];
  const signed = Boolean(env.CSC_LINK?.trim());
  const notarized = signed && ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].every((name) => env[name]?.trim());
  if (signed) {
    result.CSC_LINK = env.CSC_LINK;
    if (env.CSC_KEY_PASSWORD) result.CSC_KEY_PASSWORD = env.CSC_KEY_PASSWORD;
    result.CSC_IDENTITY_AUTO_DISCOVERY = "true";
  }
  if (notarized) {
    for (const name of credentials.slice(2)) result[name] = env[name];
  }
  return { env: result, signed, notarized };
}

function packageNative(args, env = process.env, platform = process.platform, run = spawnSync) {
  let buildEnv = env;
  if (platform === "darwin") {
    const signing = macSigningEnvironment(env);
    buildEnv = signing.env;
    if (signing.signed) args = [...args, "-c.forceCodeSigning=true"];
    else console.log("::warning::macOS packages lack Developer ID signing. Downloads are usable, but electron-updater cannot install macOS updates. Configure prod CSC_LINK and CSC_KEY_PASSWORD for signed releases.");
    if (!signing.notarized) console.log("::warning::macOS notarization is disabled. Provide signing credentials plus prod APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize.");
  }
  const channel = releaseChannel(env.RELEASE_TAG || require("../package.json").version);
  const result = run(process.execPath, [require.resolve("electron-builder/cli.js"), ...args, `-c.publish.channel=${channel}`, "--publish", "never"], { env: buildEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Native packaging failed.");
}

function extractorPath(resources, platform = process.platform, arch = process.arch) {
  const directory = { win32: "win", darwin: "mac", linux: "linux" }[platform];
  if (!directory) throw new Error(`Unsupported extractor platform: ${platform}`);
  return path.join(resources, "app.asar.unpacked", "node_modules", "7zip-bin", directory, arch, platform === "win32" ? "7za.exe" : "7za");
}

function verifyExtractor(extractor, platform = process.platform, run = spawnSync) {
  if (!fs.statSync(extractor).isFile()) throw new Error(`Packaged extractor is not a file: ${extractor}`);
  if (platform !== "win32") fs.accessSync(extractor, fs.constants.X_OK);
  const result = run(extractor, ["i"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native extractor could not execute: ${extractor}`);
}

function prepareExtractor() {
  const extractor = require("7zip-bin").path7za;
  if (process.platform !== "win32") fs.chmodSync(extractor, 0o755);
  verifyExtractor(extractor);
}

function verifyPackagedExtractor(directory, platform = process.platform, arch = process.arch, run = spawnSync) {
  const candidates = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(directory, entry.name);
    if (platform === "darwin") {
      for (const app of fs.readdirSync(root)) {
        if (app.endsWith(".app")) candidates.push(extractorPath(path.join(root, app, "Contents", "Resources"), platform, arch));
      }
    } else if (entry.name === (platform === "win32" ? "win-unpacked" : "linux-unpacked")) {
      candidates.push(extractorPath(path.join(root, "resources"), platform, arch));
    }
  }
  if (candidates.length !== 1) throw new Error(`Expected one native packaged extractor, found ${candidates.length}.`);
  // Never chmod the packaged app: changing signed bundle contents can invalidate its signature.
  verifyExtractor(candidates[0], platform, run);
  return candidates[0];
}

function stageAssets(input, output, version) {
  // Resolve the YAML parser from electron-builder's own declared dependencies.
  const yaml = createRequire(require.resolve("app-builder-lib"))("js-yaml");
  const assets = new Map();
  const metadata = new Map();
  const [windowsMetadata, linuxMetadata, macMetadata] = updateMetadataNames(version);
  for (const platform of platforms) {
    const directory = path.join(input, platform);
    const names = fs.readdirSync(directory);
    const channelMetadata = platform === "windows-x64" ? windowsMetadata : platform === "linux-x64" ? linuxMetadata : macMetadata;
    if (!names.includes(channelMetadata)) throw new Error(`${platform} is missing ${channelMetadata}`);
    // NSIS and macOS ZIP produce external blockmaps; AppImage embeds its blockmap.
    const required = platform === "windows-x64"
      ? [/portable.*\.exe$/i, /setup.*\.exe$/i, /\.exe\.blockmap$/i]
      : platform === "linux-x64"
        ? [/\.AppImage$/, /\.deb$/]
        : [/\.dmg$/, /\.zip$/, /\.zip\.blockmap$/];
    for (const pattern of required) {
      if (!names.some((name) => pattern.test(name))) throw new Error(`${platform} is missing ${pattern}`);
    }
    for (const name of names) {
      const source = path.join(directory, name);
      if (!fs.statSync(source).isFile()) throw new Error(`Unexpected artifact directory: ${source}`);
      if (/\.yml$/.test(name)) {
        const data = yaml.load(fs.readFileSync(source, "utf8"));
        if (data?.version !== version || !Array.isArray(data.files) || !data.files.length) {
          throw new Error(`Invalid update metadata: ${source}`);
        }
        const entries = metadata.get(name) ?? [];
        entries.push({ platform, data });
        metadata.set(name, entries);
      } else {
        if (!/\.(exe|dmg|zip|AppImage|deb|blockmap)$/.test(name)) throw new Error(`Unexpected release asset: ${name}`);
        if (assets.has(name)) throw new Error(`Release asset filename collision: ${name}`);
        assets.set(name, source);
      }
    }
  }
  for (const [name, entries] of metadata) {
    if (entries.length > 1 && (entries.length !== 2 || !entries.every(({ platform }) => platform.startsWith("macos-")))) {
      throw new Error(`Unexpected metadata collision: ${name}`);
    }
    // macOS shares one channel file. Keep both architectures; x64 is the legacy fallback.
    entries.sort((a, b) => Number(b.platform.endsWith("x64")) - Number(a.platform.endsWith("x64")));
    const merged = { ...entries[0].data, files: entries.flatMap(({ data }) => data.files) };
    const urls = new Set();
    for (const file of merged.files) {
      const assetName = decodeURIComponent(file.url);
      const source = assets.get(assetName);
      if (!source || urls.has(assetName)) throw new Error(`Missing or duplicate update asset: ${file.url}`);
      urls.add(assetName);
      const bytes = fs.readFileSync(source);
      // Builder metadata can omit size for non-differential assets such as DMGs.
      if ((file.size != null && file.size !== bytes.length) || file.sha512 !== crypto.createHash("sha512").update(bytes).digest("base64")) {
        throw new Error(`Update asset integrity mismatch: ${assetName}`);
      }
    }
    metadata.set(name, merged);
  }
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("Release staging directory must be empty.");
  fs.mkdirSync(output, { recursive: true });
  for (const [name, source] of assets) fs.copyFileSync(source, path.join(output, name));
  for (const [name, data] of metadata) fs.writeFileSync(path.join(output, name), yaml.dump(data, { lineWidth: -1 }));
  return [...assets.keys(), ...metadata.keys()];
}

function gh(args) {
  const result = spawnSync("gh", [...args, "--repo", repository], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `gh ${args[0]} ${args[1]} failed`);
  return result.stdout;
}

function publishAssets(directory, tag, sha, run = gh) {
  const version = releaseVersion(tag);
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A checked-out source commit SHA is required.");
  const names = fs.readdirSync(directory);
  const prerelease = version.split("+")[0].includes("-");
  if (!names.length || !updateMetadataNames(tag).every((name) => names.includes(name))) {
    throw new Error("The complete staged release is required before publishing.");
  }
  let release;
  try {
    release = JSON.parse(run(["release", "view", tag, "--json", "isDraft,isPrerelease"]));
  } catch {
    // Creation fails closed on auth/network errors or a conflicting existing release.
    const args = ["release", "create", tag, "--draft", "--target", sha, "--title", `Playmart ${tag}`, "--generate-notes"];
    if (prerelease) args.push("--prerelease");
    run(args);
    release = { isDraft: true, isPrerelease: prerelease };
  }
  for (const isMetadata of [false, true]) {
    const files = names.filter((name) => name.endsWith(".yml") === isMetadata).map((name) => path.resolve(directory, name));
    if (files.length) run(["release", "upload", tag, ...files, "--clobber"]);
  }
  const uploaded = JSON.parse(run(["release", "view", tag, "--json", "assets"])).assets;
  for (const name of names) {
    if (!uploaded.some((asset) => asset.name === name && asset.size === fs.statSync(path.join(directory, name)).size)) {
      throw new Error(`Release upload verification failed: ${name}`);
    }
  }
  if (release.isDraft || Boolean(release.isPrerelease) !== prerelease) {
    run(["release", "edit", tag, "--draft=false", `--prerelease=${prerelease}`]);
  }
}

if (require.main === module) {
  try {
    const [command, input, output] = process.argv.slice(2);
    if (command === "validate-env") validateEnvironment();
    else if (command === "prepare-extractor") prepareExtractor();
    else if (command === "verify-extractor") verifyPackagedExtractor(input);
    else if (command === "package") packageNative(process.argv.slice(3));
    else if (command === "stage") stageAssets(input, output, releaseVersion(process.env.RELEASE_TAG));
    else if (command === "publish") publishAssets(input, process.env.RELEASE_TAG, process.env.RELEASE_SHA);
    else throw new Error("Expected validate-env, prepare-extractor, verify-extractor <directory>, package <builder arguments>, stage <input> <output>, or publish <directory>.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateEnvironment, releaseChannel, updateMetadataNames, macSigningEnvironment, packageNative, extractorPath, verifyExtractor, verifyPackagedExtractor, stageAssets, publishAssets };

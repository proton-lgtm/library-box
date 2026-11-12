const fs = require("node:fs");
const path = require("node:path");

function releaseVersion(tag) {
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(tag ?? "");
  if (!match || match[0] !== tag || match[2]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) {
    throw new Error("Release tag must be a semantic version, for example v0.1.2 or v0.2.0-beta.1.");
  }
  return match[1];
}

function setReleaseVersion(directory, tag) {
  const version = releaseVersion(tag);
  const packagePath = path.join(directory, "package.json");
  const lockPath = path.join(directory, "package-lock.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  manifest.version = version;
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}

if (require.main === module) {
  try {
    const version = setReleaseVersion(process.cwd(), process.env.RELEASE_TAG);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${process.env.RELEASE_TAG}\n`);
    }
    console.log(`Building Playmart ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { releaseVersion, setReleaseVersion };

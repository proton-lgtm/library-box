const { app } = require("electron");
const { lstat, readdir, rm, unlink } = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

async function main() {
  app.setName("Playmart");
  app.setPath("userData", path.join(app.getPath("appData"), "Playmart"));
  await app.whenReady();

  const userDataPath = path.resolve(app.getPath("userData"));
  const appDataPath = path.resolve(app.getPath("appData"));
  const allowedNames = new Set(["Playmart"]);
  const folderName = path.basename(userDataPath);

  if (path.dirname(userDataPath) !== appDataPath || !allowedNames.has(folderName)) {
    throw new Error(`Refusing to clear unexpected Electron userData path: ${userDataPath}`);
  }

  const entries = await readdir(userDataPath, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) {
    console.log(`Electron storage does not exist: ${userDataPath}`);
    return;
  }

  const targets = entries.map((entry) => path.join(userDataPath, entry.name));
  if (targets.some((target) => path.dirname(path.resolve(target)) !== userDataPath)) {
    throw new Error("Refusing to clear a path outside the Electron userData folder.");
  }

  console.log(`This will clear Electron storage for "${app.getName()}":`);
  console.log(userDataPath);
  console.log("This includes the SQLite catalog/download database, SQLite WAL/SHM files, encrypted auth session, and Chromium cache/storage.");
  console.log("Installed game files in folders you selected are not removed.");

  if (process.argv.includes("--dry-run")) {
    console.log("Dry run: no files were removed.");
    return;
  }

  if (process.argv.includes("--yes")) {
    await clearTargets(userDataPath, targets);
    return;
  }

  if (!stdin.isTTY) {
    throw new Error("Confirmation is required. Run this command in a terminal or pass --yes.");
  }

  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question("Type CLEAR to permanently remove this app's Electron storage: ");
    if (answer !== "CLEAR") {
      console.log("Cancelled. No files were removed.");
      return;
    }
  } finally {
    prompt.close();
  }

  await clearTargets(userDataPath, targets);
}

async function clearTargets(userDataPath, targets) {
  for (const target of targets) {
    const details = await lstat(target);
    if (details.isSymbolicLink()) await unlink(target);
    else await rm(target, { recursive: true, force: false });
  }
  console.log(`Cleared Electron storage: ${userDataPath}`);
}

main()
  .catch((error) => {
    console.error(`Could not clear Electron storage: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => app.quit());

import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertUnlinkedPath, extractArchive, findGameRootInArchive, testArchive, validateArchive, type ExtractionProgressListener } from "../archive";
import { findGameLauncher } from "../launcher";

interface OriginalInstallation {
  gameId: number;
  installDir: string;
  gameRoot: string;
  archivePath: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertSafeTree(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The installation must contain only regular directories and files, not links.");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const details = await lstat(target);
    if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile()) ||
        (details.isFile() && details.nlink > 1)) {
      throw new Error("The installation contains a link or a non-regular file.");
    }
    if (details.isDirectory()) await assertSafeTree(target);
  }
}

async function renameInstallation(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows scanners can briefly hold newly extracted executables open.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 8) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

/** Stages a complete original installation before swapping; the old folder remains recoverable until commit. */
export async function restoreOriginalInstallation(
  record: OriginalInstallation,
  otherInstallDirs: string[],
  onProgress: ExtractionProgressListener,
  commit: (gameRoot: string) => void,
): Promise<string | null> {
  const installDir = path.resolve(record.installDir);
  const archivePath = path.resolve(record.archivePath);
  if (!path.isAbsolute(record.installDir) || !path.isAbsolute(record.archivePath) ||
      installDir === path.parse(installDir).root ||
      !inside(installDir, path.resolve(record.gameRoot))) {
    throw new Error("The recorded installation path is unsafe.");
  }
  if (otherInstallDirs.some((directory) => inside(installDir, path.resolve(directory)) || inside(path.resolve(directory), installDir))) {
    throw new Error("The installation overlaps another local game's folder.");
  }
  const rootArchive = path.dirname(archivePath) === installDir &&
    ["game.zip", "game.7z", "game.rar"].includes(path.basename(archivePath));
  const legacyArchive = archivePath === path.join(path.dirname(installDir), ".redline-downloads", `${record.gameId}.archive`);
  if (!rootArchive && !legacyArchive) throw new Error("The original archive is not in its expected location.");
  await assertUnlinkedPath(installDir);
  await assertUnlinkedPath(archivePath);
  await assertSafeTree(installDir);
  const originalDirectory = await lstat(installDir);
  const originalArchive = await lstat(archivePath);
  if (!originalArchive.isFile() || originalArchive.nlink > 1) throw new Error("The original archive is not a regular file.");
  // Validate and test before creating or changing any installation content.
  await validateArchive(archivePath, installDir);
  await testArchive(archivePath);

  const parent = path.dirname(installDir);
  const prefix = `.${path.basename(installDir)}-restore-`;
  let staging: string | undefined = await mkdtemp(path.join(parent, prefix));
  let backupContainer: string | undefined;
  let oldDirectory: string | undefined;
  let swapped = false;
  let committed = false;
  try {
    await extractArchive(archivePath, staging, onProgress);
    const stagedRoot = await findGameRootInArchive(archivePath, staging);
    await assertSafeTree(staging);
    if (!await findGameLauncher(stagedRoot)) throw new Error("The original archive has no compatible game launcher.");
    if (rootArchive) {
      await copyFile(archivePath, path.join(staging, path.basename(archivePath)), constants.COPYFILE_EXCL);
    }
    await assertUnlinkedPath(installDir);
    await assertUnlinkedPath(archivePath);
    await assertSafeTree(installDir);
    const currentDirectory = await lstat(installDir);
    const currentArchive = await lstat(archivePath);
    if (originalDirectory.ino !== currentDirectory.ino || originalDirectory.dev !== currentDirectory.dev ||
        originalArchive.ino !== currentArchive.ino || originalArchive.dev !== currentArchive.dev ||
        originalArchive.size !== currentArchive.size || originalArchive.mtimeMs !== currentArchive.mtimeMs) {
      throw new Error("The original installation changed while preparing the reset.");
    }
    const gameRoot = path.join(installDir, path.relative(staging, stagedRoot));
    backupContainer = await mkdtemp(path.join(parent, prefix));
    oldDirectory = path.join(backupContainer, "previous-installation");
    await renameInstallation(installDir, oldDirectory);
    try {
      await renameInstallation(staging, installDir);
      staging = undefined;
      swapped = true;
      commit(gameRoot);
      committed = true;
    } catch (error) {
      // Keep both trees if rollback fails rather than deleting the only recoverable installation.
      if (swapped) {
        staging = path.join(backupContainer, "uncommitted-installation");
        await renameInstallation(installDir, staging);
      }
      try {
        await renameInstallation(oldDirectory, installDir);
        oldDirectory = undefined;
      } catch (rollbackError) {
        throw new Error(`Reset failed; the previous installation is preserved at ${oldDirectory}. ${String(rollbackError)}`, { cause: error });
      }
      throw error;
    }
    try {
      await rm(backupContainer, { recursive: true, force: true });
      backupContainer = undefined;
      oldDirectory = undefined;
      return null;
    } catch {
      return `Original game restored; the previous files could not be removed from ${oldDirectory}.`;
    }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (backupContainer && !oldDirectory && !committed) {
      await rm(backupContainer, { recursive: true, force: true });
    }
  }
}

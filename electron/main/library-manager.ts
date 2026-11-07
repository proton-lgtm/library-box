import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { LibraryDatabase } from "./database";
import { findGameLauncher, type Launcher } from "./launcher";

export class LibraryManager {
  constructor(
    private readonly database: LibraryDatabase,
    private readonly launcher: Launcher,
  ) {}

  async deleteGame(gameId: number): Promise<void> {
    const game = this.database.getGame(gameId);
    if (!game) throw new Error("Game was not found.");
    const record = this.database.getDownload(gameId);
    if (!record) return;
    if (record.status !== "installed") {
      throw new Error("Game is not installed.");
    }
    if (this.launcher.runningIds().has(gameId)) {
      throw new Error("Stop the game before deleting it.");
    }

    const installDir = path.resolve(record.installDir);
    if (!path.isAbsolute(record.installDir) || installDir === path.parse(installDir).root) {
      throw new Error("The recorded game folder is not a safe installation path.");
    }

    let details;
    try {
      details = await lstat(installDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.database.removeInstalledGame(gameId);
        return;
      }
      throw error;
    }
    if (details.isSymbolicLink()) {
      throw new Error("The installed game folder is not a regular directory.");
    }
    if (!details.isDirectory()) {
      this.database.removeInstalledGame(gameId);
      return;
    }

    let gameLauncher: string | undefined;
    try {
      gameLauncher = await findGameLauncher(installDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.database.removeInstalledGame(gameId);
        return;
      }
      throw error;
    }
    if (!gameLauncher) {
      this.database.removeInstalledGame(gameId);
      return;
    }

    const archivePath = path.resolve(record.archivePath);
    const rootArchive = path.dirname(archivePath) === installDir &&
      ["game.zip", "game.7z", "game.rar"].includes(path.basename(archivePath));
    const legacyDirectory = path.join(path.dirname(installDir), ".redline-downloads");
    const legacyArchive = archivePath === path.join(legacyDirectory, `${gameId}.archive`);
    if (!rootArchive && !legacyArchive) {
      throw new Error("The recorded game archive is not in its installation folder.");
    }
    const launcherRelativePath = path.relative(installDir, gameLauncher);
    if (path.isAbsolute(launcherRelativePath) || launcherRelativePath === ".." ||
        launcherRelativePath.startsWith(`..${path.sep}`)) {
      throw new Error("The game launcher is outside its recorded installation folder.");
    }
    if (legacyArchive) {
      try {
        const directory = await lstat(legacyDirectory);
        if (directory.isSymbolicLink() || !directory.isDirectory()) {
          throw new Error("The legacy download folder is not a regular directory.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (legacyArchive) {
      await rm(archivePath, { force: true });
      await rm(`${archivePath}.part`, { force: true });
    }
    await rm(installDir, { recursive: true, force: false });
    this.database.removeInstalledGame(gameId);
  }
}

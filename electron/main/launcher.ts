import { spawn, type ChildProcess } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { LibraryDatabase } from "./database";

const running = new Map<number, ChildProcess>();

export async function findGameLauncher(root: string): Promise<string | undefined> {
  const candidates: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().endsWith(".app") && process.platform === "darwin") {
          candidates.push(fullPath);
        } else {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile() && isLauncher(entry.name)) {
        candidates.push(fullPath);
      }
    }
  }
  await walk(root, 0);
  for (const candidate of candidates) {
    if (process.platform !== "linux") return candidate;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      const metadata = await stat(candidate);
      if (metadata.mode & 0o111) return candidate;
    }
  }
  return undefined;
}

function isLauncher(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return process.platform === "win32"
    ? extension === ".exe"
    : process.platform === "darwin"
      ? [".sh", ".command", ".app"].includes(extension)
      : [".sh", ".x86_64", ".x86", ".linux"].includes(extension);
}

export class Launcher {
  constructor(private readonly database: LibraryDatabase) {}

  async launch(gameId: number): Promise<void> {
    if (running.has(gameId)) throw new Error("This game is already running.");
    const game = this.database.getDownload(gameId);
    if (!game || game.status !== "installed") throw new Error("Game is not installed.");
    const installDir = path.resolve(game.installDir);
    const candidate = await findGameLauncher(installDir);
    if (!candidate) throw new Error("No compatible game launcher was found.");
    if (candidate !== installDir && !candidate.startsWith(`${installDir}${path.sep}`)) {
      throw new Error("The game launcher is outside its installation folder.");
    }

    const isAppBundle = process.platform === "darwin" && candidate.endsWith(".app");
    const command = isAppBundle ? "open" : candidate;
    const args = isAppBundle ? ["-a", candidate] : [];
    const child = spawn(command, args, {
      cwd: isAppBundle ? installDir : path.dirname(candidate),
      detached: process.platform !== "win32",
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    running.set(gameId, child);
    child.once("exit", () => running.delete(gameId));
  }

  stop(gameId: number): void {
    const child = running.get(gameId);
    if (!child || !child.pid) throw new Error("This game is not running.");
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", (error) => console.error("Could not stop game process tree:", error));
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
    running.delete(gameId);
  }

  runningIds(): ReadonlySet<number> {
    return new Set(running.keys());
  }
}

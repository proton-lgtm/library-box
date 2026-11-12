import path from "node:path";

export function portableUserDataPath(portableExecutableDirectory: string | undefined): string | undefined {
  if (!portableExecutableDirectory?.trim()) return undefined;
  return path.join(path.resolve(portableExecutableDirectory), "Playmart Data");
}

export function desktopUserDataPath(appDataDirectory: string): string {
  return path.join(appDataDirectory, "Playmart");
}

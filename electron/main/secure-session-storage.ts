import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SecureStorageProvider {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend?(): string;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface AuthSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export async function createEncryptedSessionStorage(
  userDataDirectory: string,
  secureStorage: SecureStorageProvider,
): Promise<AuthSessionStorage | undefined> {
  const encryptionAvailable = await secureStorage.isAsyncEncryptionAvailable();
  const backend = secureStorage.getSelectedStorageBackend?.();
  if (!encryptionAvailable || backend === "basic_text") {
    return undefined;
  }

  const filePath = path.join(userDataDirectory, "supabase-session.enc");
  const persistEncrypted = async (value: string): Promise<void> => {
    await mkdir(userDataDirectory, { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    try {
      const encrypted = await secureStorage.encryptStringAsync(value);
      await writeFile(temporaryPath, encrypted.toString("base64"), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  };
  return {
    async getItem(): Promise<string | null> {
      try {
        const encrypted = await readFile(filePath, "utf8");
        const decrypted = await secureStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
        if (decrypted.shouldReEncrypt) await persistEncrypted(decrypted.result);
        return decrypted.result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async setItem(_key: string, value: string): Promise<void> {
      await persistEncrypted(value);
    },
    async removeItem(): Promise<void> {
      await rm(filePath, { force: true });
    },
  };
}

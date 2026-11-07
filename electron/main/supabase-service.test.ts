import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryDatabase } from "./database";
import { createEncryptedSessionStorage } from "./secure-session-storage";

const mocks = vi.hoisted(() => ({
  client: {
    auth: {
      getSession: vi.fn(),
      signInAnonymously: vi.fn(),
      signInWithPassword: vi.fn(),
      getUser: vi.fn(),
      updateUser: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
  order: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

import { SupabaseService } from "./supabase-service";

const anonymousUser = {
  id: "14a1a964-03e4-4995-9d62-2d55bfa5e029",
  email: undefined,
  email_confirmed_at: undefined,
  is_anonymous: true,
};
const accountUser = {
  ...anonymousUser,
  email: "player@example.com",
  email_confirmed_at: "2026-11-05T00:00:00.000Z",
  is_anonymous: false,
};

function makeSessionStorage() {
  return {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  };
}

function makeService(database: LibraryDatabase, storage = makeSessionStorage()): SupabaseService {
  return new SupabaseService(database, "https://project.supabase.co", "sb_publishable_test", storage);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClient.mockReturnValue(mocks.client);
  mocks.client.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mocks.client.auth.signInAnonymously.mockResolvedValue({
    data: { user: anonymousUser, session: {} },
    error: null,
  });
  mocks.client.auth.signInWithPassword.mockResolvedValue({
    data: { user: accountUser, session: {} },
    error: null,
  });
  mocks.client.auth.getUser.mockResolvedValue({ data: { user: anonymousUser }, error: null });
  mocks.client.auth.updateUser
    .mockResolvedValueOnce({ data: { user: accountUser }, error: null })
    .mockResolvedValueOnce({ data: { user: accountUser }, error: null });
  mocks.client.auth.signOut.mockResolvedValue({ error: null });
  mocks.client.from.mockReturnValue({
    select: vi.fn(() => ({ order: mocks.order })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Supabase catalog", () => {
  it("maps nested catalog details into the local cache", async () => {
    const database = new LibraryDatabase(":memory:");
    mocks.order.mockResolvedValue({
      data: [{
        id: "69e2af3e-4128-4e15-95a0-b90e33ae11cd",
        name: "Sample Game",
        thumbnail_url: "https://covers.example/game.webp",
        size_bytes: 4096,
        last_updated: "2026-11-01T00:00:00.000Z",
        tags: ["visual novel"],
        game_details: {
          description: "A sample description.",
          release_date: "2026-10-25",
          last_updated: "2026-11-02T00:00:00.000Z",
          developer_links: { patreon: "https://patreon.com/example" },
          version: "1.0",
          operating_systems: ["Windows", "Linux"],
          download_links: { pixeldrain: "https://pixeldrain.com/u/example" },
          mod_links: [{
            name: "Patch",
            download_links: { direct_link: "https://downloads.example/patch.zip" },
            steps_to_apply: [{ type: "extract", target_folder: "." }],
          }, {
            name: "Full Save",
            asset_type: "file",
            download_links: { direct_link: "https://downloads.example/1-5-LT1.save" },
            steps_to_apply: [{
              type: "move",
              target_path: "%GAME_ROOT%/game/saves/1-5-LT1.save",
            }],
          }],
        },
      }],
      error: null,
    });
    const service = makeService(database);

    const snapshot = await service.refreshCatalog();

    expect(snapshot).toMatchObject({ stale: false, error: null });
    expect(snapshot.games[0]).toMatchObject({
      name: "Sample Game",
      sizeBytes: 4096,
      description: "A sample description.",
      releaseDate: "2026-10-25",
      developerLinks: { patreon: "https://patreon.com/example" },
      mods: [
        { name: "Patch", asset_type: "zip" },
        {
          name: "Full Save",
          asset_type: "file",
          steps_to_apply: [{
            type: "move",
            target_path: "%GAME_ROOT%/game/saves/1-5-LT1.save",
          }],
        },
      ],
    });
    database.close();
  });

  it("keeps the previous catalog and reports remote errors", async () => {
    const database = new LibraryDatabase(":memory:");
    database.seed(JSON.stringify([{
      name: "Cached Game",
      download_links: { direct_link: "https://downloads.example/game.zip" },
    }]));
    mocks.order.mockResolvedValue({ data: null, error: { message: "Network unavailable." } });
    const service = makeService(database);

    const snapshot = await service.refreshCatalog();

    expect(snapshot).toMatchObject({
      stale: true,
      error: "Network unavailable.",
      games: [{ name: "Cached Game" }],
      lastSyncedAt: null,
    });
    database.close();
  });

  it("establishes an anonymous JWT before querying the catalog", async () => {
    const database = new LibraryDatabase(":memory:");
    mocks.order.mockResolvedValue({ data: [], error: null });
    const service = makeService(database);

    await service.refreshCatalog();

    expect(mocks.client.auth.signInAnonymously.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.order.mock.invocationCallOrder[0]);
    expect(await service.refreshCatalog()).toMatchObject({ stale: false });
    database.close();
  });

  it("allows authenticated catalog access with an ephemeral anonymous session", async () => {
    const database = new LibraryDatabase(":memory:");
    mocks.order.mockResolvedValue({ data: [], error: null });
    const service = new SupabaseService(
      database,
      "https://project.supabase.co",
      "sb_publishable_test",
    );

    const snapshot = await service.refreshCatalog();

    expect(snapshot.stale).toBe(false);
    expect(mocks.client.auth.signInAnonymously).toHaveBeenCalledOnce();
    database.close();
  });

  it("does not make the catalog request when anonymous token initialization fails", async () => {
    const database = new LibraryDatabase(":memory:");
    mocks.client.auth.signInAnonymously.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Anonymous sign-in disabled." },
    });
    const service = makeService(database);

    const snapshot = await service.refreshCatalog();

    expect(snapshot).toMatchObject({
      stale: true,
      error: expect.stringContaining("Anonymous sign-in disabled."),
    });
    expect(mocks.client.from).not.toHaveBeenCalled();
    database.close();
  });

  it("retries anonymous sign-in on catalog refresh after initial auth failure", async () => {
    const database = new LibraryDatabase(":memory:");
    mocks.order.mockResolvedValue({ data: [], error: null });
    mocks.client.auth.signInAnonymously
      .mockResolvedValueOnce({
        data: { user: null, session: null },
        error: { message: "Anonymous sign-in disabled." },
      })
      .mockResolvedValueOnce({
        data: { user: anonymousUser, session: {} },
        error: null,
      });
    const service = makeService(database);

    const failedSnapshot = await service.refreshCatalog();
    const retriedSnapshot = await service.refreshCatalog();

    expect(failedSnapshot).toMatchObject({ stale: true, error: expect.stringContaining("Anonymous sign-in disabled.") });
    expect(retriedSnapshot).toMatchObject({ stale: false, error: null });
    expect(mocks.client.auth.signInAnonymously).toHaveBeenCalledTimes(2);
    expect(mocks.client.from).toHaveBeenCalledOnce();
    database.close();
  });

  it("refuses a service-role key and keeps catalog access unavailable", async () => {
    const database = new LibraryDatabase(":memory:");
    const service = new SupabaseService(
      database,
      "https://project.supabase.co",
      "sb_secret_do_not_use",
      makeSessionStorage(),
    );

    const snapshot = await service.refreshCatalog();

    expect(snapshot).toMatchObject({
      stale: true,
      error: expect.stringContaining("service-role secret"),
      games: [],
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    database.close();
  });

  it("upgrades the anonymous account in place without creating another user", async () => {
    const database = new LibraryDatabase(":memory:");
    const service = makeService(database);
    await service.initializeAuth();

    const state = await service.upgradeAnonymousAccount({
      email: "player@example.com",
      password: "password123",
    });

    expect(state).toMatchObject({ status: "account", email: "player@example.com" });
    expect(mocks.client.auth.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(mocks.client.auth.updateUser).toHaveBeenNthCalledWith(1, { email: "player@example.com" });
    expect(mocks.client.auth.updateUser).toHaveBeenNthCalledWith(2, { password: "password123" });
    database.close();
  });

  it("supports existing account sign-in and returns to anonymous browsing at sign-out", async () => {
    const database = new LibraryDatabase(":memory:");
    const service = makeService(database);

    const signedIn = await service.signIn({ email: "player@example.com", password: "password123" });
    expect(signedIn).toMatchObject({ status: "account", email: "player@example.com" });
    const signedOut = await service.signOut();
    expect(signedOut.status).toBe("anonymous");
    expect(mocks.client.auth.signOut).toHaveBeenCalledOnce();
    expect(mocks.client.auth.signInAnonymously).toHaveBeenCalledOnce();
    database.close();
  });
});

describe("encrypted Supabase session storage", () => {
  it("stores encrypted session bytes and restores the original session", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "supabase-session-test-"));
    const secureStorage = {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "os_crypt",
      encryptStringAsync: async (value: string) => Buffer.from(`encrypted:${value}`),
      decryptStringAsync: async (value: Buffer) => ({
        result: value.toString().replace(/^encrypted:/, ""),
        shouldReEncrypt: false,
      }),
    };
    const storage = await createEncryptedSessionStorage(directory, secureStorage);
    if (!storage) throw new Error("Expected encrypted storage to be available.");
    try {
      await storage.setItem("supabase", "refresh-token-value");
      const saved = readFileSync(path.join(directory, "supabase-session.enc"), "utf8");
      expect(saved).not.toContain("refresh-token-value");
      expect(await storage.getItem("supabase")).toBe("refresh-token-value");
      await storage.removeItem("supabase");
      expect(await storage.getItem("supabase")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses insecure Linux basic_text storage", async () => {
    const secureStorage = {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }),
    };
    expect(await createEncryptedSessionStorage(os.tmpdir(), secureStorage)).toBeUndefined();
  });

  it("works when the runtime does not expose the optional backend method", async () => {
    const secureStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }),
    };
    const storage = await createEncryptedSessionStorage(os.tmpdir(), secureStorage);
    expect(storage).toBeDefined();
  });

  it("refuses storage when async encryption is unavailable", async () => {
    const secureStorage = {
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }),
    };
    expect(await createEncryptedSessionStorage(os.tmpdir(), secureStorage)).toBeUndefined();
  });
});

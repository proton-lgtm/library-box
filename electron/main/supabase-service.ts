import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AuthCredentials, AuthState, CatalogSnapshot } from "../../src/shared/types";
import { createMemorySessionStorage, type AuthSessionStorage } from "./secure-session-storage";
import { type CatalogEntry, LibraryDatabase } from "./database";

const httpsUrl = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
});
const linkRecordSchema = z.record(z.string(), httpsUrl);
const modStepSchema = z.object({
  type: z.enum(["extract", "move"]),
  target_folder: z.string(),
  source_folder: z.string().optional(),
}).strict();
const modSchema = z.object({
  name: z.string().trim().min(1),
  download_links: linkRecordSchema,
  steps_to_apply: z.array(modStepSchema).default([]),
  file_type: z.string().optional(),
}).strict();
const gameDetailsSchema = z.object({
  description: z.string().default(""),
  release_date: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  developer_links: linkRecordSchema.default({}),
  version: z.string().nullable().optional(),
  operating_systems: z.array(z.string()).default([]),
  download_links: linkRecordSchema.default({}),
  mod_links: z.array(modSchema).default([]),
}).strict().nullable().optional();
const catalogGameSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  thumbnail_url: z.union([httpsUrl, z.literal("")]).nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  game_details: gameDetailsSchema,
}).strict();
const catalogSchema = z.array(catalogGameSchema);

export class SupabaseService {
  private readonly client?: SupabaseClient;
  private readonly configError?: string;
  private authState: AuthState = {
    status: "unavailable",
    email: null,
    message: "Authentication has not been initialized.",
  };
  private authInitialization?: Promise<AuthState>;

  constructor(
    private readonly database: LibraryDatabase,
    url: string,
    publishableKey: string,
    private readonly sessionStorage?: AuthSessionStorage,
  ) {
    if (!url || !publishableKey) {
      this.configError = "Supabase is not configured. Set the project URL and publishable key.";
      this.authState.message = this.configError;
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      this.configError = "The configured Supabase project URL is invalid.";
      this.authState.message = this.configError;
      return;
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password ||
        parsedUrl.search || parsedUrl.hash) {
      this.configError = "The Supabase project URL must be a clean HTTPS URL.";
      this.authState.message = this.configError;
      return;
    }
    if (isServiceRoleKey(publishableKey)) {
      this.configError = "A service-role secret cannot be used by the desktop app. Configure a publishable key.";
      this.authState.message = this.configError;
      return;
    }

    const authStorage = sessionStorage ?? createMemorySessionStorage();
    this.client = createClient(url, publishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
        storage: authStorage,
      },
    });
    if (!sessionStorage) {
      this.authState = {
        status: "unavailable",
        email: null,
        message: "Secure session storage is unavailable on this system. Catalog browsing still works.",
      };
    }
  }

  initializeAuth(): Promise<AuthState> {
    if (!this.authInitialization) {
      const initialization = this.initializeAuthOnce();
      const sharedInitialization = initialization.finally(() => {
        if (this.authInitialization === sharedInitialization) {
          this.authInitialization = undefined;
        }
      });
      this.authInitialization = sharedInitialization;
    }
    return this.authInitialization;
  }

  private async initializeAuthOnce(): Promise<AuthState> {
    if (!this.client) return this.authState;
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      if (data.session) {
        this.authState = stateFromUser(data.session.user, this.sessionStorage ? null :
          "Secure session storage is unavailable. This anonymous session lasts only until the app closes.");
      } else {
        const { data: anonymous, error: signInError } = await this.client.auth.signInAnonymously();
        if (signInError) throw signInError;
        if (!anonymous.user) throw new Error("Supabase did not return an anonymous user.");
        this.authState = stateFromUser(anonymous.user, this.sessionStorage ? null :
          "Secure session storage is unavailable. This anonymous session lasts only until the app closes.");
      }
    } catch (error) {
      this.authState = {
        status: "unavailable",
        email: null,
        message: `Could not establish an anonymous Supabase session: ${errorMessage(error)}`,
      };
    }
    return this.authState;
  }

  async refreshCatalog(): Promise<CatalogSnapshot> {
    const lastSyncedAt = this.database.getCatalogLastSyncedAt();
    if (!this.client) return this.staleSnapshot(this.configError ?? "Supabase is unavailable.");

    try {
      const auth = await this.initializeAuth();
      if (auth.status === "unavailable") {
        throw new Error(auth.message ?? "A Supabase authentication token is required to load the catalog.");
      }
      const { data, error } = await this.client
        .from("games")
        .select("id,name,thumbnail_url,size_bytes,last_updated,tags,game_details(description,release_date,last_updated,developer_links,version,operating_systems,download_links,mod_links)")
        .order("name", { ascending: true });
      if (error) throw error;
      const catalog = catalogSchema.parse(data);
      this.database.syncCatalog(catalog.map(toCatalogEntry));
      return {
        games: this.database.listGames(),
        stale: false,
        lastSyncedAt: this.database.getCatalogLastSyncedAt(),
        error: null,
      };
    } catch (error) {
      return this.staleSnapshot(errorMessage(error), lastSyncedAt);
    }
  }

  async getAuthState(): Promise<AuthState> {
    if (!this.client) return this.authState;
    if (this.authInitialization) await this.authInitialization;
    if (!this.sessionStorage) return this.authState;
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      this.authState = data.session
        ? stateFromUser(data.session.user)
        : {
          status: "unavailable",
          email: null,
          message: this.authState.message,
        };
    } catch (error) {
      this.authState = {
        status: "unavailable",
        email: null,
        message: `Could not read the Supabase session: ${errorMessage(error)}`,
      };
    }
    return this.authState;
  }

  async signIn(credentials: AuthCredentials): Promise<AuthState> {
    const client = this.requireAuth();
    const { data, error } = await client.auth.signInWithPassword({
      email: credentials.email.trim(),
      password: credentials.password,
    });
    if (error) throw error;
    if (!data.user) throw new Error("Supabase did not return a signed-in user.");
    this.authState = stateFromUser(data.user);
    return this.authState;
  }

  async upgradeAnonymousAccount(credentials: AuthCredentials): Promise<AuthState> {
    const client = this.requireAuth();
    const { data: current, error: currentError } = await client.auth.getUser();
    if (currentError) throw currentError;
    if (!current.user.is_anonymous) {
      throw new Error("Only the current anonymous account can be upgraded.");
    }

    const { data, error } = await client.auth.updateUser({ email: credentials.email.trim() });
    if (error) throw error;
    if (!data.user.email_confirmed_at) {
      throw new Error("Supabase has not confirmed the email automatically. Keep email confirmations disabled to avoid an email verification step.");
    }
    const { data: updated, error: passwordError } = await client.auth.updateUser({
      password: credentials.password,
    });
    if (passwordError) throw passwordError;
    if (!updated.user) throw new Error("Supabase did not return the upgraded account.");
    this.authState = stateFromUser(updated.user);
    return this.authState;
  }

  async signOut(): Promise<AuthState> {
    const client = this.requireAuth();
    const { error } = await client.auth.signOut();
    if (error) throw error;
    try {
      const { data, error: anonymousError } = await client.auth.signInAnonymously();
      if (anonymousError) throw anonymousError;
      if (!data.user) throw new Error("Supabase did not return a new anonymous user.");
      this.authState = stateFromUser(data.user);
    } catch (error) {
      this.authState = {
        status: "unavailable",
        email: null,
        message: `Signed out, but could not start a new anonymous session: ${errorMessage(error)}`,
      };
    }
    return this.authState;
  }

  private requireAuth(): SupabaseClient {
    if (!this.client) throw new Error(this.configError ?? "Supabase is unavailable.");
    if (!this.sessionStorage) {
      throw new Error("Secure session storage is unavailable; sign-in is disabled to protect your account.");
    }
    return this.client;
  }

  private staleSnapshot(error: string, lastSyncedAt = this.database.getCatalogLastSyncedAt()): CatalogSnapshot {
    return {
      games: this.database.listGames(),
      stale: true,
      lastSyncedAt,
      error,
    };
  }
}

function toCatalogEntry(game: z.infer<typeof catalogGameSchema>): CatalogEntry {
  const details = game.game_details ?? null;
  return {
    id: game.id,
    name: game.name,
    thumbnail: game.thumbnail_url ?? "",
    sizeBytes: game.size_bytes ?? null,
    lastUpdated: game.last_updated ?? null,
    tags: game.tags,
    description: details?.description ?? "",
    releaseDate: details?.release_date ?? null,
    detailsLastUpdated: details?.last_updated ?? null,
    developerLinks: details?.developer_links ?? {},
    version: details?.version ?? null,
    operatingSystems: details?.operating_systems ?? [],
    downloadLinks: details?.download_links ?? {},
    mods: details?.mod_links ?? [],
  };
}

function stateFromUser(
  user: { is_anonymous?: boolean; email?: string },
  message: string | null = null,
): AuthState {
  return {
    status: user.is_anonymous ? "anonymous" : "account",
    email: user.email ?? null,
    message,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const tokenParts = key.split(".");
  if (tokenParts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

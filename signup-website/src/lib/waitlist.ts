const MAX_BODY_BYTES = 4096;
const MAX_TOKEN_LENGTH = 2048;
const PROVIDER_TIMEOUT_MS = 5000;

export type WaitlistDependencies = {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  reportFailure?: (diagnostic: WaitlistDiagnostic) => void;
};

export type WaitlistDiagnostic = {
  stage: "configuration" | "turnstile" | "supabase";
  reason: "invalid_configuration" | "provider_http_error" | "invalid_provider_response" | "verification_unavailable" | "request_failed_or_timed_out";
  missingVariables?: string[];
  httpStatus?: number;
  databaseCode?: string;
};

type Config = {
  supabaseUrl: string;
  supabaseKey: string;
  turnstileSecret: string;
  hostnames: Set<string>;
};

class RequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Invalid request");
    this.status = status;
  }
}

function response(status: number): Response {
  return Response.json(
    status === 200
      ? { success: true }
      : { error: status === 503 ? "Service unavailable." : "Invalid request." },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function hostnameIsValid(value: string): boolean {
  return value.length <= 253 && value.split(".").every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local || local.length > 64 || local.startsWith(".") || local.endsWith(".") ||
    local.includes("..") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    !domain.includes(".") || !hostnameIsValid(domain)
  ) return null;
  return email;
}

function readConfig(env: WaitlistDependencies["env"]): Config | null {
  const supabaseKey = env.SUPABASE_SECRET_KEY?.trim();
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim();
  const expected = env.TURNSTILE_EXPECTED_HOSTNAMES;
  if (!supabaseKey || !turnstileSecret || !expected || !env.SUPABASE_URL || !env.PRIVACY_POLICY_URL) return null;
  const hostnames = expected.split(",").map((value) => value.trim().toLowerCase());
  if (hostnames.some((value) => !hostnameIsValid(value))) return null;
  try {
    const policyUrl = new URL(env.PRIVACY_POLICY_URL);
    if (policyUrl.protocol !== "https:" || !policyUrl.hostname || policyUrl.username || policyUrl.password) return null;
    const url = new URL(env.SUPABASE_URL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/"
    ) return null;
    return { supabaseUrl: url.origin, supabaseKey, turnstileSecret, hostnames: new Set(hostnames) };
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new RequestError(400);
    if (Number(length) > MAX_BODY_BYTES) throw new RequestError(413);
  }
  if (!request.body) throw new RequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400);
  return body as Record<string, unknown>;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Provider timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getWaitlistCount(dependencies: WaitlistDependencies): Promise<number | null> {
  const config = readConfig(dependencies.env);
  if (!config) return null;
  try {
    return await withTimeout(async (signal) => {
      const result = await dependencies.fetch(`${config.supabaseUrl}/rest/v1/rpc/waitlist_signup_count`, {
        method: "POST",
        headers: {
          apikey: config.supabaseKey,
          ...(!config.supabaseKey.startsWith("sb_secret_")
            ? { Authorization: `Bearer ${config.supabaseKey}` }
            : {}),
        },
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!result.ok) return null;
      const count: unknown = await result.json();
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
    }, dependencies.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export async function handleWaitlist(
  request: Request,
  dependencies: WaitlistDependencies,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) return response(403);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return response(415);

  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return response(error instanceof RequestError ? error.status : 400);
  }
  const email = normalizeEmail(body.email);
  if (!email || body.consent !== true ||
    (body.website !== undefined && typeof body.website !== "string")) return response(400);
  if (typeof body.website === "string" && body.website.length > 0) return response(200);
  if (typeof body.turnstileToken !== "string" ||
    !body.turnstileToken.trim() || body.turnstileToken.length > MAX_TOKEN_LENGTH) return response(400);

  const report = (diagnostic: WaitlistDiagnostic) => {
    try { dependencies.reportFailure?.(diagnostic); } catch { /* Logging must not change the response. */ }
  };
  const config = readConfig(dependencies.env);
  if (!config) {
    report({ stage: "configuration", reason: "invalid_configuration", missingVariables: [
      "SUPABASE_URL", "SUPABASE_SECRET_KEY", "TURNSTILE_SECRET_KEY",
      "TURNSTILE_EXPECTED_HOSTNAMES", "PRIVACY_POLICY_URL",
    ].filter(name => !dependencies.env[name]?.trim()) });
    return response(503);
  }
  let stage: "turnstile" | "supabase" = "turnstile";
  const timeoutMs = dependencies.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  try {
    const verification = await withTimeout(async (signal) => {
      const result = await dependencies.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: config.turnstileSecret, response: body.turnstileToken as string }),
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!result.ok) {
        report({ stage, reason: "provider_http_error", httpStatus: result.status });
        return null;
      }
      const payload: unknown = await result.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid verification response");
      return payload as Record<string, unknown>;
    }, timeoutMs);
    if (verification === null) return response(503);
    if (typeof verification.success !== "boolean") {
      report({ stage, reason: "invalid_provider_response" });
      return response(503);
    }
    if (!verification.success) {
      const errors = verification["error-codes"];
      if (Array.isArray(errors) && errors.some((code) =>
        ["internal-error", "missing-input-secret", "invalid-input-secret", "bad-request"].includes(code),
      )) {
        report({ stage, reason: "verification_unavailable" });
        return response(503);
      }
      return response(400);
    }
    if (verification.action !== "waitlist" || typeof verification.hostname !== "string" ||
      !config.hostnames.has(verification.hostname.toLowerCase())) return response(400);

    stage = "supabase";
    return await withTimeout(async (signal) => {
      const result = await dependencies.fetch(`${config.supabaseUrl}/rest/v1/waitlist_signups`, {
        method: "POST",
        headers: {
          apikey: config.supabaseKey,
          ...(!config.supabaseKey.startsWith("sb_secret_")
            ? { Authorization: `Bearer ${config.supabaseKey}` }
            : {}),
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ email, consented_at: new Date().toISOString() }),
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (result.ok) return response(200);
      let databaseCode: string | undefined;
      try {
        const error: unknown = await result.json();
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
          /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(error.code)) databaseCode = error.code;
      } catch { /* Never log provider messages or response bodies. */ }
      if (result.status === 409 && databaseCode === "23505") return response(200);
      report({ stage, reason: "provider_http_error", httpStatus: result.status, ...(databaseCode ? { databaseCode } : {}) });
      return response(503);
    }, timeoutMs);
  } catch {
    report({ stage, reason: "request_failed_or_timed_out" });
    return response(503);
  }
}

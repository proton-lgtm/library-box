import assert from "node:assert/strict";
import test from "node:test";
import { handleWaitlist } from "../src/lib/waitlist.ts";

const env = {
  SUPABASE_URL: "https://example.supabase.co/",
  SUPABASE_SECRET_KEY: "sb_secret_test-key",
  PRIVACY_POLICY_URL: "https://signup.example.com/privacy",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAMES: "signup.example.com, preview.example.com",
};
const valid = { email: " Person@Example.com ", consent: true, website: "", turnstileToken: "token" };
const verification = { success: true, action: "waitlist", hostname: "signup.example.com" };

type Call = { url: string; init: RequestInit | undefined };
function mockFetch(replies: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    assert.ok(reply, "Unexpected provider request");
    return reply;
  };
  return { calls, fetch };
}
function request(body: unknown = valid, headers: Record<string, string> = {}): Request {
  return new Request("https://signup.example.com/api/waitlist", {
    method: "POST",
    headers: { Origin: "https://signup.example.com", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function check(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), status === 200 ? { success: true } : {
    error: status === 503 ? "Service unavailable." : "Invalid request.",
  });
}

test("verifies action/hostname, inserts only normalized email and consent timestamp", async () => {
  const mock = mockFetch([Response.json(verification), new Response(null, { status: 201 })]);
  await check(await handleWaitlist(request(), { env, fetch: mock.fetch }), 200);
  assert.equal(mock.calls.length, 2);
  const [verify, insert] = mock.calls;
  assert.equal(verify.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(verify.init?.body))), {
    secret: env.TURNSTILE_SECRET_KEY, response: "token",
  });
  assert.equal(insert.url, "https://example.supabase.co/rest/v1/waitlist_signups");
  const payload = JSON.parse(String(insert.init?.body));
  assert.deepEqual(Object.keys(payload).sort(), ["consented_at", "email"]);
  assert.equal(payload.email, "person@example.com");
  assert.ok(Number.isFinite(Date.parse(payload.consented_at)));
  const headers = new Headers(insert.init?.headers);
  assert.equal(headers.get("prefer"), "return=minimal");
  assert.equal(headers.get("apikey"), env.SUPABASE_SECRET_KEY);
  assert.equal(headers.has("authorization"), false);
  for (const call of mock.calls) {
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.cache, "no-store");
    assert.equal(call.init?.redirect, "error");
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test("legacy service-role JWT retains both apikey and Bearer headers", async () => {
  const key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature";
  const mock = mockFetch([Response.json(verification), new Response(null, { status: 201 })]);
  await check(await handleWaitlist(request(), {
    env: { ...env, SUPABASE_SECRET_KEY: key }, fetch: mock.fetch,
  }), 200);
  const headers = new Headers(mock.calls[1].init?.headers);
  assert.equal(headers.get("apikey"), key);
  assert.equal(headers.get("authorization"), `Bearer ${key}`);
});

test("requires a valid HTTPS privacy policy before contacting providers", async () => {
  for (const policy of [undefined, "", " ", "not-url", "/privacy", "http://signup.example.com/privacy",
    "javascript:alert(1)", "https://", "https://user:pass@signup.example.com/privacy"]) {
    const mock = mockFetch([]);
    await check(await handleWaitlist(request(), {
      env: { ...env, PRIVACY_POLICY_URL: policy }, fetch: mock.fetch,
    }), 503);
    assert.equal(mock.calls.length, 0);
  }
});

test("rejects absent, null, cross-origin and malformed Origin before providers", async () => {
  for (const origin of ["", "null", "https://attacker.example", "https://signup.example.com.attacker.com", "https://signup.example.com/"]) {
    const mock = mockFetch([]);
    await check(await handleWaitlist(request(valid, { Origin: origin }), { env, fetch: mock.fetch }), 403);
    assert.equal(mock.calls.length, 0);
  }
  const missing = request();
  missing.headers.delete("origin");
  await check(await handleWaitlist(missing, { env, fetch: mockFetch([]).fetch }), 403);
});

test("requires JSON media type, allowing a charset", async () => {
  for (const value of ["text/plain", "application/jsonp", ""]) {
    await check(await handleWaitlist(request(valid, { "Content-Type": value }), { env: {}, fetch: mockFetch([]).fetch }), 415);
  }
  const mock = mockFetch([Response.json(verification), new Response(null, { status: 201 })]);
  await check(await handleWaitlist(request(valid, { "Content-Type": "application/json; charset=utf-8" }), { env, fetch: mock.fetch }), 200);
});

test("validates email, consent, honeypot type and token before configuration", async () => {
  const invalidBodies: unknown[] = [null, [], "text", {}, ...[
    { email: "a..b@example.com" }, { email: ".a@example.com" }, { email: "a.@example.com" },
    { email: "a@localhost" }, { email: "a@-bad.example" }, { email: "a@bad_.example" },
    { email: "a@b..com" }, { email: "a\n@example.com" }, { email: "a@b.com@c.com" },
    { email: "ü@example.com" }, { email: "a".repeat(65) + "@example.com" },
    { email: "a@" + "b".repeat(64) + ".com" }, { email: "a".repeat(255) },
    { email: 123 }, { consent: false }, { consent: "true" }, { consent: 1 },
    { website: false }, { website: {} }, { turnstileToken: "" }, { turnstileToken: "   " },
    { turnstileToken: undefined }, { turnstileToken: 123 }, { turnstileToken: "a".repeat(2049) },
  ].map((patch) => ({ ...valid, ...patch }))];
  for (const body of invalidBodies) {
    await check(await handleWaitlist(request(body), { env: {}, fetch: mockFetch([]).fetch }), 400);
  }
});

test("honeypot returns identical success without config, token or provider access", async () => {
  for (const website of ["https://bot.example", " ", "<script>alert(1)</script>"]) {
    const mock = mockFetch([]);
    await check(await handleWaitlist(request({ ...valid, website, turnstileToken: undefined }), { env: {}, fetch: mock.fetch }), 200);
    assert.equal(mock.calls.length, 0);
  }
});

test("bounds Content-Length and actual chunked UTF-8 bytes, cancels oversized streams", async () => {
  for (const length of ["4097", "999999999999999999999999999"]) {
    await check(await handleWaitlist(request(valid, { "Content-Length": length }), { env: {}, fetch: mockFetch([]).fetch }), 413);
  }
  await check(await handleWaitlist(request(valid, { "Content-Length": "invalid" }), { env: {}, fetch: mockFetch([]).fetch }), 400);
  let cancelled = false;
  const chunks = [new TextEncoder().encode('{"extra":"'), new TextEncoder().encode("é".repeat(2050))];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request("https://signup.example.com/api/waitlist", {
    method: "POST", headers: { Origin: "https://signup.example.com", "Content-Type": "application/json", "Content-Length": "1" },
    body: stream, duplex: "half",
  } as RequestInit);
  await check(await handleWaitlist(streamed, { env: {}, fetch: mockFetch([]).fetch }), 413);
  assert.equal(cancelled, true);
});

test("accepts exactly 4096 bytes but rejects 4097", async () => {
  for (const size of [4096, 4097]) {
    const base = JSON.stringify(valid);
    const req = request();
    const padded = new Request(req.url, { method: "POST", headers: req.headers, body: base.padEnd(size, " ") });
    const mock = mockFetch([Response.json(verification), new Response(null, { status: 201 })]);
    await check(await handleWaitlist(padded, { env, fetch: mock.fetch }), size === 4096 ? 200 : 413);
    assert.equal(mock.calls.length, size === 4096 ? 2 : 0);
  }
});

test("rejects malformed JSON and malformed UTF-8", async () => {
  for (const body of ["{", "", new Uint8Array([0xff])]) {
    const req = request();
    const malformed = new Request(req.url, { method: "POST", headers: req.headers, body });
    await check(await handleWaitlist(malformed, { env: {}, fetch: mockFetch([]).fetch }), 400);
  }
});

test("fails closed on each missing or invalid configuration and ignores public keys", async () => {
  const configurations: Array<Record<string, string | undefined>> = [
    {}, { ...env, SUPABASE_URL: "not-url" }, { ...env, SUPABASE_URL: "https://user:pass@example.com" },
    { ...env, SUPABASE_URL: "https://example.com/other" }, { ...env, SUPABASE_URL: "http://example.com" },
    { ...env, SUPABASE_URL: "https://example.com?key=secret" },
    { ...env, TURNSTILE_EXPECTED_HOSTNAMES: "*.example.com" },
    { ...env, TURNSTILE_EXPECTED_HOSTNAMES: "https://signup.example.com" },
    { ...env, TURNSTILE_EXPECTED_HOSTNAMES: "signup.example.com," },
    { ...env, SUPABASE_SECRET_KEY: undefined, NEXT_PUBLIC_SUPABASE_SECRET_KEY: "public-not-accepted" },
    ...Object.keys(env).map((key) => ({ ...env, [key]: " " })),
  ];
  for (const config of configurations) {
    const mock = mockFetch([]);
    await check(await handleWaitlist(request(), { env: config, fetch: mock.fetch }), 503);
    assert.equal(mock.calls.length, 0);
  }
});

test("invalid, replayed, wrong-action and wrong-host tokens never insert", async () => {
  for (const payload of [
    { success: false, "error-codes": ["invalid-input-response"] },
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    { ...verification, action: "login" }, { ...verification, action: undefined },
    { ...verification, hostname: "signup.example.com.attacker.com" },
    { ...verification, hostname: undefined },
  ]) {
    const mock = mockFetch([Response.json(payload)]);
    await check(await handleWaitlist(request(), { env, fetch: mock.fetch }), 400);
    assert.equal(mock.calls.length, 1);
  }
});

test("accepts explicitly configured preview hostname and max token length", async () => {
  const mock = mockFetch([Response.json({ ...verification, hostname: "preview.example.com" }), new Response(null, { status: 201 })]);
  await check(await handleWaitlist(request({ ...valid, turnstileToken: "t".repeat(2048) }), { env, fetch: mock.fetch }), 200);
});

test("provider errors are generic 503 without storing", async () => {
  for (const reply of [
    new Error("secret network detail"), new Response("secret upstream detail", { status: 503 }),
    new Response("not-json"), Response.json(null), Response.json([]), Response.json({ success: "true" }),
    Response.json({ success: false, "error-codes": ["internal-error"] }),
    Response.json({ success: false, "error-codes": ["invalid-input-secret"] }),
  ]) {
    const mock = mockFetch([reply]);
    await check(await handleWaitlist(request(), { env, fetch: mock.fetch }), 503);
    assert.equal(mock.calls.length, 1);
  }
});

test("only PostgreSQL unique violation 23505 is indistinguishable from insertion", async () => {
  for (const [status, payload, expected] of [
    [409, { code: "23505", details: "private email exists" }, 200],
    [409, { code: "23514", message: "constraint detail" }, 503],
    [409, { code: "42501" }, 503], [500, { code: "23505" }, 503],
    [401, { message: "private auth error" }, 503],
  ] as const) {
    const mock = mockFetch([Response.json(verification), Response.json(payload, { status })]);
    await check(await handleWaitlist(request(), { env, fetch: mock.fetch }), expected);
    assert.equal(mock.calls.length, 2);
  }
  const mock = mockFetch([Response.json(verification), new Response("bad-json", { status: 409 })]);
  await check(await handleWaitlist(request(), { env, fetch: mock.fetch }), 503);
});

test("times out verification and insertion, aborting each provider request", async () => {
  for (const stallInsertion of [false, true]) {
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_, init) => {
      calls++;
      if (stallInsertion && calls === 1) return Response.json(verification);
      signal = init?.signal;
      return new Promise<Response>(() => {});
    };
    await check(await handleWaitlist(request(), { env, fetch, timeoutMs: 5 }), 503);
    assert.equal(calls, stallInsertion ? 2 : 1);
    assert.equal(signal?.aborted, true);
  }
});

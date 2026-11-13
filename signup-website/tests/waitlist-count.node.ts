import assert from "node:assert/strict";
import test from "node:test";
import { getWaitlistCount } from "../src/lib/waitlist.ts";

const env = {
  SUPABASE_URL: "https://example.supabase.co/",
  SUPABASE_SECRET_KEY: "sb_secret_test-key",
  PRIVACY_POLICY_URL: "https://signup.example.com/privacy",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAMES: "signup.example.com",
};

test("reads only the aggregate using server credentials without caching", async () => {
  for (const count of [0, 1, 2567]) {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://example.supabase.co/rest/v1/rpc/waitlist_signup_count");
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), env.SUPABASE_SECRET_KEY);
      assert.equal(headers.has("authorization"), false);
      return Response.json(count);
    };
    assert.equal(await getWaitlistCount({ env, fetch }), count);
  }
});

test("count failures and invalid aggregates never produce invented numbers", async () => {
  for (const value of [-1, 1.5, "2567", null, {}, [2567], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await getWaitlistCount({ env, fetch: async () => Response.json(value) }), null);
  }
  assert.equal(await getWaitlistCount({ env, fetch: async () => new Response(null, { status: 503 }) }), null);
  assert.equal(await getWaitlistCount({ env, fetch: async () => { throw new Error("offline"); } }), null);
  assert.equal(await getWaitlistCount({ env: {}, fetch: async () => { assert.fail("Must not fetch"); } }), null);
});

test("aggregate fetch has a bounded timeout", async () => {
  assert.equal(await getWaitlistCount({
    env,
    timeoutMs: 5,
    fetch: async () => new Promise<Response>(() => {}),
  }), null);
});

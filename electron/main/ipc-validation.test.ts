import { describe, expect, it } from "vitest";
import { authCredentialsSchema, externalUrlSchema } from "./ipc-validation";

describe("IPC input validation", () => {
  it("accepts bounded email/password credentials", () => {
    expect(authCredentialsSchema.parse({
      email: " player@example.com ",
      password: "pass phrase",
    })).toEqual({
      email: "player@example.com",
      password: "pass phrase",
    });
  });

  it("rejects malformed or oversized credentials", () => {
    expect(() => authCredentialsSchema.parse({ email: "not-an-email", password: "x" })).toThrow();
    expect(() => authCredentialsSchema.parse({ email: "player@example.com", password: "" })).toThrow();
  });

  it("allows only public HTTPS external links", () => {
    expect(externalUrlSchema.parse("https://developer.example/page")).toBe("https://developer.example/page");
    for (const url of [
      "http://developer.example",
      "https://localhost/",
      "https://user:pass@developer.example/",
    ]) {
      expect(() => externalUrlSchema.parse(url)).toThrow();
    }
  });
});

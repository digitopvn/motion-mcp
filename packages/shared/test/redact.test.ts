import { describe, expect, it } from "vitest";
import { redact, redactDeep, registerSecret, scrubbedEnv } from "../src/index.ts";

describe("secret redaction", () => {
  it("redacts bearer tokens, provider keys, JWTs and signed URL params", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "key=sk-or-v1-0123456789abcdef0123456789abcdef",
      "polar_oat_0123456789abcdefghijklmnop",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "https://bucket.r2.dev/a.mp4?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=600",
      'api_key: "hunter2hunter2"',
    ].join("\n");
    const out = redact(text);
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz123456/);
    expect(out).not.toMatch(/sk-or-v1-0123/);
    expect(out).not.toMatch(/polar_oat_0123/);
    expect(out).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.eyJ/);
    expect(out).not.toMatch(/deadbeefcafe/);
    expect(out).not.toMatch(/hunter2hunter2/);
    expect(out).toContain("X-Amz-Expires=600");
  });

  it("redacts passwords in connection strings", () => {
    expect(redact("connect postgres://motion:s3cret-pass@db:5432/motion failed")).toBe(
      "connect postgres://motion:[redacted]@db:5432/motion failed",
    );
    expect(redact("see https://example.com:8443/path")).toBe("see https://example.com:8443/path");
  });

  it("redacts registered literal secrets anywhere", () => {
    registerSecret("my-very-custom-secret-value");
    expect(redact("oops my-very-custom-secret-value leaked")).toBe("oops [redacted] leaked");
  });

  it("deep-redacts headers and secret-named fields", () => {
    const out = redactDeep({
      headers: { Authorization: "Bearer x", cookie: "session=1", accept: "json" },
      nested: { apiKey: "plain", note: "ok" },
    });
    expect(out.headers.Authorization).toBe("[redacted]");
    expect(out.headers.cookie).toBe("[redacted]");
    expect(out.headers.accept).toBe("json");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested.note).toBe("ok");
  });

  it("builds child environments without inheriting secrets", () => {
    process.env.SOME_PROVIDER_API_KEY = "should-not-leak-1234";
    const env = scrubbedEnv({ ONLY_THIS: "1" });
    expect(env.SOME_PROVIDER_API_KEY).toBeUndefined();
    expect(env.ONLY_THIS).toBe("1");
    delete process.env.SOME_PROVIDER_API_KEY;
  });
});

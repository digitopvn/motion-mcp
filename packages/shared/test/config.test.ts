import { describe, expect, it } from "vitest";
import { loadConfig, redact, registerSecretsFromEnv } from "../src/index.ts";

describe("dashboard config", () => {
  it("defaults the GitHub callback to the registered marketing host and leaves providers off", () => {
    const config = loadConfig({});
    expect(config.GITHUB_CALLBACK_URL).toBe("https://motion.digitop.ai/api/auth/oauth/github/callback");
    expect(config.GITHUB_CLIENT_ID).toBeUndefined();
    expect(config.RESEND_API_KEY).toBeUndefined();
    expect(config.EMAIL_FROM).toBeUndefined();
    expect(config.DASHBOARD_DIST).toBeUndefined();
  });

  it("reads provider settings and rejects an invalid callback URL", () => {
    const config = loadConfig({
      GITHUB_CLIENT_ID: "Iv1.abc",
      GITHUB_CLIENT_SECRET: "gh-secret-value-123456",
      GITHUB_CALLBACK_URL: "http://localhost:8787/api/auth/oauth/github/callback",
      DASHBOARD_DIST: "/srv/dashboard",
    });
    expect(config.GITHUB_CALLBACK_URL).toBe("http://localhost:8787/api/auth/oauth/github/callback");
    expect(config.DASHBOARD_DIST).toBe("/srv/dashboard");
    expect(() => loadConfig({ GITHUB_CALLBACK_URL: "not a url" })).toThrow();
  });

  it("treats the new credential variables as secrets for redaction", () => {
    registerSecretsFromEnv({
      GITHUB_CLIENT_SECRET: "github-client-secret-value-xyz",
      RESEND_API_KEY: "re_resend_key_value_xyz_123",
    });
    const out = redact("secret github-client-secret-value-xyz and re_resend_key_value_xyz_123");
    expect(out).not.toContain("github-client-secret-value-xyz");
    expect(out).not.toContain("re_resend_key_value_xyz_123");
  });
});

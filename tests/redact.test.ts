import { describe, expect, it } from "vitest";
import { REDACTED, maskToken, redact, scrubEnv } from "../src/config/redact.js";

/**
 * Synthesised, length-anchored vectors — the same construction the scanner's
 * own suite uses. None of these is a credential.
 *
 * The PEM banner and the userinfo URL are assembled from parts: written out in
 * one piece they are byte-identical to what `scripts/check-secrets.mjs` refuses,
 * and a test file that cannot be committed is a test file that gets deleted.
 */
const PAT = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const OAUTH = "gho_" + "z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1";
const SSO = "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const REFRESH = "ghr_" + "B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8";
const USER_SERVER = "ghu_" + "C1d2E3f4G5h6I7j8K9l0M1n2O3p4Q5r6S7t8";
const FINE =
  "github_pat_" +
  "11ABCDEFG0aBcDeFgHiJk" +
  "_" +
  "LmnOpQrStUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678";
const ANTHROPIC = "sk-ant-" + "AbCdEf0123456789-_AbCdEf0123";
const AWS = "AKIA" + "Q7W2E9RT4YU6IO1P";
const GCP = "AIza" + "SyD-1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuV".slice(0, 35);
const SLACK = "xoxb-" + "1234567890-abcdefghij";
const PEM_BODY = "MIIEowIBAAKCAQEAx7Vv9Q2m0pQ1sT8uW3yZ4bC5dE6fG7hI8jK9l0M1nO0";
const PEM_OPEN = "-----BEGIN " + "RSA PRIVATE KEY-----";
const PEM_CLOSE = "-----END " + "RSA PRIVATE KEY-----";
const PEM = [PEM_OPEN, PEM_BODY, "R2sT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3oP4qR5sT6uV7wX8yZ9aB0cD1e", PEM_CLOSE].join("\n");
/** A git remote with a password in it — the shape a pasted remote takes. */
const REMOTE_WITH_USERINFO = "https://someuser:" + "somesecretpassword@github.com/o/r.git";

describe("redact: every proven credential shape is removed", () => {
  const VECTORS: ReadonlyArray<{ id: string; value: string }> = [
    { id: "classic PAT", value: PAT },
    { id: "OAuth token", value: OAUTH },
    { id: "server-to-server token", value: SSO },
    { id: "refresh token", value: REFRESH },
    { id: "user-to-server token", value: USER_SERVER },
    { id: "fine-grained PAT", value: FINE },
    { id: "Anthropic key", value: ANTHROPIC },
    { id: "AWS access key id", value: AWS },
    { id: "Google API key", value: GCP },
    { id: "Slack token", value: SLACK },
    { id: "PEM private key block", value: PEM },
  ];

  for (const v of VECTORS) {
    it(`removes a ${v.id}`, () => {
      const out = redact(`leading text\n${v.value}\ntrailing text`);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(v.value);
      // Context on both sides survives: a scrubber that blanks the line is no
      // use to whoever is reading the error.
      expect(out).toContain("leading text");
      expect(out).toContain("trailing text");
    });
  }

  it("anchors on length, so every vector above is the shape it claims", () => {
    // A vector one character short of its anchor would leave this whole suite
    // passing for the wrong reason: nothing would match, and a test that
    // asserts "no match" on a non-credential reads exactly the same.
    expect(PAT).toHaveLength(40); // ghp_ + 36
    expect(OAUTH).toHaveLength(42); // gho_ + 38
    expect(FINE).toHaveLength(93); // github_pat_ + 82
    expect(ANTHROPIC).toHaveLength(35); // sk-ant- + 28
    expect(AWS).toHaveLength(20); // AKIA + 16
    expect(GCP).toHaveLength(39); // AIza + 35
    expect(SLACK).toHaveLength(26); // xoxb- + 20
  });

  it("removes the whole PEM block, not just its header", () => {
    const out = redact(PEM);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    // The base64 body is the actual secret; a header-only redaction leaks it.
    expect(out).not.toContain(PEM_BODY);
  });

  it("removes a truncated PEM header even with no footer", () => {
    const out = redact(`-----BEGIN EC ${"PRIVATE KEY-----"}\n${PEM_BODY.slice(0, 24)}`);
    expect(out).not.toContain("BEGIN EC PRIVATE KEY");
  });

  it("keeps the scheme and drops the userinfo of a credentialed URL", () => {
    expect(redact(`remote = ${REMOTE_WITH_USERINFO}`)).toBe("remote = https://[redacted]@github.com/o/r.git");
  });

  it("collapses a token embedded in a git remote", () => {
    const out = redact(`https://${PAT}@github.com/o/r.git`);
    expect(out).not.toContain(PAT);
    expect(out).toContain("github.com/o/r.git");
  });

  it("removes a credential glued to the character before it", () => {
    // No word boundary on the left, so a `\b`-guarded rule would find nothing
    // here — and concatenated tool output is exactly where a token hides.
    for (const glued of [`xxxx${PAT}`, `_${PAT}`, `9${PAT}`]) {
      const out = redact(`prefix${glued}\nsuffix`);
      expect(out, glued.slice(0, 6)).not.toContain(PAT);
      expect(out).toContain("prefix");
      expect(out).toContain("suffix");
    }
  });

  it("removes a credential with word characters on BOTH sides", () => {
    // The trailing `\b` makes the match swallow the run that follows, so the
    // output is shorter than an exact replacement would be. That is the right
    // trade: the credential and a few neighbours go, rather than the credential
    // staying. Pinned because "exactly REDACTED" is not the property here.
    const out = redact(`a${PAT}zzz\nb`);
    expect(out).not.toContain(PAT);
    expect(out).toContain("a");
    expect(out).toContain("\nb");
  });
});

describe("redact: the project's own fixtures are not credentials", () => {
  /**
   * Every string here sits one character away from a pattern above. If any of
   * them is rewritten, redaction is over-eager and has to be re-tuned before it
   * can be trusted on real output.
   */
  const FIXTURES: ReadonlyArray<{ id: string; value: string }> = [
    { id: "eval fixture key", value: 'JAA_LLM_ANTHROPIC_API_KEY = "sk-ant-test"' },
    { id: "eval fixture openrouter 1", value: "sk-or-test-123" },
    { id: "eval fixture openrouter 2", value: "sk-or-user-abc" },
    { id: "eval fixture openrouter 3", value: "sk-or-v1-abcdefghijklmnopqrstuvwxyz" },
    { id: "provider fixture", value: "apiKey: 'sk-ant-test'" },
    { id: "tools git identity", value: 'git config user.email "t@example.com"' },
    { id: "documentation domain", value: "see https://example.com/docs for the schema" },
    { id: "documentation domain with a path", value: "https://example.org/a/b?c=d#e" },
    { id: "placeholder read", value: "const token = await readFromKeyring();" },
    { id: "short prefixed string", value: "GITHUB_TOKEN=keepme" },
    { id: "an ordinary URL", value: "https://github.com/o/r.git" },
    { id: "the marker itself", value: "[redacted]" },
    { id: "empty", value: "" },
  ];

  for (const f of FIXTURES) {
    it(`leaves ${f.id} untouched`, () => {
      expect(redact(f.value)).toBe(f.value);
    });
  }

  it("is idempotent", () => {
    const once = redact(`token=${PAT}`);
    expect(redact(once)).toBe(once);
  });
});

describe("maskToken", () => {
  it("shows only the last four characters", () => {
    expect(maskToken(PAT)).toBe(`…${PAT.slice(-4)}`);
    expect(maskToken(PAT)).toHaveLength(5);
  });

  it("reveals nothing for a value of four characters or fewer", () => {
    expect(maskToken("")).toBe("…");
    expect(maskToken("a")).toBe("…");
    expect(maskToken("abcd")).toBe("…");
  });

  it("never contains more than the tail", () => {
    expect(maskToken(FINE)).not.toContain("github_pat_");
  });
});

describe("scrubEnv", () => {
  it("drops every credential-named variable", () => {
    const scrubbed = scrubEnv({
      GITHUB_TOKEN: "x",
      JAA_GITHUB_TOKEN: "x",
      GH_TOKEN: "x",
      OPENAI_API_KEY: "x",
      MY_SECRET: "x",
      DB_PASSWORD: "x",
      PASSWD: "x",
      AWS_CREDENTIALS: "x",
      GITHUB_AUTH: "x",
      lower_case_token: "x",
    });
    expect(scrubbed).toEqual({});
  });

  it("leaves ordinary plumbing alone", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/u", SystemRoot: "C:\\Windows", LANG: "en_US.UTF-8" };
    expect(scrubEnv(env)).toEqual(env);
  });

  it("does not mutate its input", () => {
    const env = { PATH: "/usr/bin", GITHUB_TOKEN: "x" };
    scrubEnv(env);
    expect(env.GITHUB_TOKEN).toBe("x");
  });

  it("returns a copy even when nothing is dropped", () => {
    const env = { PATH: "/usr/bin" };
    const out = scrubEnv(env);
    expect(out).toEqual(env);
    expect(out).not.toBe(env);
  });
});

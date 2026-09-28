/**
 * Runtime redaction.
 *
 * `scripts/check-secrets.mjs` is a *blocking* gate: it refuses a commit. This is
 * the other half — a scrubber for text that is already in memory, on its way to
 * a model, a log, or a child process. It exists because the blocking gate cannot
 * help there: by the time a credential is inside a tool result it was never
 * going to be a staged blob, it was going to be a line in a prompt.
 *
 * The patterns are the SAME length-anchored shapes the scanner proves, and for
 * the same reason: a real credential is long, a placeholder is not. That
 * anchoring is load-bearing, not decoration — the project's own fixtures
 * (`sk-ant-test`, `t@example.com`, `https://example.com`) sit one character
 * away from being rewritten, and a scrubber that eats the test corpus is a
 * scrubber that gets switched off.
 */

/** What every redaction collapses to. */
export const REDACTED = "[redacted]";

interface RedactRule {
  readonly id: string;
  readonly re: RegExp;
  /**
   * Rewrites a match. Omitted rules replace the whole match with `REDACTED`.
   * Arguments are the whole match followed by the regex's capture groups, as
   * strings, exactly as `String.prototype.replace` supplies them.
   */
  readonly render?: (match: string, ...groups: string[]) => string;
}

/**
 * One deliberate divergence from the scanner: the leading `\b` is gone.
 *
 * A word boundary is the right guard for a *gate* — it keeps the rule from
 * firing on the middle of a longer identifier. It is the wrong guard for a
 * scrubber, because a tool result routinely glues a credential to the
 * character before it (`…xxxxghp_…` in concatenated output, a token in the
 * middle of a base64-ish run), and there the boundary is absent precisely when
 * the credential is hardest to see by eye. The length anchors — the part that
 * actually keeps placeholders safe — are untouched, so this widens coverage
 * without widening false positives. The trailing `\b` stays: a token followed
 * by more word characters is a shape the scanner has never claimed, and keeping
 * parity there is worth more than the extra coverage.
 */
const RULES: readonly RedactRule[] = [
  { id: "github-oauth", re: /gh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained", re: /github_pat_[A-Za-z0-9_]{82}\b/g },
  { id: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{24,}\b/g },
  { id: "aws-access-key-id", re: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack", re: /xox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // The WHOLE block, not just the BEGIN line. Redacting only the header would
  // leave the base64 body behind, and the body is the credential. The END is
  // optional so a block already cut short still gets its header removed.
  {
    id: "private-key",
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----)?/g,
  },
  // The scheme survives so the line still reads as a URL; the userinfo is what
  // goes. This is the shape a pasted git remote takes.
  //
  // The scheme length is BOUNDED and that is not cosmetic. `[a-z0-9+.-]*` here
  // is greedy, and a greedy run followed by a literal that is usually absent
  // backtracks one character at a time from every start position: on 80 000
  // characters of unbroken URL-scheme text (a minified bundle, a long base64
  // line) that is quadratic, and it turns every clamped tool result into a
  // multi-second stall. No real scheme comes close to 20 characters — RFC 3986
  // allows more, `https`, `git+ssh` and `s3` are the long ones in practice — so
  // the bound costs nothing and makes the scan linear.
  {
    id: "url-credential",
    re: /([a-z][a-z0-9+.-]{0,19}:\/\/)(?:[^\s:@/]+:)?[^\s/@]{16,}@/gi,
    render: (_match, scheme) => `${scheme ?? ""}${REDACTED}@`,
  },
];

/**
 * Replaces every recognised credential shape in `text` with `REDACTED`.
 *
 * Deliberately NOT included: the scanner's "long value assigned to a
 * secret-looking name" rule. It is right for a gate, which may be conservative,
 * and wrong for a scrubber that runs on every tool result — its value class is
 * any long `[A-Za-z0-9_\-+/=]` run, which is also what a git SHA, a base64
 * payload and a minified bundle are made of. Rewriting those would corrupt
 * ordinary output and train callers to ignore the marker. A prefixless 40-hex
 * classic PAT is therefore out of reach here by construction; see FINDINGS.
 */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = rule.render === undefined ? out.replace(rule.re, REDACTED) : out.replace(rule.re, rule.render);
  }
  return out;
}

/**
 * Shows the last four characters of a GitHub token and nothing else.
 *
 * Deliberately different from `keyring.maskSecret`, which keeps its `"****"`
 * prefix and its own length rule: `jaa key list` is showing the operator their
 * own stored value and existing tests pin that shape, while this is what gets
 * logged about a token jaa found somewhere else. Four characters is the shortest
 * suffix that identifies a token to its owner and useless to anyone else.
 */
export function maskToken(token: string): string {
  if (token.length <= 4) return "…";
  return `…${token.slice(-4)}`;
}

/** Credential-bearing variable names, matched case-insensitively. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH/i;

/**
 * Drops every variable whose NAME looks credential-bearing.
 *
 * For handing a child process an environment. Denying by name is deliberately
 * coarse: an allowlist of known-safe names would need to be kept current, and
 * every entry added to it is a decision to expose. `PATH`, `HOME` and
 * `SystemRoot` carry no secret, so ordinary plumbing survives.
 */
export function scrubEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (CREDENTIAL_NAME.test(name)) continue;
    out[name] = value;
  }
  return out;
}

#!/usr/bin/env node
/**
 * Secret scanner for git. Run from .git/hooks/pre-commit.
 *
 * Why this exists: this repository is PUBLIC. A token that reaches a commit
 * reaches everyone who clones, and deleting the file afterwards does not
 * remove it from history.
 *
 * What it does: reads the blobs that are STAGED (not the working tree - the
 * working tree legitimately holds .env files that .gitignore covers) and the
 * commit message, and refuses the commit if either contains something that
 * looks like a live credential.
 *
 * Design notes:
 *  - It only ever prints a MASKED form. A scanner that prints what it found
 *    becomes a second copy of the secret in the terminal scrollback, in CI
 *    logs, and in whatever captures them.
 *  - Patterns are length-anchored so test fixtures like `sk-ant-test` or
 *    `sk-or-test-123` do not trip them. A real key is long; a placeholder is
 *    not.
 *  - It also catches credentials embedded in a URL (the `https://<token>@host`
 *    shape), which is how a git remote line ends up pasted into a doc.
 *  - An allowlist exists for genuine non-secrets. Add to it deliberately, with
 *    a reason; do not widen the patterns instead.
 *
 * Exit codes: 0 clean, 1 secret found, 2 could not run (fail closed).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// ---- rules -----------------------------------------------------------------

const RULES = [
  { id: "github-classic", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, why: "GitHub personal access / OAuth token" },
  { id: "github-fine", re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g, why: "GitHub fine-grained PAT" },
  { id: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g, why: "Anthropic API key" },
  { id: "aws-akid", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, why: "AWS access key id" },
  { id: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, why: "Google API key" },
  { id: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, why: "Slack token" },
  { id: "private-key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, why: "private key block" },
  {
    id: "url-credential",
    re: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s:@/]+:)?[^\s/@]{16,}@/gi,
    why: "credential embedded in a URL (git remote style)",
  },
  {
    id: "assigned-secret",
    re: /\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{32,})["']?/g,
    why: "long value assigned to a secret-looking name",
    capture: 1,
  },
];

// Deliberate exceptions. Each needs a reason; do not add a pattern instead.
const ALLOW = [
  { re: /example\.(com|org|net)/i, reason: "documentation domain" },
  { re: /\bsk-or-test-123\b/, reason: "test fixture in tests/eval.test.ts" },
  { re: /\bsk-ant-test\b/, reason: "test fixture in tests/eval.test.ts" },
  { re: /\bsk-or-user-abc\b/, reason: "test fixture in tests/eval.test.ts" },
  { re: /\bsk-or-v1-abcdefghijklmnopqrstuvwxyz\b/, reason: "test fixture in tests/eval.test.ts" },
  { re: /\bt@example\.com\b/, reason: "git identity fixture in tests/tools.test.ts" },
];

const mask = (s) => {
  const t = String(s);
  if (t.length <= 10) return `${t.slice(0, 2)}…[len ${t.length}]`;
  return `${t.slice(0, 6)}…${t.slice(-2)}[len ${t.length}]`;
};

const isAllowed = (value) => ALLOW.some((a) => a.re.test(value));

function scan(text, where, out) {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const value = rule.capture ? m[rule.capture] : m[0];
      if (!value || isAllowed(value)) continue;
      // line number, for a human to go look
      const upto = text.slice(0, m.index);
      const line = upto.split("\n").length;
      out.push({ rule: rule.id, why: rule.why, where, line, masked: mask(value) });
      break; // one finding per rule per file is enough to block
    }
  }
}

// ---- what to scan ----------------------------------------------------------
//
// Two modes, because git gives two hooks and they see different things:
//
//   default              staged blobs        -> use as .git/hooks/pre-commit
//   --message <file>     one commit message  -> use as .git/hooks/commit-msg
//   --all                every tracked file -> use in CI / before publishing
//
// --all exists because a local hook can be bypassed with --no-verify, and
// because a push is the moment a secret actually becomes public. CI runs this
// server-side on the checked-out tree, where nothing local can skip it.
//
// The message is NOT checked in the pre-commit pass: at that point
// .git/COMMIT_EDITMSG still holds the PREVIOUS commit's message, so checking
// it there would validate the wrong text and miss the one being written.

const argv = process.argv.slice(2);
const msgMode = argv[0] === "--message";
const allMode = argv[0] === "--all";
const msgFile = msgMode ? argv[1] : null;

let findings = [];
let checked = 0;
let errored = false;

try {
  if (msgMode) {
    let msg;
    try {
      msg = readFileSync(msgFile, "utf8");
    } catch (e) {
      process.stderr.write(`check-secrets: cannot read the message file ${msgFile} (${e.code}).\n`);
      errored = true;
      msg = null;
    }
    if (msg !== null) {
      // Comment lines are git's own prompts, not authored text.
      const authored = msg.split("\n").filter((l) => !l.startsWith("#")).join("\n");
      if (authored.trim()) {
        checked = 1;
        scan(authored, "commit message", findings);
      }
    }
  } else {
    const names = allMode
      ? git("ls-files", "-z").split("\0").filter(Boolean)
      : // Staged files that are new, modified, copied, renamed or merged.
        git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);

    for (const name of names) {
      let blob;
      if (allMode) {
        // Read the CHECKED-OUT TREE, not HEAD. Reading HEAD would silently scan
        // nothing in a repo with no commits, and would miss an uncommitted file -
        // a guard that reports "clean" because it looked at the wrong thing is
        // worse than no guard at all. CI runs this against the working tree,
        // which is exactly the tree about to be published.
        try {
          blob = readFileSync(name, "utf8");
        } catch (e) {
          // A tracked file we cannot read is an error, not a skip.
          process.stderr.write(`check-secrets: cannot read tracked file ${name} (${e.code}).\n`);
          errored = true;
          continue;
        }
      } else {
        try {
          blob = git("show", `:${name}`);
        } catch {
          continue; // binary, or vanished between the two git calls
        }
      }
      // Skip obvious binaries: a NUL byte means git will not treat it as text.
      if (blob.includes("\0")) continue;
      checked++;
      scan(blob, name, findings);
    }
  }
} catch (e) {
  errored = true;
  process.stderr.write(`check-secrets: could not complete the scan (${e.message}).\n`);
}

// ---- verdict ----------------------------------------------------------------

if (errored) {
  process.stderr.write("check-secrets: FAILING CLOSED - the scan did not finish.\n");
  process.exit(2);
}

if (findings.length) {
  process.stderr.write("\ncheck-secrets: refusing the commit.\n\n");
  process.stderr.write(
    `  ${findings.length} possible secret(s) in ${checked} ${msgMode ? "message" : allMode ? "tracked file(s)" : "staged file(s)"}:\n\n`,
  );
  for (const f of findings) {
    process.stderr.write(`    ${f.where}${f.line ? `:${f.line}` : ""}\n`);
    process.stderr.write(`      rule   ${f.rule} - ${f.why}\n`);
    process.stderr.write(`      value  ${f.masked}   (masked on purpose)\n\n`);
  }
  process.stderr.write(
    "  If one of these is a genuine non-secret, add it to the ALLOW list in\n" +
      "  scripts/check-secrets.mjs WITH a reason. Do not weaken the pattern.\n\n" +
      "  Nothing was written and nothing was staged by this check.\n",
  );
  process.exit(1);
}

process.stderr.write(
  `check-secrets: clean (${checked} ${msgMode ? "message" : allMode ? "tracked file(s)" : "staged file(s)"} scanned).\n`,
);
process.exit(0);

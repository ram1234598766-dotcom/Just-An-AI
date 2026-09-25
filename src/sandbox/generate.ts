import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { SandboxPolicy } from "./types.js";

/**
 * Reject a policy before it is turned into a confinement profile.
 *
 * A root that is not absolute, or that contains a NUL, would silently widen the
 * sandbox: a relative root resolves against whatever cwd the launcher happens to
 * have. Fail loudly instead.
 */
export function validatePolicy(policy: SandboxPolicy): string[] {
  const problems: string[] = [];
  for (const root of [...policy.writableRoots, ...policy.readableRoots]) {
    if (root.includes("\0")) problems.push(`root contains a null byte: ${JSON.stringify(root)}`);
    if (!isAbsolute(root)) problems.push(`root must be absolute: ${root}`);
    else {
      const tooBroad = broadRootReason(root, "root");
      if (tooBroad !== undefined) problems.push(tooBroad);
    }
  }
  if (!isAbsolute(policy.cwd)) problems.push(`cwd must be absolute: ${policy.cwd}`);
  else {
    const tooBroad = broadRootReason(policy.cwd, "cwd");
    if (tooBroad !== undefined) problems.push(tooBroad);
  }

  // A readable root that contains a writable one cannot be granted read-only
  // without also granting write, because the child mount sits inside it. Refuse
  // the overlap rather than silently downgrading the writable root.
  for (const writable of policy.writableRoots) {
    for (const readable of policy.readableRoots) {
      if (isAncestor(readable, writable) && resolve(readable) !== resolve(writable)) {
        problems.push(
          `readable root ${readable} contains writable root ${writable}; ` +
            `the writable root would be shadowed and could not be honoured`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reason `root` is too broad to confine, or `undefined` if it is acceptable.
 *
 * A two-entry denylist (the filesystem root and exactly `$HOME`) is not enough:
 * `$HOME/..` -- `/home` or `/Users` -- contains every account's `.ssh` and
 * `.aws`, and a symlink inside the workspace can point anywhere. So: reject any
 * root that is an ancestor of `$HOME`, and resolve symlinks before judging.
 */
function broadRootReason(root: string, label: "root" | "cwd"): string | undefined {
  const abs = resolve(root);
  const message = (detail: string): string => `${label} is too broad to sandbox safely: ${detail}`;

  // Resolve symlinks so a link to `/` inside the workspace cannot slip through.
  // A root that does not exist yet cannot be a symlink.
  let real = abs;
  if (existsSync(abs)) {
    try {
      real = realpathSync.native(abs);
    } catch {
      return message(abs);
    }
  }

  if (real === parse(real).root) return message(abs);
  try {
    const home = realpathSync.native(resolve(homedir()));
    if (real === home) return message(abs);
    if (isAncestor(real, home)) return message(`${abs} (contains the home directory)`);
  } catch {
    // No resolvable home directory; the filesystem-root check above still holds.
  }
  return undefined;
}

/** True when `ancestor` contains `descendant` at a path-segment boundary. */
function isAncestor(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Render a path as an SBPL string literal.
 *
 * `JSON.stringify` already produces correct quoting and escaping for the
 * Scheme-style strings Seatbelt uses, so it does the whole job. Escaping
 * backslashes by hand first would double-escape them.
 */
function sbplQuote(path: string): string {
  return JSON.stringify(path);
}

/**
 * System paths a confined process must be able to read just to start.
 *
 * Without these, `deny default` blocks dyld from reading the shared cache and
 * libc, and no command can exec at all. This is not a grant of user data: it
 * is the minimum for a process image to load.
 */
const SYSTEM_READ_PATHS = ["/usr", "/bin", "/sbin", "/System", "/Library", "/private/var/db", "/dev", "/proc"];

/**
 * Generate a macOS Seatbelt (SBPL) profile for `sandbox-exec`.
 *
 * Built deny-by-default: only the paths and operations the policy names are
 * allowed, so an unlisted capability is refused rather than inherited.
 */
export function generateSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = ["(version 1)", "(deny default)"];

  // The minimum a process needs just to exist and reach libc.
  lines.push("(allow process-exec*)");
  lines.push("(allow sysctl-read)");
  lines.push("(allow mach-lookup)");
  lines.push("(allow signal (target self))");
  lines.push("(allow file-read-metadata)");

  for (const root of [...SYSTEM_READ_PATHS, ...policy.readableRoots]) {
    lines.push(`(allow file-read* (subpath ${sbplQuote(root)}))`);
  }
  for (const root of policy.writableRoots) {
    lines.push(`(allow file-write* (subpath ${sbplQuote(root)}))`);
  }

  if (policy.network) {
    lines.push("(allow network*)");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * System directories exposed read-only inside the bubblewrap sandbox.
 *
 * Deliberately an allowlist rather than `--ro-bind / /`: binding the whole
 * filesystem read-only would make `readableRoots` decorative and hand the
 * command `~/.ssh`, `~/.aws`, and the keyring in `~/.jaa`.
 */
const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/var/empty"];

/**
 * System directories to expose read-only, skipping any absent on this host.
 *
 * bwrap aborts on a missing `--ro-bind` source, and the list is a cross-platform
 * union: `/var/empty` exists on macOS and nowhere else, `/lib64` is Debian-family
 * and absent on Arch. Binding an absent path made every sandboxed command exit 1
 * on Linux while `jaa doctor` still reported a working sandbox, because the
 * capability probe used a different argv. Hence the filter, and hence F8's fix.
 */
function existingSystemRoots(): string[] {
  return SYSTEM_ROOTS.filter((root) => {
    try {
      return existsSync(root);
    } catch {
      return false;
    }
  });
}

/**
 * Generate bubblewrap arguments.
 *
 * Order matters. System roots and writable roots are bound first, then the
 * declared readable roots are bound read-only *last*, so a readable path nested
 * inside a writable one stays read-only instead of being shadowed by it.
 */
export function generateBwrapArgs(policy: SandboxPolicy, command: string, args: string[]): string[] {
  const out: string[] = [];

  for (const root of existingSystemRoots()) out.push("--ro-bind", root, root);

  // Writable roots first, then the declared readable roots read-only on top.
  // The reverse order would let a writable parent shadow a read-only child and
  // silently turn `readable` into `writable`.
  for (const root of policy.writableRoots) {
    const abs = resolve(root);
    out.push("--bind", abs, abs);
  }
  const writable = policy.writableRoots.map((r) => resolve(r));
  for (const root of policy.readableRoots) {
    const abs = resolve(root);
    // A path that is itself writable needs no second bind, and neither does one
    // that CONTAINS a writable root -- binding it read-only here would shadow
    // that writable root and make the policy unhonourable. `validatePolicy`
    // rejects that overlap, so skipping is defence in depth, not a silent fix.
    if (writable.some((w) => w === abs || isAncestor(abs, w))) continue;
    out.push("--ro-bind", abs, abs);
  }

  // Before the policy binds: `--tmpfs /tmp` hides everything under `/tmp`, so a
  // workspace that legitimately lives there (or under a temp dir created by a
  // test) would otherwise vanish and its declared writable root would be
  // unwritable.
  const needsTmpfs = ![...policy.writableRoots, ...policy.readableRoots].some((r) => isUnderTmp(resolve(r)));
  if (needsTmpfs) out.push("--tmpfs", "/tmp");
  out.push("--dev", "/dev", "--proc", "/proc");

  if (!policy.network) {
    out.push("--unshare-net");
  }
  // A private PID namespace so the command cannot signal same-uid host
  // processes, which is what makes the `process-tree` claim true.
  out.push("--unshare-pid", "--die-with-parent", "--new-session");

  // Start from an empty environment, then pass through only what the policy
  // names. Without `--clearenv` bwrap inherits the whole parent environment, so
  // `envPassthrough` reads like an allowlist while doing nothing: every provider
  // API key in the operator's shell was visible to the command.
  out.push("--clearenv");
  for (const name of policy.envPassthrough) {
    const value = process.env[name];
    if (value !== undefined) out.push("--setenv", name, value);
  }
  // `NODE_OPTIONS` would otherwise let the parent inject `--require` into the
  // child node process. Outside the loop, so it is cleared even when the
  // passthrough list is empty.
  out.push("--unsetenv", "NODE_OPTIONS");

  out.push("--", command, ...args);
  return out;
}

/** True when `abs` is `/tmp` or lies beneath it. */
function isUnderTmp(abs: string): boolean {
  const tmp = resolve("/tmp");
  return abs === tmp || isAncestor(tmp, abs);
}

/**
 * Generate Landlock helper arguments.
 *
 * Landlock is enforced by a small helper that must already be installed; jaa
 * does not ship a compiled binary. The helper takes explicit rules on stdin in
 * a fixed order, which is why this returns the argv and the rule document
 * separately rather than a single string.
 */
export function generateLandlockArgs(command: string, args: string[]): string[] {
  return ["--", command, ...args];
}

export function generateLandlockRules(policy: SandboxPolicy): string {
  const rules: string[] = [];
  for (const root of policy.readableRoots) rules.push(`read ${resolve(root)}`);
  for (const root of policy.writableRoots) rules.push(`write ${resolve(root)}`);
  if (policy.network) rules.push("network allow");
  else rules.push("network deny");
  return `${rules.join("\n")}\n`;
}

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBwrapArgs, generateSeatbeltProfile } from "./generate.js";
import type { Guarantee, SandboxCapability, SandboxMechanism } from "./types.js";

/**
 * Run a binary under a trivial confinement and report whether it worked.
 *
 * Only a clean exit counts. `execFile` puts a process's exit status in
 * `err.code` as a *number*, so treating "err is set" as failure would report a
 * binary that exists but cannot sandbox as available, and the caller would then
 * claim a boundary that does not exist. A sandbox that denies the probe command
 * is a failure, not a success.
 *
 * A *synchronous* throw from `execFile` (invalid argument, for instance) is also
 * a failure, and must not reject: this feeds `runProcess`, which must turn an
 * unusable sandbox into a refusal rather than an exception.
 */
function probe(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolveProbe) => {
    try {
      execFile(bin, args, { timeout: 10_000, windowsHide: true }, (err) => {
        if (err === null) {
          resolveProbe(true);
          return;
        }
        const code = (err as { code?: unknown }).code;
        resolveProbe(typeof code === "number" && code === 0);
      });
    } catch {
      resolveProbe(false);
    }
  });
}

const NO_GUARANTEES: SandboxCapability["enforces"] = [];

/**
 * What each platform can genuinely enforce, stated up front.
 *
 * These lists are the contract. `doesNotEnforce` is not a disclaimer, it is
 * what stops a caller from reporting isolation it did not get.
 */
const PLATFORM_SUPPORT: Record<
  string,
  {
    mechanism: SandboxMechanism;
    binary?: string;
    probeArgs?: string[];
    enforces: Guarantee[];
    doesNotEnforce: Guarantee[];
    reason?: string;
  }
> = {
  darwin: {
    mechanism: "seatbelt",
    binary: "/usr/bin/sandbox-exec",
    // Existence only. Whether it can actually confine is decided afterwards by
    // `probeRealProfile`, which uses the real profile generators.
    probeArgs: ["-p", "(version 1)(deny default)(allow process-exec*)", "/usr/bin/true"],
    enforces: ["filesystem-read", "filesystem-write", "network"],
    doesNotEnforce: [],
  },
  linux: {
    mechanism: "bubblewrap",
    binary: "bwrap",
    probeArgs: ["--version"],
    enforces: ["filesystem-read", "filesystem-write", "network", "process-tree"],
    doesNotEnforce: [],
  },
  win32: {
    mechanism: "none",
    enforces: NO_GUARANTEES,
    doesNotEnforce: ["filesystem-read", "filesystem-write", "network", "process-tree"],
    reason:
      "Windows has no per-command sandbox reachable from pure Node: sandbox-exec and bubblewrap are " +
      "POSIX-only, and Job Objects need a native binding that Node does not ship. Real isolation on " +
      "Windows requires a native module, a WSL distro, or a container. jaa reports this rather than " +
      "claiming a boundary it cannot enforce.",
  },
};

const cache = new Map<NodeJS.Platform, SandboxCapability>();

/** Probe (and memoise, per platform) what this host can enforce. */
export async function detectCapability(platform: NodeJS.Platform = process.platform): Promise<SandboxCapability> {
  const memo = cache.get(platform);
  if (memo !== undefined) return memo;
  const result = await probePlatform(platform);
  cache.set(platform, result);
  return result;
}

async function probePlatform(platform: NodeJS.Platform): Promise<SandboxCapability> {
  const support = PLATFORM_SUPPORT[platform];
  if (!support) {    const result: SandboxCapability = {
      platform,
      mechanism: "none",
      available: false,
      reason: `unsupported platform: ${platform}`,
      enforces: NO_GUARANTEES,
      doesNotEnforce: ["filesystem-read", "filesystem-write", "network", "process-tree"],
      summary: `no sandbox for ${platform}`,
    };
    return result;
  }

  if (support.binary === undefined) {
    const result: SandboxCapability = {
      platform,
      mechanism: support.mechanism,
      available: false,
      ...(support.reason !== undefined ? { reason: support.reason } : {}),
      enforces: NO_GUARANTEES,
      doesNotEnforce: support.doesNotEnforce,
      summary: `unavailable: ${support.reason ?? "no mechanism"}`,
    };
    return result;
  }

  const found = await probe(support.binary, support.probeArgs ?? ["--version"]);
  if (!found) {
    const result: SandboxCapability = {
      platform,
      mechanism: support.mechanism,
      available: false,
      reason: `${support.binary} was not found on PATH or refused to run`,
      enforces: NO_GUARANTEES,
      doesNotEnforce: support.doesNotEnforce,
      summary: `unavailable: ${support.binary} not usable`,
    };
    return result;
  }

  // Probe with the argv a real command will actually use, not a hand-written
  // stand-in. A probe that omits `--unshare-pid`, `--dev`, `--proc`,
  // `--clearenv`, or a bind source can pass on a host where every real
  // invocation then fails -- which is exactly what happened with a macOS-only
  // bind source in the system roots while `doctor` still reported a working
  // sandbox. A host that cannot run the real argv is a host we cannot use.
  const binary = support.binary;
  // Narrowed above: any platform with a binary is probeable.
  const usable = await probeRealProfile({ mechanism: support.mechanism, binary });
  if (!usable) {
    const result: SandboxCapability = {
      platform,
      mechanism: support.mechanism,
      available: false,
      reason: `${support.binary} is present but could not run a real confinement profile`,
      enforces: NO_GUARANTEES,
      doesNotEnforce: support.doesNotEnforce,
      summary: `unavailable: ${support.binary} cannot enforce a real profile`,
    };
    return result;
  }

  const result: SandboxCapability = {
    platform,
    mechanism: support.mechanism,
    available: true,
    enforces: support.enforces,
    doesNotEnforce: support.doesNotEnforce,
    summary: `${support.mechanism} (${support.enforces.join("+") || "no guarantees"})`,
  };
  return result;
}

/**
 * Run the mechanism's real profile over a throwaway workspace.
 *
 * Uses the same generators the sandbox uses at run time, so the probe fails
 * whenever a real command would fail.
 */
async function probeRealProfile(support: { mechanism: SandboxMechanism; binary: string }): Promise<boolean> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "jaa-sandbox-probe-"));
  } catch {
    return false;
  }
  try {
    const policy = {
      writableRoots: [dir],
      readableRoots: [dir],
      network: false,
      cwd: dir,
      envPassthrough: [],
    } satisfies SandboxPolicyLike;
    if (support.mechanism === "seatbelt") {
      return await probe(support.binary, ["-p", generateSeatbeltProfile(policy), "/usr/bin/true"]);
    }
    // `generateBwrapArgs` needs a shell that the profile can reach; /bin/sh is
    // covered by the system-root allowlist on every Linux distribution.
    return await probe(support.binary, [...generateBwrapArgs(policy, "/bin/sh", ["-c", "exit 0"])]);
  } catch {
    return false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not worth failing the probe over.
    }
  }
}

type SandboxPolicyLike = Parameters<typeof generateBwrapArgs>[0];

/** Test seam: forget the memoised probe result. */
export function resetCapabilityCache(): void {
  cache.clear();
}

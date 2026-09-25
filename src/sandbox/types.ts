export const SANDBOX_MECHANISMS = ["seatbelt", "landlock", "bubblewrap", "none"] as const;
export type SandboxMechanism = (typeof SANDBOX_MECHANISMS)[number];

/** Individual guarantees a mechanism can actually provide. */
export type Guarantee = "filesystem-read" | "filesystem-write" | "network" | "process-tree";

export interface SandboxPolicy {
  /** Absolute paths the command may write to. */
  writableRoots: string[];
  /** Absolute paths the command may read. Defaults to the writable roots plus system paths. */
  readableRoots: string[];
  /** Whether outbound network access is permitted. */
  network: boolean;
  /** Workspace the command runs in. */
  cwd: string;
  /** Environment variable names to pass through. Values are never logged. */
  envPassthrough: string[];
}

export type SandboxEnforcement = "require" | "best-effort";

/**
 * What the host can actually do.
 *
 * `enforces` and `doesNotEnforce` are both populated deliberately: a caller
 * must be able to tell the difference between "isolated" and "best effort"
 * without reading the platform module.
 */
export interface SandboxCapability {
  platform: NodeJS.Platform;
  mechanism: SandboxMechanism;
  available: boolean;
  /** Why it is unavailable. Present whenever `available` is false. */
  reason?: string;
  enforces: Guarantee[];
  doesNotEnforce: Guarantee[];
  /** Human-readable summary for `jaa doctor`. */
  summary: string;
}

export interface SandboxWrap {
  command: string;
  args: string[];
  /** False when the command could not be wrapped and must not run. */
  wrapped: boolean;
  mechanism: SandboxMechanism;
  /** Set when wrapping failed, explaining why the command was refused. */
  refusal?: string;
}

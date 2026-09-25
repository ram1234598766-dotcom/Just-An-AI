import { generateBwrapArgs, generateSeatbeltProfile, validatePolicy } from "./generate.js";
import type { SandboxCapability, SandboxPolicy, SandboxWrap } from "./types.js";

/**
 * Wrap a command so it runs under the platform's confinement mechanism.
 *
 * Fail-closed: if a policy is supplied and the host cannot enforce it, the
 * command is not run at all and `wrapped` is false. Running it anyway and
 * merely reporting the degradation would be a lie about the boundary.
 */
export function wrapCommand(
  policy: SandboxPolicy,
  capability: SandboxCapability,
  command: string,
  args: string[],
  enforcement: "require" | "best-effort" = "require",
): SandboxWrap {
  const problems = validatePolicy(policy);
  if (problems.length > 0) {
    return {
      command,
      args,
      wrapped: false,
      mechanism: capability.mechanism,
      refusal: `invalid sandbox policy: ${problems.join("; ")}`,
    };
  }

  if (!capability.available) {
    if (enforcement === "require") {
      return {
        command,
        args,
        wrapped: false,
        mechanism: "none",
        refusal:
          `sandbox required but unavailable on this host. ${capability.reason ?? ""}`.trim() +
          " The command was not run. Use --no-sandbox to run it without isolation, which is not " +
          "recommended, or run inside a container or VM.",
      };
    }
    return { command, args, wrapped: false, mechanism: "none" };
  }

  switch (capability.mechanism) {
    case "seatbelt":
      return {
        command: "/usr/bin/sandbox-exec",
        args: ["-p", generateSeatbeltProfile(policy), command, ...args],
        wrapped: true,
        mechanism: "seatbelt",
      };
    case "bubblewrap":
      return {
        command: "bwrap",
        args: generateBwrapArgs(policy, command, args),
        wrapped: true,
        mechanism: "bubblewrap",
      };
    default:
      // `landlock` is deliberately not handled: it needs a helper binary that
      // jaa does not ship. Wrapping it with bubblewrap would silently apply the
      // wrong mechanism, so it is refused instead.
      return {
        command,
        args,
        wrapped: false,
        mechanism: "none",
        refusal: `no usable sandbox mechanism for ${capability.mechanism}`,
      };
  }
}

/** One-line description of what a policy would permit, for doctor output. */
export function describePolicy(policy: SandboxPolicy): string {
  const w = policy.writableRoots.length;
  const r = policy.readableRoots.length;
  return `write:${w} root(s) read:${r} root(s) network:${policy.network ? "on" : "off"}`;
}

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hasKey } from "./config/keyring.js";
import { providerStatuses } from "./config/providers.js";
import { resolveEngine } from "./permissions/index.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  key: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

const NODE_REQUIRED_MAJOR = 22;

function nodeCheck(): DoctorCheck {
  const raw = process.version.slice(1);
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  const ok = Number.isFinite(major) && major >= NODE_REQUIRED_MAJOR;
  return {
    key: "node-version",
    status: ok ? "ok" : "fail",
    message: `node ${process.version} (>= ${NODE_REQUIRED_MAJOR} required)`,
  };
}

function platformCheck(): DoctorCheck {
  return {
    key: "platform",
    status: "info",
    message: `${process.platform} ${process.arch}`,
  };
}

function dataDirCheck(): DoctorCheck {
  const dir = join(homedir(), ".jaa");
  const exists = existsSync(dir);
  return {
    key: "data-dir",
    status: "info",
    message: `${dir}${exists ? "" : " (not yet created)"}`,
  };
}

function gitCheck(): DoctorCheck {
  try {
    const out = execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return { key: "git", status: "ok", message: out };
  } catch {
    return {
      key: "git",
      status: "warn",
      message: "git not found on PATH",
      detail: "The agent falls back to a built-in file API, but version control features need git.",
    };
  }
}

function tmpCheck(): DoctorCheck {
  const probe = join(tmpdir(), `.jaa-doctor-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "1");
    rmSync(probe, { force: true });
    return { key: "tmp-writable", status: "ok", message: `temp dir writable: ${tmpdir()}` };
  } catch (err) {
    return {
      key: "tmp-writable",
      status: "fail",
      message: `temp dir not writable: ${tmpdir()}`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function providersCheck(): DoctorCheck {
  const statuses = providerStatuses((def) => hasKey(def));
  const configured = statuses.filter((s) => s.configured);
  const detail =
    configured.length === 0
      ? "none yet — run `jaa setup` to configure a provider"
      : configured.map((s) => `${s.id}${s.localOnly ? " (local)" : s.source ? ` (${s.source})` : ""}`).join(", ");
  return {
    key: "providers",
    status: configured.length > 0 ? "ok" : "info",
    message: `${configured.length} provider(s) configured`,
    detail,
  };
}

/**
 * Report the effective permission posture: which mode is active, whether a
 * Claude Code policy was imported, and whether bash is reachable at all. The
 * point is that an operator can always answer "what is this session allowed
 * to do" without reading the source.
 */
function permissionsCheck(): DoctorCheck {
  const { mode, rules, projectPolicyFound, projectPolicyApplied } = resolveEngine();
  const denies = rules.filter((r) => r.decision === "deny");
  const allows = rules.filter((r) => r.decision === "allow");
  const bashAllowed = rules.some((r) => r.decision === "allow" && (r.tool === "bash" || r.tool === undefined));
  const parts = [
    `${allows.length} allow / ${denies.length} deny rule(s)`,
    projectPolicyFound
      ? projectPolicyApplied
        ? "project .claude/settings.json APPLIED"
        : "project .claude/settings.json found but NOT applied (untrusted repo)"
      : "no project .claude/settings.json",
    bashAllowed ? "bash IS allowed by an explicit rule" : "bash is gated in every mode",
  ];
  return {
    key: "permissions",
    status: bashAllowed || projectPolicyApplied ? "warn" : "ok",
    message: `permission mode: ${mode}`,
    detail: parts.join("; "),
  };
}

/**
 * Runs environment diagnostics. All checks are synchronous; git probe uses
 * execFileSync under a try/catch so a missing git never throws.
 */
export function runDoctor(): DoctorReport {
  return {
    checks: [
      nodeCheck(),
      platformCheck(),
      dataDirCheck(),
      gitCheck(),
      providersCheck(),
      permissionsCheck(),
      tmpCheck(),
    ],
  };
}

/** Renders a report as aligned terminal lines. */
export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const marker = `[${c.status}]`;
    return `${marker.padEnd(7)} ${c.key.padEnd(12)} ${c.message}${c.detail ? `\n${" ".repeat(21)}↳ ${c.detail}` : ""}`;
  });
  return lines.join("\n");
}
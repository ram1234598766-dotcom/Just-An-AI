import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec, ParsedAgents } from "./types.js";

const AGENTS_FILENAME = "AGENTS.md";

/**
 * Parse the contents of an AGENTS.md file into project context + subagent specs.
 *
 * Format:
 *   # AGENTS.md
 *   <project context markdown>
 *   ## Subagents
 *   ### <name>
 *   - **Description**: <value>
 *   - **Ownership**: <glob patterns>
 *   - **Deps**: <comma-separated agent names or "none">
 *   - **Acceptance**: <criteria>
 *   - **Instructions**: <system prompt>
 *   - **Model**: <provider id, or "provider model">
 *   - **Tools**: <comma-separated tool names or globs>
 *   - **DisallowedTools**: <comma-separated tool names or globs>
 *   - **Skills**: <comma-separated skill names to preload>
 *   - **MaxTurns**: <positive integer>
 *   - **Isolation**: <none or worktree>
 *   - **Background**: <true or false>
 *   ### <next-name>
 *   ...
 *
 * The six Phase 15 fields are optional and every one of them narrows. A value
 * that cannot mean what it claims is dropped rather than clamped, so an
 * unparseable `MaxTurns` leaves the agent with no cap from *this* file — the
 * runner's own default, which is always present — instead of a cap of 0 or of
 * `NaN`.
 */
export function parseAgents(content: string): ParsedAgents {
  const text = content.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const subagentsIdx = lines.findIndex((l) => l.trim() === "## Subagents");
  if (subagentsIdx === -1) {
    return { projectContext: content.trim(), subagents: [] };
  }

  const projectContext = lines.slice(0, subagentsIdx).join("\n").trim();
  const subagents = parseSubagents(lines.slice(subagentsIdx + 1));

  return { projectContext, subagents };
}

/** Parse everything after the `## Subagents` heading. */
function parseSubagents(lines: string[]): AgentSpec[] {
  const specs: AgentSpec[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i]?.match(/^###\s+(.+)$/);
    if (!header) {
      i++;
      continue;
    }

    const name = header[1]!.trim();
    const spec: AgentSpec = {
      name,
      description: "",
      ownership: "",
      deps: "",
      acceptance: "",
      instructions: "",
    };

    i++;
    while (i < lines.length) {
      const line = lines[i];
      const nextHeader = line?.match(/^##{1,3}\s+/);
      if (nextHeader) break;

      const fieldMatch = line?.match(/^-\s+\*\*(\w+)\*\*:\s*(.*)$/);
      if (fieldMatch) {
        const key = fieldMatch[1]!;
        let value = fieldMatch[2]!;
        i++;
        // Collect continuation lines (indented, non-empty)
        while (i < lines.length && lines[i] && /^  /.test(lines[i]!) && lines[i]!.trim() !== "") {
          value += "\n" + lines[i]!.trim();
          i++;
        }
        assignField(spec, key, value);
        continue;
      }
      i++;
    }

    specs.push(spec);
  }

  return specs;
}

function assignField(spec: AgentSpec, key: string, value: string): void {
  switch (key) {
    case "Description":
      spec.description = value;
      break;
    case "Ownership":
      spec.ownership = value;
      break;
    case "Deps":
      spec.deps = value;
      break;
    case "Acceptance":
      spec.acceptance = value;
      break;
    case "Instructions":
      spec.instructions = value;
      break;
    // Phase 15 execution controls. Each is normalised here rather than at the
    // use site, so a value that cannot mean what it claims (`MaxTurns: many`)
    // is dropped at the boundary instead of reaching a cap that trusts it.
    case "Model": {
      const model = value.trim();
      if (model !== "") spec.model = model;
      break;
    }
    case "Tools": {
      const list = splitList(value);
      if (list.length > 0) spec.tools = list.join(", ");
      break;
    }
    case "DisallowedTools": {
      const list = splitList(value);
      if (list.length > 0) spec.disallowedTools = list.join(", ");
      break;
    }
    case "Skills": {
      const list = splitList(value);
      if (list.length > 0) spec.skills = list.join(", ");
      break;
    }
    case "MaxTurns": {
      const turns = Number.parseInt(value.trim(), 10);
      // A cap of 0 or a negative number would stop the agent before it starts,
      // and `NaN` would silently remove the cap, so both are dropped and the
      // caller's default applies.
      if (Number.isInteger(turns) && turns > 0) spec.maxTurns = turns;
      break;
    }
    case "Isolation": {
      const mode = value.trim().toLowerCase();
      if (mode === "worktree" || mode === "none") spec.isolation = mode;
      break;
    }
    case "Background": {
      const flag = value.trim().toLowerCase();
      if (flag === "true" || flag === "yes") spec.background = true;
      else if (flag === "false" || flag === "no") spec.background = false;
      break;
    }
  }
}

/**
 * Split a comma-separated AGENTS.md field into its entries.
 *
 * Accepts commas, whitespace, or both, because the three fields that use it are
 * written by hand and `read_file, write_file` is as likely as `read_file,
 * write_file` or `read_file write_file`.
 */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .flatMap((part) => part.trim().split(/\s+/))
    .filter((entry) => entry !== "");
}

/** Load and parse AGENTS.md from the workspace root. */
export function loadAgents(root: string = process.cwd()): ParsedAgents {
  const file = join(root, AGENTS_FILENAME);
  if (!existsSync(file)) {
    return { projectContext: "", subagents: [] };
  }
  const content = readFileSync(file, "utf8");
  return parseAgents(content);
}

/** Find a subagent spec by name. */
export function findAgent(agents: ParsedAgents, name: string): AgentSpec | undefined {
  return agents.subagents.find((a) => a.name === name);
}

/** Read AGENTS.md from `root` and return the spec for `name`. */
export function getAgentSpec(root: string, name: string): AgentSpec | undefined {
  return findAgent(loadAgents(root), name);
}

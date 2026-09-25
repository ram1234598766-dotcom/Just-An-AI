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
 *   ### <next-name>
 *   ...
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
  }
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

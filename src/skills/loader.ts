import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedFrontmatter, Skill } from "./types.js";
import { jaaPaths } from "../config/paths.js";

const SKILL_FILENAME = "SKILL.md";

/**
 * Minimal YAML frontmatter parser for the two field shapes actually used
 * by skill files:
 *
 *   name: my-skill
 *   description: "does something useful"
 *   triggers:
 *     - "use when foo"
 *     - bar
 *
 * Everything after the closing `---` is the markdown body.  No full YAML
 * dependency — we only need strings and string arrays.
 */
export function parseFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: { name: "", description: "", triggers: [] }, body: raw };
  }

  const lines = text.split("\n");
  let fence = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") fence = i;
  }
  if (fence <= 0) {
    return { frontmatter: { name: "", description: "", triggers: [] }, body: raw };
  }

  const yamlLines = lines.slice(1, fence);
  const body = lines.slice(fence + 1).join("\n").trim();

  const parsed = parseSimpleYaml(yamlLines);
  return {
    frontmatter: {
      name: typeof parsed.name === "string" ? stripQuotes(parsed.name) : "",
      description: typeof parsed.description === "string" ? stripQuotes(parsed.description) : "",
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.filter((v): v is string => typeof v === "string").map(stripQuotes)
        : [],
    },
    body,
  };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a very small subset of YAML: top-level `key: value` lines and `key:`
 * followed by `- item` lines.  No nesting, no flow style.
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let arrayKey: string | null = null;
  let array: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const kv = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1]!;
      const value = kv[2]!.trim();

      if (arrayKey !== null) {
        result[arrayKey] = array;
        arrayKey = null;
        array = [];
      }

      if (value === "") {
        arrayKey = key;
        array = [];
      } else {
        result[key] = stripQuotes(value);
      }
    } else if (trimmed.startsWith("- ") && arrayKey !== null) {
      array.push(stripQuotes(trimmed.slice(2).trim()));
    }
  }

  if (arrayKey !== null) {
    result[arrayKey] = array;
  }

  return result;
}

/** Load a single skill by directory name under `~/.jaa/skills/`. */
export function loadSkill(id: string): Skill | undefined {
  const skillFile = join(jaaPaths().skillsDir, id, SKILL_FILENAME);
  if (!existsSync(skillFile)) return undefined;
  try {
    const content = readFileSync(skillFile, "utf8");
    return parseSkill(id, skillFile, content);
  } catch {
    return undefined;
  }
}

/** Parse a SKILL.md file's content into a Skill object. */
export function parseSkill(id: string, path: string, content: string): Skill {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    id,
    name: frontmatter.name || id,
    description: frontmatter.description,
    triggers: frontmatter.triggers,
    body,
    path,
  };
}

/** Load every skill found under `~/.jaa/skills/<id>/SKILL.md`. */
export function loadSkills(): Skill[] {
  const skillsDir = jaaPaths().skillsDir;
  if (!existsSync(skillsDir)) return [];

  const skills: Skill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = loadSkill(entry.name);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** Ensure the skills directory exists (idempotent). */
export function ensureSkillsDir(): void {
  const dir = jaaPaths().skillsDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

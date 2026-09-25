/** Skill metadata + body, loaded from `~/.jaa/skills/<id>/SKILL.md`. */
export interface Skill {
  /** Directory name under `~/.jaa/skills/`. */
  id: string;
  /** Human-readable name (from frontmatter; falls back to id). */
  name: string;
  /** Short description (from frontmatter). */
  description: string;
  /** Lowercased phrases from frontmatter `triggers:` array. */
  triggers: string[];
  /** Markdown body — injected into the system prompt when the skill autotriggers. */
  body: string;
  /** Absolute path to the SKILL.md file (for display / debugging). */
  path: string;
}

/** Parsed YAML frontmatter fields extracted from a SKILL.md file. */
export interface ParsedFrontmatter {
  name: string;
  description: string;
  triggers: string[];
}

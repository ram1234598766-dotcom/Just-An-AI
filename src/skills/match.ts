import type { Skill } from "./types.js";

/**
 * Compute the trigger phrases that should fire autotrigger matching for a
 * skill.  Explicit `triggers:` from frontmatter always win.  When absent, the
 * skill name serves as a fallback trigger (so a skill named `code-reviewer`
 * fires on any prompt containing "code-reviewer").
 */
export function effectiveTriggers(skill: Skill): string[] {
  if (skill.triggers.length > 0) return skill.triggers;
  return [skill.name];
}

/** True when the prompt contains any of the skill's trigger phrases. */
export function skillMatches(skill: Skill, prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return effectiveTriggers(skill).some((t) => lower.includes(t.toLowerCase()));
}

/**
 * Return the subset of `skills` whose triggers fire on `prompt`.
 */
export function matchSkills(skills: Skill[], prompt: string): Skill[] {
  return skills.filter((s) => skillMatches(s, prompt));
}

/**
 * Build the system-prompt injection string for matched skills.  Each skill's
 * body is wrapped in delimited markers so the model can identify skill
 * contributions.
 */
export function skillContext(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map((s) => `---\n# Skill: ${s.name}\n${s.description}\n\n${s.body}`)
    .join("\n\n");
}

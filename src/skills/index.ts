export { type Skill } from "./types.js";
export { parseFrontmatter, parseSkill, loadSkill, loadSkills, ensureSkillsDir } from "./loader.js";
export { effectiveTriggers, skillMatches, matchSkills, skillContext } from "./match.js";
export {
  installFromGitHub,
  installFromUrl,
  removeSkill,
  listSkillIds,
} from "./install.js";
export type { InstallResult } from "./install.js";

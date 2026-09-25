import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  parseSkill,
  loadSkill,
  loadSkills,
  effectiveTriggers,
  skillMatches,
  matchSkills,
  skillContext,
  type Skill,
} from "../src/skills/index.js";

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-skills-"));
  process.env.JAA_HOME = tmp;
  const skillsDir = join(tmp, "skills");
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

const FM_BASIC = `---
name: code-reviewer
description: "reviews code for correctness and style"
triggers:
  - "review my code"
  - "code review"
---

# Code Reviewer Skill

You are an expert code reviewer. Look for bugs, style issues, and performance.
`;

const FM_MISSING_NAME = `---
description: "unnamed skill"
triggers:
  - "help"
---
Body text here.
`;

describe("parseFrontmatter", () => {
  it("parses name, description, and triggers from valid frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter(FM_BASIC);
    expect(frontmatter.name).toBe("code-reviewer");
    expect(frontmatter.description).toBe("reviews code for correctness and style");
    expect(frontmatter.triggers).toEqual(["review my code", "code review"]);
    expect(body).toContain("You are an expert code reviewer");
  });

  it("returns empty frontmatter when no fenced block is present", () => {
    const { frontmatter, body } = parseFrontmatter("just body text\nno frontmatter");
    expect(frontmatter.name).toBe("");
    expect(frontmatter.description).toBe("");
    expect(frontmatter.triggers).toEqual([]);
    expect(body).toBe("just body text\nno frontmatter");
  });

  it("handles single-quoted values", () => {
    const { frontmatter } = parseFrontmatter("---\nname: 'my skill'\ndescription: 'a description'\ntriggers:\n  - 'do thing'\n---\nbody");
    expect(frontmatter.name).toBe("my skill");
    expect(frontmatter.description).toBe("a description");
    expect(frontmatter.triggers).toEqual(["do thing"]);
  });

  it("handles unquoted trigger items", () => {
    const { frontmatter } = parseFrontmatter("---\nname: test\ntriggers:\n  - unquoted\n  - 'quoted'\n---\nbody");
    expect(frontmatter.triggers).toEqual(["unquoted", "quoted"]);
  });

  it("handles Windows line endings", () => {
    const content = "---\r\nname: win-test\r\ndescription: \"tested\"\r\ntriggers:\r\n  - \"win\"\r\n---\r\nbody";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("win-test");
    expect(frontmatter.triggers).toEqual(["win"]);
    expect(body).toBe("body");
  });

  it("handles unclosed frontmatter gracefully", () => {
    const content = "---\nname: unclosed\ndescription: nope\nbody without close";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("");
    expect(body).toBe(content);
  });

  it("handles empty frontmatter body", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: empty\n---\n");
    expect(frontmatter.name).toBe("empty");
    expect(body).toBe("");
  });
});

describe("parseSkill", () => {
  it("builds a Skill from id, path, and content", () => {
    const skill = parseSkill("my-id", "/path/SKILL.md", FM_BASIC);
    expect(skill.id).toBe("my-id");
    expect(skill.name).toBe("code-reviewer");
    expect(skill.description).toBe("reviews code for correctness and style");
    expect(skill.triggers).toEqual(["review my code", "code review"]);
    expect(skill.body).toContain("You are an expert code reviewer");
  });

  it("falls back to id when name is missing", () => {
    const skill = parseSkill("fallback", "/path/SKILL.md", FM_MISSING_NAME);
    expect(skill.name).toBe("fallback");
    expect(skill.id).toBe("fallback");
  });
});

describe("loadSkill / loadSkills", () => {
  it("loads a single skill by id from the filesystem", () => {
    const dir = join(tmp, "skills", "my-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), FM_BASIC);
    const skill = loadSkill("my-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("code-reviewer");
    expect(skill!.triggers).toEqual(["review my code", "code review"]);
  });

  it("returns undefined for a non-existent skill", () => {
    expect(loadSkill("nope")).toBeUndefined();
  });

  it("skips malformed skill files and returns the valid ones", () => {
    const dir1 = join(tmp, "skills", "good");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "SKILL.md"), FM_BASIC);
    // No SKILL.md in this one
    const dir2 = join(tmp, "skills", "empty");
    mkdirSync(dir2, { recursive: true });

    const skills = loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe("good");
  });

  it("returns an empty array when no skills directory exists", () => {
    rmSync(join(tmp, "skills"), { recursive: true, force: true });
    expect(loadSkills()).toEqual([]);
  });
});

describe("effectiveTriggers", () => {
  it("returns explicit triggers when present", () => {
    const skill: Skill = { id: "x", name: "x", description: "", triggers: ["a", "b"], body: "", path: "" };
    expect(effectiveTriggers(skill)).toEqual(["a", "b"]);
  });

  it("falls back to the skill name when no triggers are present", () => {
    const skill: Skill = { id: "x", name: "my-skill", description: "", triggers: [], body: "", path: "" };
    expect(effectiveTriggers(skill)).toEqual(["my-skill"]);
  });
});

describe("skillMatches", () => {
  const skill: Skill = {
    id: "cr",
    name: "code-reviewer",
    description: "reviews code",
    triggers: ["review my code", "code review"],
    body: "",
    path: "",
  };

  it("matches a trigger phrase (case-insensitive)", () => {
    expect(skillMatches(skill, "Please REVIEW MY CODE for bugs")).toBe(true);
  });

  it("matches by skill name fallback when no triggers", () => {
    const noTriggers: Skill = { id: "x", name: "debug-helper", description: "", triggers: [], body: "", path: "" };
    expect(skillMatches(noTriggers, "I need debug-helper")).toBe(true);
    expect(skillMatches(noTriggers, "debug helper please")).toBe(false);
  });

  it("returns false when no trigger matches", () => {
    expect(skillMatches(skill, "hello world")).toBe(false);
  });
});

describe("matchSkills", () => {
  const skills: Skill[] = [
    { id: "a", name: "a", description: "", triggers: ["refactor"], body: "refactor body", path: "" },
    { id: "b", name: "b", description: "", triggers: ["optimize", "speed"], body: "optimize body", path: "" },
    { id: "c", name: "c", description: "", triggers: ["test"], body: "test body", path: "" },
  ];

  it("returns all skills that match the prompt", () => {
    const matched = matchSkills(skills, "please refactor and optimize for speed");
    expect(matched.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchSkills(skills, "nothing relevant here")).toEqual([]);
  });

  it("returns an empty array for an empty skills list", () => {
    expect(matchSkills([], "anything")).toEqual([]);
  });
});

describe("skillContext", () => {
  const skills: Skill[] = [
    { id: "a", name: "code-reviewer", description: "reviews code", triggers: [], body: "be thorough", path: "" },
    { id: "b", name: "doc-writer", description: "writes docs", triggers: [], body: "be clear", path: "" },
  ];

  it("builds a context string with delimiters for each skill", () => {
    const ctx = skillContext(skills);
    expect(ctx).toContain("---");
    expect(ctx).toContain("# Skill: code-reviewer");
    expect(ctx).toContain("reviews code");
    expect(ctx).toContain("be thorough");
    expect(ctx).toContain("# Skill: doc-writer");
    expect(ctx).toContain("be clear");
  });

  it("returns an empty string for no skills", () => {
    expect(skillContext([])).toBe("");
  });
});

"""
Skills module for J.A.A.

Search GitHub for agentic-skill repositories, install them globally into
`~/.jaa/skills/`, discover their SKILL.md files, and build compact context
snippets so the agent knows which skills exist without burning many tokens.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jaa.config.settings import get_settings
from jaa.utils import run_command_sync

logger = logging.getLogger(__name__)

GITHUB_SEARCH_API = "https://api.github.com/search/repositories"
GITHUB_API_HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "jaa-agent"}

# Substrings that suggest a repo is a skills collection rather than a plain app.
_SKILL_HINTS = ("skill", "agent skill", "claude skill", "codex skill", "skillkit")


@dataclass
class Skill:
    """A single discovered skill (from a SKILL.md file)."""

    name: str
    description: str
    path: Path
    source_repo: str = ""

    @property
    def prompt_block(self) -> str:
        """Compact one-line block for the system prompt."""
        desc = self.description.strip().replace("\n", " ")[:200]
        return f"- {self.name}: {desc}"


@dataclass
class RepoResult:
    """A GitHub repo search result."""

    full_name: str
    url: str
    description: str
    stars: int
    default_branch: str

    @property
    def install_id(self) -> str:
        return self.full_name


class SkillManager:
    """Manages globally-installed agent skills."""

    def __init__(self, skills_dir: Path | None = None):
        settings = get_settings()
        self.skills_dir = (skills_dir or settings.skills_dir).expanduser().resolve()
        self.skills_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ search
    async def search_github(self, query: str, limit: int = 8) -> list[RepoResult]:
        """Search GitHub for skill repositories (stars-first)."""
        results: list[RepoResult] = []
        try:
            import httpx

            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    GITHUB_SEARCH_API,
                    params={
                        "q": f"{query} in:name,description,readme",
                        "sort": "stars",
                        "order": "desc",
                        "per_page": limit,
                    },
                    headers=GITHUB_API_HEADERS,
                )
                if response.status_code == 200:
                    data = response.json()
                    for item in data.get("items", [])[:limit]:
                        desc = item.get("description") or ""
                        if not _looks_like_skills(item.get("name", ""), desc, item.get("topics", [])):
                            continue
                        results.append(
                            RepoResult(
                                full_name=item["full_name"],
                                url=item.get("html_url", ""),
                                description=desc,
                                stars=int(item.get("stargazers_count", 0)),
                                default_branch=item.get("default_branch", "main"),
                            )
                        )
                elif response.status_code in (403, 429):
                    logger.warning("GitHub API rate limited (%s); returning partial results", response.status_code)
                else:
                    logger.warning("GitHub search failed: %s %s", response.status_code, response.text[:200])
        except Exception as e:
            logger.warning(f"GitHub search unavailable: {e}")

        # If the GitHub API was unavailable or returned nothing, fall back to
        # locally-known collections so `jaa skill search` still returns options.
        if not results:
            results = await self._fallback_search(query, limit)
        return results

    async def _fallback_search(self, query: str, limit: int) -> list[RepoResult]:
        """Return a small curated list of known agent-skill collections."""
        known = [
            RepoResult("obra/superpowers", "https://github.com/obra/superpowers",
                       "Collection of skills for Claude Code agents.", 0, "main"),
            RepoResult("anthropics/skills", "https://github.com/anthropics/skills",
                       "Official example agent skills from Anthropic.", 0, "main"),
            RepoResult("the-force/skills", "https://github.com/the-force/skills",
                       "Community agent skill library.", 0, "main"),
        ]
        q = query.lower()
        matched = [r for r in known if q in r.full_name.lower() or q in r.description.lower()]
        return (matched or known)[:limit]

    # ------------------------------------------------------------------ install
    async def install(self, repo: str, branch: str | None = None) -> Path:
        """Install a GitHub repo (owner/name) into the global skills dir.

        Uses a shallow git clone; falls back to downloading a zip tarball if
        git is unavailable.
        """
        repo = repo.strip().rstrip("/")
        if repo.startswith("http"):
            # Normalize https://github.com/owner/repo -> owner/repo
            repo = repo.rstrip("/").split("github.com/")[-1]
        repo = repo.removesuffix(".git")

        if "/" not in repo:
            raise ValueError("Expected a repo in 'owner/name' format")

        dest = self.skills_dir / repo.replace("/", "__")
        if dest.exists():
            return dest  # already installed

        # Try git first (fast, shallow)
        try:
            cmd = ["git", "clone", "--depth", "1"]
            if branch:
                cmd += ["--branch", branch]
            cmd += [f"https://github.com/{repo}.git", str(dest)]
            rc, out, err = await run_command_sync(cmd, timeout=180)
            if rc == 0 and (dest / "SKILL.md").exists() or (dest / ".git").exists():
                logger.info(f"Installed {repo} via git -> {dest}")
                return dest
        except Exception as e:
            logger.debug(f"git clone failed for {repo}: {e}")

        # Fallback: download zip tarball
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        await self._install_from_zip(repo, dest, branch or "main")
        return dest

    async def _install_from_zip(self, repo: str, dest: Path, branch: str) -> None:
        """Download a GitHub repo as a zip and extract it into dest."""
        import httpx

        owner, name = repo.split("/", 1)
        url = f"https://codeload.github.com/{repo}/zip/refs/heads/{branch}"
        tmp = dest.with_suffix(".zip")

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            tmp.write_bytes(response.content)

        with zipfile.ZipFile(tmp) as zf:
            members = zf.namelist()
            # Zip contains a single top folder like name-branch/
            prefix = members[0].split("/", 1)[0] + "/"
            for member in members:
                if member.startswith(prefix):
                    target = dest / member[len(prefix):]
                    if member.endswith("/"):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(zf.read(member))
        tmp.unlink(missing_ok=True)
        logger.info(f"Installed {repo} via zip -> {dest}")

    # ------------------------------------------------------------------ discover
    def list_installed(self) -> list[Skill]:
        """Discover every SKILL.md across installed repos."""
        skills: list[Skill] = []
        for skill_md in sorted(self.skills_dir.rglob("SKILL.md")):
            try:
                front = _parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
                name = front.get("name") or skill_md.parent.name
                description = front.get("description") or "Agent skill."
                source = self._source_repo(skill_md)
                skills.append(Skill(name=name, description=description, path=skill_md, source_repo=source))
            except Exception as e:
                logger.debug(f"Failed to read {skill_md}: {e}")
        return skills

    def _source_repo(self, skill_md: Path) -> str:
        try:
            rel = skill_md.relative_to(self.skills_dir)
            return str(rel.parts[0]).replace("__", "/") if rel.parts else ""
        except Exception:
            return ""

    def remove(self, repo: str) -> bool:
        """Remove an installed repo by 'owner/name' (or its install dir name)."""
        name = repo.strip().replace("/", "__")
        dest = self.skills_dir / name
        if not dest.exists():
            # Maybe they gave the folder name already
            dest = self.skills_dir / repo.strip()
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
            return True
        return False

    # ------------------------------------------------------------------ context
    def build_context(self, query: str | None = None, max_skills: int = 10) -> str:
        """Build a compact, token-cheap summary of installed skills.

        Only skill names + one-line descriptions are included. Optionally rank
        by keyword overlap with the current query so the most relevant skills
        surface first (still just descriptions - full bodies are loaded on demand).
        """
        skills = self.list_installed()
        if not skills:
            return ""

        if query:
            q = query.lower()
            words = set(re.findall(r"[a-z0-9]+", q))
            if words:
                skills.sort(key=lambda s: -self._overlap(s, words))

        lines = ["Available agent skills:", "Installed globally in ~/.jaa/skills. Say the skill's name to use it."]
        for skill in skills[:max_skills]:
            lines.append(skill.prompt_block)
        return "\n".join(lines)

    @staticmethod
    def _overlap(skill: Skill, words: set[str]) -> int:
        text = f"{skill.name} {skill.description}".lower()
        return sum(1 for w in words if w in text)


def _looks_like_skills(name: str, description: str, topics: list[str]) -> bool:
    hay = f"{name} {description}".lower()
    if any(hint in hay for hint in _SKILL_HINTS):
        return True
    return any("skill" in (t or "").lower() for t in topics)


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Parse YAML-ish frontmatter from a SKILL.md. Returns {} if absent."""
    result: dict[str, str] = {}
    match = re.match(r"\A---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return result
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            result[key.strip()] = value.strip().strip("\"'")
    return result


__all__ = ["Skill", "RepoResult", "SkillManager"]

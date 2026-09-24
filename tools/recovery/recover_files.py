"""Recover project files from the manicode run-state message history.

The session log contains the full content of every file read via read_files,
so we can rebuild the deleted project from it.
"""
import json
import os
from pathlib import Path

RUN_STATE = r"C:\Users\Mrityunjay\.config\manicode\projects\jaa\chats\2026-08-15T07-28-47.176Z\run-state.json"
OUT_DIR = Path(r"C:\Users\Mrityunjay\jaa_recovered")

# Decode \u escapes in JSON string values (the log stores \u2192 etc. as literal escapes)
def fix(content: str) -> str:
    return content.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def main() -> None:
    with open(RUN_STATE, encoding="utf-8") as fh:
        data = json.load(fh)

    mas = data["sessionState"]["mainAgentState"]
    mh = mas.get("messageHistory", [])
    saved = 0
    for msg in mh:
        if not isinstance(msg, dict) or msg.get("role") != "tool":
            continue
        blocks = msg.get("content") or []
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "json":
                continue
            value = block.get("value")
            if isinstance(value, dict):
                value = [value]
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, dict):
                    continue
                path = item.get("path")
                content = item.get("content")
                if not path or not isinstance(content, str):
                    continue
                if content in ("[FILE_DOES_NOT_EXIST]", "[FILE_TOO_LARGE]"):
                    continue
                # Skip tool output that is a command result rather than a file read
                if path.startswith("jaa\\") or path.startswith("jaa/") or path in (
                    "README.md", "pyproject.toml", "debug_env_test.py",
                    "debug_env_test2.py", "debug_env_test3.py",
                ):
                    target = OUT_DIR / path.replace("\\", "/")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                    saved += 1
                    print(f"RECOVERED {path} ({len(content)} chars)")
    print(f"\nTotal files recovered: {saved} -> {OUT_DIR}")


if __name__ == "__main__":
    main()

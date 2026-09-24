"""Recover project files from the EARLIER manicode run-state (06-00-27 session)."""
import json
from pathlib import Path

RUN_STATE = r"C:\Users\Mrityunjay\.config\manicode\projects\jaa\chats\2026-08-15T06-00-27.756Z\run-state.json"
OUT_DIR = Path(r"C:\Users\Mrityunjay\jaa_recovered")

SKIP_CONTENT = ("[FILE_DOES_NOT_EXIST]", "[FILE_TOO_LARGE]")


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
                if content in SKIP_CONTENT:
                    continue
                target = OUT_DIR / path.replace("\\", "/")
                if target.exists() and target.stat().st_size >= len(content.encode("utf-8")):
                    continue  # already have same-or-bigger
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                saved += 1
                print(f"RECOVERED {path} ({len(content)} chars)")
    print(f"\nTotal recovered from earlier chat: {saved} -> {OUT_DIR}")


if __name__ == "__main__":
    main()

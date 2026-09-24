"""Print the full file tree from manicode run-state fileContext."""
import json

RUN_STATE = r"C:\Users\Mrityunjay\.config\manicode\projects\jaa\chats\2026-08-15T07-28-47.176Z\run-state.json"


def walk(node: dict, prefix: str = "") -> list[str]:
    out = []
    name = node.get("name", "?")
    full = node.get("filePath") or (prefix + name)
    if node.get("type") == "file":
        out.append(full)
    for child in node.get("children", []) or []:
        out.extend(walk(child, full + "/"))
    return out


def main() -> None:
    with open(RUN_STATE, encoding="utf-8") as fh:
        data = json.load(fh)
    fc = data["sessionState"]["fileContext"]
    print("projectRoot:", fc.get("projectRoot"))
    print("cwd:", fc.get("cwd"))
    print()
    for tree in fc.get("fileTree", []) or []:
        for path in walk(tree):
            print(path)


if __name__ == "__main__":
    main()

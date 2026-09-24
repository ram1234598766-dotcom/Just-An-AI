"""Scan Recycle Bin $I metadata files for entries pointing at the jaa project."""
import os
import struct

RB = r"C:\$Recycle.Bin\S-1-5-21-4178580510-2853843133-3122669967-1001"


def read_path(full: str) -> str:
    try:
        with open(full, "rb") as fh:
            data = fh.read()
        # Win10/11 $I format:
        #   [0:8]   header (0x02...)
        #   [8:16]  original file size (qword)
        #   [16:24] deletion time (qword, FILETIME)
        #   [24:28] path length in BYTES (dword, includes null terminator)
        #   [28:28+n] UTF-16LE path
        if len(data) < 32:
            return ""
        n = struct.unpack_from("<I", data, 24)[0]
        if n <= 0 or n > len(data) - 28:
            return ""
        path_bytes = data[28:28 + n]
        path = path_bytes.decode("utf-16-le", errors="replace")
        return path.rstrip("\x00")
    except Exception:
        return ""


def main() -> None:
    hits = []
    if not os.path.isdir(RB):
        print(f"Recycle bin dir not found: {RB}")
        return
    for name in os.listdir(RB):
        if not name.startswith("$I"):
            continue
        full = os.path.join(RB, name)
        path = read_path(full)
        if "jaa" in path.lower():
            hits.append((name, path))
    for name, path in sorted(hits):
        r_name = "$R" + name[2:]
        r_full = os.path.join(RB, r_name)
        size = os.path.getsize(r_full) if os.path.exists(r_full) else -1
        print(f"{name} -> {path}  ($R exists: {os.path.exists(r_full)}, size={size})")


if __name__ == "__main__":
    main()

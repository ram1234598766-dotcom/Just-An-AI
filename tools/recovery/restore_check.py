"""Inspect Recycle Bin $R entries for the jaa project before restoring."""
import os
import struct
from datetime import datetime, timedelta

RB = r"C:\$Recycle.Bin\S-1-5-21-4178580510-2853843133-3122669967-1001"

ENTRIES = [
    ("$I3XPKHV", "$R3XPKHV", r"C:\Users\Mrityunjay\jaa\integrations"),
    ("$I5JBS7J.md", "$R5JBS7J", r"C:\Users\Mrityunjay\jaa\README.md"),
    ("$I9BPCNC", "$R9BPCNC", r"C:\Users\Mrityunjay\jaa\cli"),
    ("$IEIC40A", "$REIC40A", r"C:\Users\Mrityunjay\jaa\orchestrator"),
    ("$IF92BFE", "$RF92BFE", r"C:\Users\Mrityunjay\jaa\memory"),
    ("$IOLDKAH", "$ROLDKAH", r"C:\Users\Mrityunjay\jaa\voice"),
    ("$IP6KDXI", "$R6KDXI", r"C:\Users\Mrityunjay\jaa\agents"),
    ("$IQKZ17G", "$RQKZ17G", r"C:\Users\Mrityunjay\jaa\utils"),
    ("$IXU7LW4", "$RXU7LW4", r"C:\Users\Mrityunjay\jaa\config"),
    ("$IYC33PS.toml", "$RYC33PS.toml", r"C:\Users\Mrityunjay\jaa\pyproject.toml"),
]


def filetime_to_dt(ft: int) -> str:
    if ft == 0:
        return "?"
    try:
        return str(datetime(1601, 1, 1) + timedelta(microseconds=ft / 10))
    except Exception:
        return "?"


def walk_tree(path: str, depth: int = 0, max_depth: int = 3) -> None:
    try:
        with os.scandir(path) as it:
            entries = sorted(it, key=lambda e: e.name)
        for e in entries:
            print("  " * depth + f"{'[DIR] ' if e.is_dir() else '[FILE]'} {e.name} ({e.stat().st_size}B)")
            if e.is_dir() and depth < max_depth:
                walk_tree(e.path, depth + 1, max_depth)
    except Exception as ex:
        print("  " * depth + f"<error: {ex}>")


for i_name, r_name, orig in ENTRIES:
    i_full = os.path.join(RB, i_name)
    r_full = os.path.join(RB, r_name)
    print(f"=== {r_name} -> {orig} ===")
    if os.path.exists(i_full):
        with open(i_full, "rb") as fh:
            data = fh.read()
        ft = struct.unpack_from("<Q", data, 16)[0]
        print(f"  deleted at: {filetime_to_dt(ft)}")
    if os.path.exists(r_full):
        if os.path.isdir(r_full):
            print(f"  (directory) contents:")
            walk_tree(r_full)
        else:
            print(f"  (file, {os.path.getsize(r_full)}B)")
    else:
        print("  MISSING")
    print()

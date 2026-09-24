"""Dump raw bytes of a Recycle Bin $I file to understand the format."""
import os

RB = r"C:\$Recycle.Bin\S-1-5-21-4178580510-2853843133-3122669967-1001"

for name in ["$IYC33PS.toml", "$IGYJKHE", "$IJOWNRH", "$IVYC0RW"]:
    full = os.path.join(RB, name)
    if not os.path.exists(full):
        print(f"{name}: NOT FOUND")
        continue
    with open(full, "rb") as fh:
        data = fh.read()
    print(f"=== {name} (len={len(data)}) ===")
    # print first 64 bytes as hex + ascii
    for i in range(0, min(len(data), 64), 16):
        chunk = data[i:i + 16]
        hexs = " ".join(f"{b:02x}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"  {i:04x}: {hexs:<48} {asc}")
    # Try decoding everything as utf-16-le from various offsets
    for off in (20, 24, 28, 32):
        try:
            txt = data[off:].decode("utf-16-le")
            end = txt.find("\x00")
            cand = txt[:end] if end > 0 else txt[:80]
            if cand and "\\" in cand:
                print(f"  offset {off}: {cand!r}")
        except Exception:
            pass

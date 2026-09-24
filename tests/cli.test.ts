import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor } from "../src/doctor.js";
import { getPkgInfo } from "../src/version.js";

describe("version", () => {
  it("reads the package identity from package.json", () => {
    const pkgJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    const pkg = getPkgInfo();
    expect(pkg.name).toBe(pkgJson.name);
    expect(pkg.version).toBe(pkgJson.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("doctor", () => {
  it("returns a well-formed report with all checks", () => {
    const report = runDoctor();
    const keys = report.checks.map((c) => c.key);
    expect(keys).toContain("node-version");
    expect(keys).toContain("platform");
    expect(keys).toContain("data-dir");
    expect(keys).toContain("git");
    expect(keys).toContain("tmp-writable");
    for (const check of report.checks) {
      expect(["ok", "warn", "fail", "info"]).toContain(check.status);
      expect(check.message.length).toBeGreaterThan(0);
    }
  });

  it("passes the node version check on the current runtime", () => {
    const node = runDoctor().checks.find((c) => c.key === "node-version");
    expect(node?.status).toBe("ok");
  });

  it("renders a readable formatted report", () => {
    const text = formatReport(runDoctor());
    expect(text).toContain("node-version");
    expect(text).toMatch(/\[ok\]|\[warn\]|\[fail\]|\[info\]/);
  });
});
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
  /**
   * `runDoctor` reports GitHub auth, which means asking GitHub who the token
   * belongs to. That is fine for a user and wrong for a test: on a machine
   * where `GITHUB_TOKEN` is exported, a bare `runDoctor()` would make a live
   * request to api.github.com, so the suite would depend on the network and on
   * whatever credential the developer happens to have lying around.
   *
   * This stub throws, so a future check that reaches for the network fails
   * loudly here instead of silently talking to GitHub. Injecting it changes no
   * assertion below.
   */
  const noNetwork = (): typeof fetch =>
    (() => {
      throw new Error("tests must not make network requests; inject a fetchImpl");
    }) as unknown as typeof fetch;

  it("returns a well-formed report with all checks", async () => {
    const report = await runDoctor({ fetchImpl: noNetwork() });
    const keys = report.checks.map((c: { key: string }) => c.key);
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

  it("passes the node version check on the current runtime", async () => {
    const report2 = await runDoctor({ fetchImpl: noNetwork() });
    const node = report2.checks.find((c: { key: string }) => c.key === "node-version");
    expect(node?.status).toBe("ok");
  });

  it("renders a readable formatted report", async () => {
    const text = formatReport(await runDoctor({ fetchImpl: noNetwork() }));
    expect(text).toContain("node-version");
    expect(text).toMatch(/\[ok\]|\[warn\]|\[fail\]|\[info\]/);
  });
});
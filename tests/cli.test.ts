import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor } from "../src/doctor.js";
import { getPkgInfo } from "../src/version.js";

const repoFile = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));

describe("version", () => {
  it("reads the package identity from package.json", () => {
    const pkgJson = JSON.parse(readFileSync(repoFile("package.json"), "utf8")) as { name: string; version: string };
    const pkg = getPkgInfo();
    expect(pkg.name).toBe(pkgJson.name);
    expect(pkg.version).toBe(pkgJson.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("published tarball", () => {
  /**
   * Every repo-relative link in the README has to resolve inside the package.
   *
   * npm renders the README from the tarball, so a link to a file that `files`
   * does not include is a dead link on the package page — and the page is where
   * someone decides whether to install this. Nothing else catches it: the link
   * is correct in the repository, and the test suite never looks at the tarball.
   */
  it("ships every document the README links to", () => {
    const pkgJson = JSON.parse(readFileSync(repoFile("package.json"), "utf8")) as { files: string[] };
    const readme = readFileSync(repoFile("README.md"), "utf8");
    const links = [...readme.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)].map((match) => match[1] ?? "");

    expect(links.length, "no relative links found — the matcher is wrong, not the README").toBeGreaterThan(0);
    const missing = links.filter((link) => !pkgJson.files.some((entry) => link === entry || link.startsWith(`${entry}/`)));
    expect(missing, `not in package.json "files": ${missing.join(", ")}`).toEqual([]);
  });

  it("actually contains what it claims", () => {
    // The list is not a promise on its own; the files have to exist.
    const pkgJson = JSON.parse(readFileSync(repoFile("package.json"), "utf8")) as { files: string[] };
    for (const entry of pkgJson.files) {
      expect(existsSync(repoFile(entry)), `declared in "files" but absent: ${entry}`).toBe(true);
    }
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
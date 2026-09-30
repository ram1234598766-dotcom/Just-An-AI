import { defineConfig } from "vitest/config";

/**
 * The real-language-server suite, on its own.
 *
 * These two files start five actual language servers - typescript-language-server,
 * pyright, clangd, gopls, and a JDT LS JVM - and then index real projects while
 * asking them for real diagnostics. That is the point of them: a fake server
 * proves the plumbing and nothing about whether jaa is correct against a real
 * one. It is also, unavoidably, five processes doing the most expensive thing in
 * the suite.
 *
 * Left in the default pool they competed with thirty-eight other files, and the
 * symptom was the worst kind of test failure: a different probe failing on each
 * run, the TypeScript one and then the Go one, every one of them passing alone
 * with identical code. A real defect does not move. Neither does a flaky test
 * that fails six times in six runs and passes every time you run it again to see
 * what changed - it just teaches people to re-run and stop reading, which is the
 * same as deleting the assertion while looking busier.
 *
 * `fileParallelism: false` is the load-bearing line. It is not enough to give
 * these files their own pool; they must not run concurrently *with each other*
 * either, because the whole-repository TypeScript probe indexes all of jaa while
 * `lsp-servers` is asking gopls for a verdict on a temp directory, and neither
 * gets the machine to itself if they overlap.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/lsp-servers.test.ts", "tests/lsp-loop.test.ts"],
    /**
     * Raised for the same reason, and for the same non-reason, as the pty suite.
     *
     * A language server indexing a project is not a hung test. Each probe already
     * carries its own explicit budget - 120s for the client, 90s for the
     * diagnostic push, 240s for the test - so a server that genuinely wedges
     * still fails on one of those. This only stops the outer harness from
     * declaring the file dead while a JVM is still loading.
     */
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

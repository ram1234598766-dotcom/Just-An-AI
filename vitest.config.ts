import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Excluded: these need a pty and a WSL start, and asking for twenty seconds
    // of uncontended terminal time inside a pool running forty other files gave a
    // different victim every run. They run on their own - `npm run test:tui`.
    //
    // Excluded for a second, different reason: these two start five real language
    // servers between them and index real projects while thirty-eight other files
    // run. Observed on a loaded host as a different probe failing on each full
    // run - the TypeScript one, then the Go one - each passing alone, with
    // identical code and identical servers. Contention, not a defect, but a suite
    // that names a different victim each time is a suite people stop reading.
    // They run on their own - `npm run test:lsp`.
    exclude: [
      "tests/tui-pty.test.ts",
      "tests/lsp-servers.test.ts",
      "tests/lsp-loop.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
    reporters: ["default"],
    passWithNoTests: false,
    /**
     * Raised from vitest's 5000ms default.
     *
     * This suite is mostly subprocess tests — real `git`, real `gh`, real
     * `npm pack` — and several of them legitimately take 4.5-5s on their own
     * (`hooks.test.ts > never resolves a failing blocking handler to allow` was
     * measured at 4.8s in a passing run). Against a 5s budget that is 200ms of
     * headroom, so a loaded machine tips them over and the failure looks like a
     * regression in whatever file happened to lose the race. Observed on this
     * host as up to six files timing out in a single run, with a different
     * victim each time and no common cause.
     *
     * This does not make a hang invisible: the code under test carries its own
     * explicit timeouts (`runProcess` 30s, `gh auth token` 2s, network fetches
     * 15s), so a genuinely stuck process still fails on one of those long before
     * 20s. Tests that need more than this should say so with an explicit
     * per-test timeout rather than by raising this again.
     */
    testTimeout: 20_000,
  },
});

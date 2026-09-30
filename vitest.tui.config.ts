import { defineConfig } from "vitest/config";

/**
 * The pty suite, on its own.
 *
 * A real terminal, twenty seconds a recording, and no competition for CPU. It is
 * a different class of test from the unit suite and it is run differently rather
 * than being made to fit.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/tui-pty.test.ts"],
    // Generous, because a pty driver that boots WSL and loads node off a
    // Windows 9p mount is slow for reasons that have nothing to do with the code.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
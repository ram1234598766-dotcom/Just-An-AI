import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = (relativePath: string): string => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
const dist = join(repo("dist"));

/** Every emitted `.js` under `dist`, as repo-relative paths. */
function emittedJs(dir: string = dist, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) emittedJs(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * The test that should have existed before 0.1.2 shipped broken.
 *
 * `tsc` resolves a `./components.jsx` specifier to `components.tsx` while
 * type-checking, and then **emits the specifier exactly as written**. Nothing
 * was ever wrong at compile time and nothing was ever wrong in the test suite,
 * because vitest applies the same substitution when it loads the source. The
 * bug existed only in `dist/`, and only when Node loaded the built file the way
 * it loads an installed package — which is to say, for every user of 0.1.2.
 *
 * So this reads the *emitted* JavaScript, which is the only place the fault is
 * visible, and requires every relative specifier to name a file that exists.
 *
 * Skipped when `dist/` is absent, which is the normal state in CI: the suite
 * runs `tsc --noEmit` and never builds. The `verify:dist` script below is what
 * makes this run in CI without making the unit suite build.
 */
describe("emitted JavaScript", () => {
  const built = existsSync(dist);

  it.skipIf(!built)("imports only files that exist", () => {
    const specifier = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+"(\.[^"]+)"/g;
    const dynamic = /\bimport\(\s*"(\.[^"]+)"\s*\)/g;
    const broken: string[] = [];

    for (const file of emittedJs()) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [specifier, dynamic]) {
        for (const match of text.matchAll(pattern)) {
          const target = match[1];
          if (target === undefined) continue;
          // A type-only import is erased, so it cannot reach the emitted file;
          // anything left here is a runtime specifier and must resolve.
          const resolved = join(file, "..", target);
          if (!existsSync(resolved)) broken.push(`${relative(dist, file)} -> ${target}`);
        }
      }
    }

    expect(
      broken,
      `emitted specifiers that resolve to nothing:\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  it.skipIf(!built)("carries no .jsx, .ts or .tsx specifier", () => {
    // The same fault in the shape that actually shipped. A `.js` specifier is the
    // only one Node can resolve from `dist/`, whatever the source was called.
    const offenders: string[] = [];
    for (const file of emittedJs()) {
      const text = readFileSync(file, "utf8");
      if (/from\s+"\.[^"]+\.(jsx|ts|tsx)"/.test(text)) {
        offenders.push(relative(dist, file));
      }
    }
    expect(offenders, `use a .js specifier even for a .tsx source:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

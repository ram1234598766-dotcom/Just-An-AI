import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findExecutable } from "../utils/spawn.js";

/**
 * A command line that can actually be spawned, which is not always the same as
 * the command a user thinks of as "the server".
 */
export interface ResolvedLaunch {
  command: string;
  args: string[];
  /**
   * A directory this function created and the caller should remove once the
   * server has exited. JDT LS writes an index into it, and it can be tens of
   * megabytes, so it is not left behind on purpose.
   */
  cleanupPath?: string;
}

/** The directory name JDT LS ships for this platform. */
function sharedConfigDir(): string {
  switch (process.platform) {
    case "win32":
      return "config_win";
    case "darwin":
      return process.arch === "arm64" ? "config_mac_arm" : "config_mac";
    default:
      return process.arch === "arm64" ? "config_linux_arm" : "config_linux";
  }
}

/**
 * Find the Eclipse JDT LS distribution directory.
 *
 * `JDTLS_HOME` wins, then wherever `jdtls` is on `PATH`. The `PATH` route is
 * what makes this work on an ordinary install: the launcher people put on
 * `PATH` is a *batch file* that runs a Python script, and it ends in `pause`, so
 * it is not a thing a process can be spawned as. Reading the distribution's
 * layout off that path and running Eclipse ourselves is the only way to get a
 * real, spawnable command line.
 */
function findDistribution(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.JDTLS_HOME;
  if (fromEnv !== undefined && fromEnv !== "" && isDistribution(resolve(fromEnv))) {
    return resolve(fromEnv);
  }
  const launcher = findExecutable("jdtls", env);
  if (launcher === undefined) return undefined;
  // <root>/bin/jdtls.bat -> <root>
  const root = dirname(dirname(launcher));
  return isDistribution(root) ? root : undefined;
}

function isDistribution(root: string): boolean {
  return existsSync(join(root, "plugins")) && findLauncherJar(root) !== undefined;
}

/**
 * The Equinox launcher jar. The name carries a build qualifier
 * (`org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar`), so it is matched
 * rather than named.
 */
function findLauncherJar(root: string): string | undefined {
  const plugins = join(root, "plugins");
  if (!existsSync(plugins)) return undefined;
  const exact = join(plugins, "org.eclipse.equinox.launcher.jar");
  if (existsSync(exact)) return exact;
  const versioned = readdirSync(plugins)
    .filter((name) => name.startsWith("org.eclipse.equinox.launcher_") && name.endsWith(".jar"))
    .sort()
    .pop();
  return versioned === undefined ? undefined : join(plugins, versioned);
}

/**
 * Build a spawnable command line for Eclipse JDT LS.
 *
 * Returns `undefined` when there is no JDT LS, or when there is one but no
 * `java` to run it with, which is a real distinction: a JDT LS with no JRE
 * cannot analyse Java, and saying "available" would be the same lie as a
 * `rust-analyzer` with no `rustc`.
 */
export function resolveJdtls(env: NodeJS.ProcessEnv = process.env): ResolvedLaunch | undefined {
  const root = findDistribution(env);
  if (root === undefined) return undefined;

  const java = findExecutable("java", env);
  if (java === undefined) return undefined;

  const jar = findLauncherJar(root);
  if (jar === undefined) return undefined;
  const config = join(root, sharedConfigDir());
  if (!existsSync(config)) return undefined;

  // JDT LS needs a writable workspace of its own. It is per-process, so two
  // concurrent jaa runs do not fight over one index.
  const data = mkdtempSync(join(tmpdir(), "jaa-jdtls-"));

  return {
    command: java,
    args: [
      // JDT LS parses XML that trips the JDK's entity limits on Java 24+. They
      // are plain system properties, so they are harmless on 17-23, and setting
      // them unconditionally saves probing the JVM version on every resolve.
      "-Djdk.xml.maxGeneralEntitySizeLimit=0",
      "-Djdk.xml.totalEntitySizeLimit=0",
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Dosgi.checkConfiguration=true",
      "-Dosgi.sharedConfiguration.area=" + config,
      "-Dosgi.sharedConfiguration.area.readOnly=true",
      "-Dosgi.configuration.cascaded=true",
      "-Xms1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      jar,
      "-data",
      data,
    ],
    cleanupPath: data,
  };
}

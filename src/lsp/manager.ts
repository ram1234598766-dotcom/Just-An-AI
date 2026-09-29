/**
 * One long-lived language server per (project, language), started on demand.
 *
 * ## Why sessions are managed rather than created per question
 *
 * A language server spends most of its life doing work that has nothing to do
 * with the question being asked: parsing `tsconfig.json`, reading every file in
 * the project, building a program. Starting a process per question pays all of
 * that again every time, which is what made `lsp diagnose` feel broken rather
 * than slow. One session per language keeps the index warm and is what makes
 * diagnostics after an edit arrive in milliseconds.
 *
 * ## What a failure here costs: nothing
 *
 * The plan's risk note is the design constraint: "a wedged server is killed and
 * reported rather than allowed to block the loop." So every path in this file
 * resolves rather than throws. A language server that is missing, refuses to
 * start, times out, or dies is *reported* and then ignored — the agent gets a
 * tool result that says diagnostics are unavailable for this language, and the
 * turn continues. Code intelligence is an enhancement; a coding agent that stops
 * working because a type checker is unhappy is worse than one that has no type
 * checker.
 *
 * ## Restart once, then stop
 *
 * A crashed server is restarted **once**. A server that crashes on a second
 * start is not having a bad moment, it is misconfigured, and retrying it on every
 * turn would cost a process launch per turn forever. So the session is marked
 * disabled and later calls answer immediately from that fact.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "./client.js";
import { BUILTIN_SERVERS, detectServers, serverForExtension, type DetectedServer, type LspServerConfig } from "./registry.js";
import type { LspTextDocumentDiagnosticResult } from "./types.js";

/** How long to wait for a server to start and handshake before giving up. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** How long a diagnostics request may take. Servers indexing a large project are slow. */
export const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 20_000;

/**
 * How long to wait for a push-mode server to publish.
 *
 * Separate from the request timeout because it is a different wait: the request
 * is answered immediately, and this is how long the caller is willing to watch
 * for a notification that may never come.
 *
 * Ten seconds, measured rather than guessed. `typescript-language-server` is
 * push-only — it answers a `textDocument/diagnostic` request with "Unhandled
 * method" — so this wait *is* the feature. The first call on a cold project pays
 * the indexing cost of the whole workspace, and on this repository that measured
 * at somewhere between 5 and 10 seconds: 5 s returned zero diagnostics for a
 * file with two obvious type errors, 10 s returned both. Later calls are warm and
 * return immediately.
 *
 * A clean file usually publishes an empty set quickly, so the common case is not
 * this slow — it is the cold first call that is.
 */
export const DEFAULT_PUSH_WAIT_MS = 10_000;

export interface LspManagerOptions {
  root: string;
  /** Per-request deadline for the client. */
  timeoutMs?: number;
  /** How long to wait for a push-mode server to publish. */
  diagnosticWaitMs?: number;
  /** Injectable for tests; defaults to the real client. */
  createClient?: (config: LspServerConfig, options: { cwd: string; timeoutMs: number; tsserver?: string }) => LspClient;
  servers?: readonly LspServerConfig[];
}

export type DiagnosticsOutcome =
  | { status: "ok"; result: LspTextDocumentDiagnosticResult; language: string }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string; language: string };

/** What a navigation caller gets: the client, the file's URI, and the language. */
export interface NavigationSession {
  client: LspClient;
  uri: string;
  language: string;
}

interface Session {
  config: LspServerConfig;
  client: LspClient;
  /**
   * Set when the server could never start, or when the restart budget is spent.
   * While it is set, every call answers from this string without spawning.
   */
  disabledReason?: string;
}

export class LspManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * Restarts already spent per language.
   *
   * Counted here rather than on the session, because a restart *replaces* the
   * session — a counter stored on it would reset to zero every time and the
   * budget would never run out. The budget is one: a server that dies again
   * after a clean restart is misconfigured rather than unlucky, and retrying it
   * per turn would cost a process launch on every turn of every session, for a
   * feature that is an enhancement and not a requirement.
   */
  private readonly restarts = new Map<string, number>();
  private readonly detectedById: Map<string, DetectedServer>;
  private readonly options: LspManagerOptions;
  private closing = false;

  constructor(options: LspManagerOptions) {
    this.options = options;
    this.detectedById = new Map(
      detectServers(options.root, options.servers ?? BUILTIN_SERVERS).map((entry) => [entry.config.id, entry]),
    );
  }

  /** What this project could use, and whether it is usable. Never starts anything. */
  get detected(): DetectedServer[] {
    return [...this.detectedById.values()];
  }

  /** The language jaa would use for `filePath`, or undefined. */
  languageFor(filePath: string): string | undefined {
    return serverForExtension(extname(filePath), this.options.servers ?? BUILTIN_SERVERS)?.id;
  }

  /** Is any server usable for this file? Used to keep the tools out of the prompt. */
  hasServerFor(filePath: string): boolean {
    const language = this.languageFor(filePath);
    if (language === undefined) return false;
    return this.detectedById.get(language)?.available === true;
  }

  /**
   * Diagnostics for one file.
   *
   * Opens the document first when the text is supplied, because a server that
   * has never seen the file answers about what is on disk — and the point of
   * asking is usually to learn about something just written.
   */
  async diagnostics(
    filePath: string,
    text?: string,
    opts: { languageId?: string; timeoutMs?: number } = {},
  ): Promise<DiagnosticsOutcome> {
    const language = this.languageFor(filePath);
    if (language === undefined) {
      return { status: "unavailable", reason: `jaa has no language server configured for ${extname(filePath) || "this file type"}` };
    }
    const session = await this.sessionFor(language);
    if (session === "error") {
      return { status: "unavailable", reason: `the ${language} language server is not usable: ${this.detectedById.get(language)?.reason ?? "not installed"}` };
    }
    if (session.disabledReason !== undefined) {
      return { status: "unavailable", reason: `the ${language} language server is disabled: ${session.disabledReason}` };
    }

    const uri = pathToFileURL(filePath).href;
    try {
      if (text !== undefined) {
        session.client.openDocument(uri, opts.languageId ?? language, text);
      }
      const result = await session.client.diagnosticsFor(
        uri,
        opts.timeoutMs ?? this.options.diagnosticWaitMs ?? DEFAULT_PUSH_WAIT_MS,
      );
      if (result === null) {
        // The server neither advertises pull nor published anything. That is
        // "no diagnostics available", which is not the same as "no errors" and
        // is reported as an empty set only because the caller asked.
        return { status: "ok", result: { kind: "full", items: [] }, language };
      }
      return { status: "ok", result, language };
    } catch (err) {
      // A server that fails mid-request is treated as crashed, and the session is
      // reset so the next call gets a clean one.
      this.reset(language, `request failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        status: "error",
        language,
        reason: `the ${language} language server failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Tell the server a file changed, so a later diagnostics call is current.
   *
   * Best-effort and silent: this runs on the hot path of every mutating tool
   * call, and a server that is not listening must not turn a successful write
   * into a failed one.
   */
  notifyChanged(filePath: string, text: string): void {
    const language = this.languageFor(filePath);
    if (language === undefined) return;
    const session = this.sessions.get(language);
    if (session === undefined || session.disabledReason !== undefined) return;
    try {
      session.client.changeDocument(pathToFileURL(filePath).href, text);
    } catch {
      // A closed pipe is not this call's problem.
    }
  }

  /**
   * The session for a file's language, for a caller that needs the client.
   *
   * Exposed for the `lsp_*` navigation tools, which have to check a capability
   * before making a request and need the same session the diagnostics path uses —
   * starting a second server per question would undo the whole point of the
   * session. Returns the string `"error"` when there is no usable server, which
   * the caller reports rather than throws on.
   */
  async navigationSession(filePath: string): Promise<NavigationSession | "error"> {
    const language = this.languageFor(filePath);
    if (language === undefined) return "error";
    const session = await this.sessionFor(language);
    if (session === "error" || session.disabledReason !== undefined) return "error";
    return { client: session.client, uri: pathToFileURL(filePath).href, language };
  }

  /** Shut every server down. Called at the end of a session. */
  async close(): Promise<void> {
    this.closing = true;
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      live.map((session) => session.client.disconnect().catch(() => {
        // A server that will not shut down cleanly must not fail the turn.
      })),
    );
  }

  // --- internals -----------------------------------------------------------

  /**
   * The session for a language, starting it if needed.
   *
   * Returns the string `"error"` when the language has no usable server, which
   * is a second failure from "the server is installed" and is reported as such
   * by the caller. A sentinel rather than an exception, because this is called
   * from the agent's hot path and nothing here may throw.
   */
  private async sessionFor(language: string): Promise<Session | "error"> {
    const existing = this.sessions.get(language);
    if (existing !== undefined) return existing;

    const detected = this.detectedById.get(language);
    if (detected === undefined || !detected.available) return "error";
    if (this.closing) return "error";

    const create =
      this.options.createClient ??
      ((config, options) => {
        const client = new LspClient(config.command, config.args ?? [], {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
        });
        if (options.tsserver !== undefined) {
          // Must be set before `connect`, since it goes into `initialize`.
          client.setInitializationOptions({ tsserver: { path: options.tsserver } });
        }
        return client;
      });

    const client = create(detected.config, {
      cwd: this.options.root,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
      ...(detected.tsserver !== undefined ? { tsserver: detected.tsserver } : {}),
    });

    const session: Session = { config: detected.config, client };
    try {
      await client.connect();
    } catch (err) {
      // A server that cannot start at all never gets a restart: there is nothing
      // to retry, only a misconfiguration to report.
      session.disabledReason = err instanceof Error ? err.message : String(err);
    }
    this.sessions.set(language, session);
    return session;
  }

  /**
   * Replace a session after a failure, spending one restart.
   *
   * The replacement is a **new client**, not the old one: the old one has just
   * been disconnected, and reusing it meant every call after a failure returned
   * "not connected" — the feature stayed dead for the rest of the session even
   * though the restart budget was never spent.
   *
   * The second failure disables the language. Either way the old process is torn
   * down, so a wedged server never accumulates.
   */
  private reset(language: string, reason: string): void {
    const existing = this.sessions.get(language);
    if (existing === undefined) return;
    void existing.client.disconnect().catch(() => undefined);

    const spent = (this.restarts.get(language) ?? 0) + 1;
    this.restarts.set(language, spent);
    if (spent > 1) {
      // Budget spent. Park a disabled session so callers read the reason without
      // this path ever running again for the language.
      this.sessions.set(language, { config: existing.config, client: existing.client, disabledReason: `disabled after ${spent - 1} failed restart: ${reason}` });
      return;
    }
    // Dropped from the map so the next call takes the `sessionFor` path and
    // builds a clean client.
    this.sessions.delete(language);
  }
}

/** Read a file, tolerating absence. Used to supply text for `didOpen`. */
export function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { encodeFrame, decodeFrames } from "./framing.js";
import { getPkgInfo } from "../version.js";
import { spawnPipe } from "../utils/spawn.js";
import type {
  LspDiagnostic,
  LspInitializeParams,
  LspServerCapabilities,
  LspSymbol,
  LspTextDocumentDiagnosticResult,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** The JSON-RPC error code for a method the client does not implement. */
const METHOD_NOT_FOUND = -32601;

/**
 * How long to wait for a push-mode server to publish diagnostics.
 *
 * Bounded, because the common case for a file with no problems is a server that
 * publishes an empty set quickly, and the case for a wedged server has to be
 * distinguishable from a slow one. The caller reports the difference.
 */
const PUSH_DIAGNOSTIC_WAIT_MS = 5_000;

/** How often the push wait re-checks, when nothing is registered as a waiter. */
const POLL_INTERVAL_MS = 50;

/**
 * Canonical form of a document URI, for use as a map key.
 *
 * ## Why this is not optional on Windows
 *
 * The same file has several legal spellings, and a server does not use the one
 * the client sent. Observed on this host, for one file:
 *
 *   client sends   `file:///C:/Users/x/src/a.ts`
 *   server echoes  `file:///c%3A/Users/x/src/a.ts`
 *
 * — the drive letter lowercased, and its colon percent-encoded, because the
 * server round-tripped the URI through a URL parser. Keying the diagnostics map
 * on the raw string means every publish lands under a key no lookup will ever
 * ask for. The symptom is a server that handshakes correctly, publishes real
 * diagnostics, and reports none of them — which is exactly what happened, and
 * which is indistinguishable from a server that is simply broken.
 *
 * POSIX is left alone: its paths are case-sensitive, so folding case there would
 * merge two genuinely different files.
 */
export function normalizeUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  // `file:///c%3A/...` -> `file:///c:/...`
  const decoded = uri.replace(/^(file:\/\/\/)([a-zA-Z])%3A/, (_all, scheme: string, drive: string) => `${scheme}${drive}:`);
  return process.platform === "win32" ? decoded.toLowerCase() : decoded;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LspClientOptions {
  /** Per-request deadline. Default 10 s. */
  timeoutMs?: number;
  /** Working directory for the server process. */
  cwd?: string;
  /** Injected for tests. */
  spawnImpl?: Parameters<typeof spawnPipe>[2] extends { spawnImpl?: infer T } ? T : never;
}

/**
 * A long-lived LSP client: one process per server, kept open for a session.
 *
 * Phase 8's version was a one-shot `lsp diagnose`. Phase 17 needs a client that
 * survives, because the alternative is a process per question and a language
 * server spends most of its life indexing a project — paying that per question
 * is what made the feature feel broken rather than slow.
 *
 * ## What changed from Phase 8, and why
 *
 * - **Spawning goes through `spawnPipe`.** `spawn("typescript-language-server")`
 *   is `ENOENT` on Windows and a batch file cannot be spawned at all, so the
 *   original client could not start a server on this platform. `spawnPipe`
 *   unwraps the npm shim and runs it with `process.execPath`, with no shell.
 * - **Document sync (`didOpen`/`didChange`/`didSave`).** With no open document
 *   a server has no buffer state, and the navigation features answer about the
 *   file on disk rather than what the agent just wrote.
 * - **Server-to-client requests are answered.** A server that sends
 *   `client/registerCapability` and gets silence may wait forever. jaa answers
 *   with `MethodNotFound`, which every server treats as "not supported", instead
 *   of leaving a request outstanding.
 * - **The timeout is configurable and the method name is in the error**, so a
 *   wedged server is identifiable rather than just slow.
 */
export class LspClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<string | number, PendingRequest>();
  private leftover: Uint8Array = new Uint8Array(0);
  private capabilities: LspServerCapabilities = {};
  private closed = false;
  private connectPromise: Promise<void> | undefined;
  private detachProcess: (() => void) | undefined;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private initializationOptions: Record<string, unknown> = {};
  /** Version numbers for `didChange`, per the protocol's monotonic rule. */
  private versions = new Map<string, number>();
  /** Documents the server has been told about. */
  private readonly opened = new Set<string>();
  /** The last pushed diagnostics per document URI. */
  private readonly published = new Map<string, { items: LspDiagnostic[]; version: number }>();
  /** Resolvers waiting for a publish for a given URI. */
  private readonly pushWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  readonly command: string;
  readonly args: string[];

  constructor(command: string, args: string[] = [], options: LspClientOptions = {}) {
    this.command = command;
    this.args = args;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.cwd = options.cwd ?? process.cwd();
    if (options.spawnImpl !== undefined) this.spawnImpl = options.spawnImpl;
  }

  private spawnImpl: Parameters<typeof spawnPipe>[2]["spawnImpl"];

  /** The process id of the server, or undefined when not running. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Has the server exited or been told to stop? */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Extra `initializationOptions` for the `initialize` request.
   *
   * Set before {@link connect}. Some servers are front-ends for another program
   * and need to be told what to drive — `typescript-language-server` takes
   * `tsserver.path` here, and without it the handshake fails outright on a
   * project whose TypeScript ships no `tsserver`.
   */
  setInitializationOptions(options: Record<string, unknown>): void {
    this.initializationOptions = options;
  }

  /** Spawn the LSP server and complete the initialize handshake. */
  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal();
    return this.connectPromise;
  }

  /** Request diagnostics for a file URI. */
  async getDiagnostics(uri: string): Promise<LspTextDocumentDiagnosticResult | null> {
    const result = await this.send<LspTextDocumentDiagnosticResult | null>(
      "textDocument/diagnostic",
      { textDocument: { uri } },
    );
    return result;
  }

  /**
   * Wait for the server to publish diagnostics for `uri`.
   *
   * ## Why this exists, and why it is not the same as `getDiagnostics`
   *
   * There are two diagnostic models in the protocol. **Pull** is
   * `textDocument/diagnostic`: the client asks. **Push** is
   * `textDocument/publishDiagnostics`: the server sends, unprompted, whenever it
   * has new results.
   *
   * `typescript-language-server` — the server for the language this repository
   * is written in — implements **only push**, and answers a pull request with
   * "Unhandled method textDocument/diagnostic". An earlier version of this client
   * only spoke pull, so against the one server it most needed it produced an
   * error and nothing else.
   *
   * So both are supported: pull when the server advertises
   * `diagnosticProvider`, push otherwise. The push path is a bounded wait rather
   * than a fixed sleep, because a server that never publishes is a server that
   * has no diagnostics, and the caller should be told that quickly instead of
   * after a timeout.
   */
  async waitForDiagnostics(
    rawUri: string,
    options: { timeoutMs?: number; sinceVersion?: number } = {},
  ): Promise<LspTextDocumentDiagnosticResult | null> {
    const uri = normalizeUri(rawUri);
    const fresh = (): LspTextDocumentDiagnosticResult | null => {
      const found = this.published.get(uri);
      if (found === undefined) return null;
      if (options.sinceVersion !== undefined && found.version < options.sinceVersion) return null;
      return { kind: "full", items: found.items };
    };

    const immediate = fresh();
    if (immediate !== null) return immediate;

    const deadline = Date.now() + (options.timeoutMs ?? PUSH_DIAGNOSTIC_WAIT_MS);
    // Registered before the first check, so a publish landing between the check
    // and the registration is not missed.
    let resolveWaiter!: () => void;
    const promise = new Promise<void>((r) => {
      resolveWaiter = r;
    });
    this.pushWaiters.set(uri, { promise, resolve: resolveWaiter });

    try {
      while (Date.now() < deadline && !this.closed) {
        await Promise.race([promise, delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))]);
        const now = fresh();
        if (now !== null) return now;
      }
    } finally {
      // Only clear our own registration: a concurrent wait for the same URI would
      // otherwise have its resolver dropped on the floor.
      const current = this.pushWaiters.get(uri);
      if (current?.resolve === resolveWaiter) this.pushWaiters.delete(uri);
    }
    return fresh();
  }

  /** The last diagnostics the server pushed for `uri`, if any. */
  publishedDiagnostics(rawUri: string): LspTextDocumentDiagnosticResult | undefined {
    const found = this.published.get(normalizeUri(rawUri));
    return found === undefined ? undefined : { kind: "full", items: found.items };
  }

  /**
   * Ask for diagnostics the way this server actually answers.
   *
   * Prefers pull when the server supports it, and falls back to the pushed set
   * otherwise. Returns `null` only when the server supports neither, which the
   * caller reports as "no diagnostics available" rather than as "no errors".
   */
  async diagnosticsFor(uri: string, timeoutMs?: number): Promise<LspTextDocumentDiagnosticResult | null> {
    if (this.supports("diagnostic")) {
      try {
        const pulled = await this.getDiagnostics(uri);
        if (pulled !== null) return pulled;
      } catch (err) {
        // A server that advertises pull and then refuses it is a push server
        // with a stale capability. Fall through rather than failing the turn.
        if (!/unhandled method|method not found/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
      }
    }
    return this.waitForDiagnostics(uri, timeoutMs === undefined ? {} : { timeoutMs });
  }

  // --- document sync -------------------------------------------------------

  /**
   * Tell the server a document is open, with its content.
   *
   * Without this a server has no buffer and answers navigation questions about
   * the file on disk — which, right after the agent wrote it, is the old version.
   */
  openDocument(rawUri: string, languageId: string, text: string, version = 1): void {
    const uri = normalizeUri(rawUri);
    this.bumpVersion(uri, version);
    this.opened.add(uri);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: this.versions.get(uri) ?? version, text },
    });
  }

  /**
   * Replace a document's content.
   *
   * Sent as a **full** sync rather than an incremental range change. An agent
   * rewrites whole files, so there is no small edit to describe, and a full sync
   * cannot be wrong about a range it computed against a document the server may
   * not have caught up with yet.
   */
  changeDocument(rawUri: string, text: string): void {
    const uri = normalizeUri(rawUri);
    if (!this.opened.has(uri)) return;
    this.bumpVersion(uri);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: this.versions.get(uri) ?? 1 },
      contentChanges: [{ text }],
    });
  }

  saveDocument(rawUri: string, text?: string): void {
    const uri = normalizeUri(rawUri);
    if (text !== undefined) this.changeDocument(uri, text);
    if (!this.opened.has(uri)) return;
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  private bumpVersion(uri: string, absolute?: number): void {
    // The protocol requires a strictly increasing version, and a re-`open` after
    // a reconnect starts the document again — so a counter that only ever counted
    // up from connect time would go backwards for a document opened before it.
    const next = absolute ?? (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
  }

  // --- navigation ----------------------------------------------------------

  /** Where the symbol at `position` is defined. */
  async definition(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.send("textDocument/definition", { textDocument: { uri }, position });
  }

  /** Every reference to the symbol at `position`. */
  async references(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.send("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
  }

  /** Hover text for the symbol at `position`. */
  async hover(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.send("textDocument/hover", { textDocument: { uri }, position });
  }

  /** Symbols declared in a document. */
  async documentSymbols(uri: string): Promise<LspSymbol[]> {
    return normalizeSymbols(await this.send<unknown>("textDocument/documentSymbol", { textDocument: { uri } }));
  }

  /** Symbols across the whole workspace, matched by `query`. */
  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    return normalizeSymbols(await this.send<unknown>("workspace/symbol", { query }));
  }

  /**
   * Whether the server advertised a feature.
   *
   * Checked before every navigation request, because a server that does not
   * implement a method answers with a JSON-RPC error, and turning that into a
   * "not supported" answer is both friendlier and more accurate than surfacing
   * the error to the model.
   */
  supports(
    feature: "definition" | "references" | "hover" | "documentSymbol" | "workspaceSymbol" | "diagnostic",
  ): boolean {
    const cap = this.capabilities as Record<string, unknown>;
    const has = (key: string): boolean => cap[key] !== undefined && cap[key] !== false;
    switch (feature) {
      case "definition":
        return has("definitionProvider");
      case "references":
        return has("referencesProvider");
      case "hover":
        return has("hoverProvider");
      case "documentSymbol":
        return has("documentSymbolProvider");
      case "workspaceSymbol":
        return has("workspaceSymbolProvider");
      case "diagnostic":
        return has("diagnosticProvider");
    }
  }

  /** Server capabilities advertised during initialize. */
  get serverCapabilities(): LspServerCapabilities {
    return this.capabilities;
  }

  /** Terminate the LSP server process. */
  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.closed = true;
    this.rejectAll(new Error("client disconnected"));
    this.pushWaiters.clear();
    this.published.clear();
    this.opened.clear();
    this.versions.clear();
    if (!proc) {
      this.detachProcess?.();
      this.detachProcess = undefined;
      this.proc = undefined;
      return;
    }

    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.stdin?.end();
      } catch {
        // The process may have closed stdin already.
      }
      try {
        proc.kill();
      } catch {
        // The process may have exited between the checks.
      }
      await waitForExit(proc, 1_000);
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have exited between the checks.
        }
        await waitForExit(proc, 1_000);
      }
    }
    this.detachProcess?.();
    this.detachProcess = undefined;
    this.proc = undefined;
  }

  private async connectInternal(): Promise<void> {
    // Phase 17: through `spawnPipe`, so a Windows npm shim is unwrapped and run
    // under `process.execPath` instead of failing as an unspawnable `.cmd`.
    const { child } = spawnPipe(this.command, this.args, {
      cwd: this.cwd,
      ...(this.spawnImpl !== undefined ? { spawnImpl: this.spawnImpl } : {}),
    });
    const proc = child;
    this.proc = proc;
    this.closed = false;
    this.leftover = new Uint8Array(0);
    this.opened.clear();
    this.versions.clear();

    const stdout = proc.stdout;
    if (!stdout) {
      this.proc = undefined;
      throw new Error("LSP server has no stdout stream");
    }
    const onData = (chunk: Buffer) => this.handleData(chunk);
    const onError = (error: Error) => this.handleProcessFailure(error);
    const onExit = (code: number | null) => {
      this.closed = true;
      this.handleProcessFailure(new Error(`LSP server "${this.command}" exited with code ${code ?? "unknown"}`));
    };
    stdout.on("data", onData);
    stdout.on("error", onError);
    proc.stdin?.on("error", onError);
    proc.stderr?.resume();
    proc.on("error", onError);
    proc.on("exit", onExit);
    this.detachProcess = () => {
      stdout.removeListener("data", onData);
      stdout.removeListener("error", onError);
      proc.stdin?.removeListener("error", onError);
      proc.stderr?.removeListener("error", onError);
      proc.removeListener("error", onError);
      proc.removeListener("exit", onExit);
    };

    try {
      const initParams: LspInitializeParams = {
        processId: process.pid,
        clientInfo: { name: "jaa", version: getPkgInfo().version },
        // The project root, both ways a server may read it. Without this the
        // server loads no `tsconfig.json`, no file belongs to a project, and
        // every diagnostics request comes back empty.
        rootUri: pathToFileURL(this.cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
        capabilities: {
          // Phase 17: ask for the features this client actually implements.
          // Advertising a capability jaa does not use is how a server ends up
          // sending requests nothing answers.
          textDocument: {
            /**
             * Required, and not a standard LSP capability.
             *
             * `typescript-language-server` computes its whole
             * `features.diagnosticsSupport` flag from
             * `Boolean(capabilities.textDocument.publishDiagnostics)` and
             * `FileDiagnostics.publishDiagnostics()` returns early when that
             * flag is false — so a client that omits this key gets a server that
             * connects, handshakes, and then never sends a single diagnostic,
             * silently. That is precisely what happened the first time: the
             * handshake succeeded and every publish was suppressed. The flag
             * looks like a bug in the client and is really a required key in
             * the server's own convention.
             */
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true,
              tagSupport: { valueSet: [1, 2] },
            },
            definition: {},
            references: {},
            hover: { contentFormat: ["plaintext", "markdown"] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: false },
          },
          workspace: {
            symbol: {},
          },
        },
        // Spread last so a caller's options win over the defaults above, and so
        // an empty object never appears in the request — some servers treat a
        // present-but-empty `initializationOptions` differently from an absent
        // one.
        ...(Object.keys(this.initializationOptions).length > 0 ? { initializationOptions: this.initializationOptions } : {}),
      };
      const result = await this.send<LspServerCapabilities & { capabilities: LspServerCapabilities }>(
        "initialize",
        initParams,
      );
      this.capabilities = result.capabilities ?? {};
      this.notify("initialized", {});
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleProcessFailure(failure);
      await this.disconnect();
      throw failure;
    }
  }

  private handleProcessFailure(error: Error): void {
    this.rejectAll(error);
  }

  private handleData(chunk: Uint8Array): void {
    this.leftover = Buffer.concat([Buffer.from(this.leftover), Buffer.from(chunk)]);
    const { messages, leftover } = decodeFrames(this.leftover);
    this.leftover = leftover;
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: { json: () => unknown }): void {
    let parsed: unknown;
    try {
      parsed = msg.json();
    } catch {
      return;
    }

    const obj = parsed as {
      jsonrpc: string;
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (obj.jsonrpc !== "2.0") return;

    // A server-to-client *request* has both an id and a method. Ignoring one is
    // not neutral: the server is waiting for a response, and several will block
    // their own initialisation on it. Answering `MethodNotFound` is the protocol's
    // way of saying "not implemented", and every server treats it as that.
    if (obj.id !== undefined && obj.method !== undefined) {
      this.respondError(obj.id, METHOD_NOT_FOUND, `jaa does not implement "${obj.method}"`);
      return;
    }

    // A notification has a method and no id. There is nothing to answer, and a
    // handful of them are worth acting on; the rest are ignored.
    if (obj.id === undefined && obj.method !== undefined) {
      // `params`, not `result`: a notification carries its payload under
      // `params`. `result` is only ever present on a *response*, and reading it
      // here meant `publishDiagnostics` arrived with `undefined` and every
      // diagnostic was discarded before it reached the store.
      this.handleNotification(obj.method, (obj as { params?: unknown }).params);
      return;
    }

    if (obj.id !== undefined && obj.result !== undefined) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(obj.id);
        pending.resolve(obj.result);
      }
    } else if (obj.id !== undefined && obj.error) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(obj.id);
        const err = obj.error as { message?: string };
        pending.reject(new Error(err.message ?? `LSP request "${pending.method}" failed`));
      }
    }
  }

  /**
   * Handle the few server notifications worth acting on.
   *
   * `textDocument/publishDiagnostics` is the one that matters: for a push-mode
   * server it is the *only* source of diagnostics. Its `version` is carried
   * through, because the protocol allows a server to publish a stale result and
   * a client that accepts it reports errors against text the file no longer has.
   *
   * Everything else — `window/logMessage`, `$/progress`, the rest — is dropped
   * on purpose. A language server logs freely, and forwarding it into the
   * agent's context would spend tokens on chatter.
   */
  private handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const record = params as { uri?: unknown; diagnostics?: unknown; version?: unknown } | null;
      // Normalized, because the server's spelling of the URI is not the client's
      // — see `normalizeUri`. Keying on the raw string loses every publish.
      const uri = typeof record?.uri === "string" ? normalizeUri(record.uri) : undefined;
      if (uri === undefined || !Array.isArray(record?.diagnostics)) return;
      const items: LspDiagnostic[] = [];
      for (const entry of record.diagnostics) {
        // Validated rather than cast: this is a third-party server's JSON, and a
        // malformed diagnostic must not become a crash inside the notification
        // handler, where nothing is watching.
        if (typeof entry !== "object" || entry === null) continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.message !== "string" || typeof item.range !== "object" || item.range === null) continue;
        items.push(entry as LspDiagnostic);
      }
      const version = typeof record.version === "number" ? record.version : 0;
      this.published.set(uri, { items, version });
      this.notifyWaiters(uri);
      return;
    }
    if (method === "window/logMessage" || method === "window/showMessage" || method.startsWith("$/")) {
      return;
    }
  }

  private notifyWaiters(uri: string): void {
    const waiter = this.pushWaiters.get(uri);
    this.pushWaiters.delete(uri);
    waiter?.resolve();
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) {
      return Promise.reject(new Error("LSP client is not connected"));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const frame = encodeFrame({ jsonrpc: "2.0", id, method, params: params ?? {} });
      const buf = Buffer.from(frame, "utf8");

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.proc?.stdin?.write(buf);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Send a notification.
   *
   * Public from Phase 17 because document sync is driven by the manager, not
   * only by the request methods. Best-effort by design: a notification has no
   * reply, so a write to a closed pipe is not something the caller can act on
   * and must not throw.
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) return;
    const frame = encodeFrame({ jsonrpc: "2.0", method, params: params ?? {} });
    try {
      this.proc.stdin.write(Buffer.from(frame, "utf8"));
    } catch {
      // The pipe closed between the check and the write.
    }
  }

  /** Answer a server-to-client request with a JSON-RPC error. */
  private respondError(id: string | number, code: number, message: string): void {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) return;
    const frame = encodeFrame({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      this.proc.stdin.write(Buffer.from(frame, "utf8"));
    } catch {
      // The pipe closed between the check and the write.
    }
  }

  private rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Flatten a symbol response into one shape.
 *
 * The protocol has two incompatible symbol types: `SymbolInformation` carries a
 * `location`, and `DocumentSymbol` carries a `range` plus a tree of children. A
 * server picks based on the `hierarchicalDocumentSymbolSupport` capability jaa
 * declares — which is `false` here — so the flat form is what comes back in
 * practice, but a server may ignore the declaration. Handling both means a
 * symbol list never comes back silently empty.
 *
 * A malformed entry is skipped rather than throwing: the response is a
 * third-party server's JSON, and one odd symbol is not a reason to fail a query.
 */
function normalizeSymbols(raw: unknown): LspSymbol[] {
  if (!Array.isArray(raw)) return [];
  const out: LspSymbol[] = [];

  const visit = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || name === "") return;

    const symbol: LspSymbol = { name };
    if (typeof record.kind === "number") symbol.kind = record.kind;
    if (typeof record.detail === "string") symbol.detail = record.detail;
    if (typeof record.containerName === "string") symbol.containerName = record.containerName;

    // `SymbolInformation` shape.
    const location = record.location as { range?: { start?: { line?: number } } } | undefined;
    const fromLocation = location?.range?.start?.line;
    // `DocumentSymbol` shape.
    const range = record.range as { start?: { line?: number } } | undefined;
    const fromRange = range?.start?.line;
    const line = typeof fromLocation === "number" ? fromLocation : fromRange;
    if (typeof line === "number") symbol.line = line + 1; // protocol is 0-based; print 1-based

    out.push(symbol);

    const children = record.children;
    if (Array.isArray(children)) for (const child of children) visit(child);
  };

  for (const entry of raw) visit(entry);
  return out;
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.once("exit", finish);
  });
}

/**
 * Minimal LSP (Language Server Protocol) types for diagnostics.
 * Supports just enough for pull-based textDocument/diagnostic requests.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP diagnostic severity values (numeric, per the LSP spec). */
export const LSP_DIAGNOSTIC_SEVERITY = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: LspRelatedInformation[];
}

export interface LspRelatedInformation {
  location: LspLocation;
  message: string;
}

export interface LspTextDocumentDiagnosticResult {
  kind: "full" | "unchanged";
  items: LspDiagnostic[];
}

export interface LspInitializeParams {
  processId: number | null;
  clientInfo: { name: string; version?: string };
  capabilities: Record<string, unknown>;
  /**
   * The project root as a `file://` URI.
   *
   * Not optional in practice. A server with no root does not load a
   * `tsconfig.json`, so it has no project for a file to belong to, and produces
   * no diagnostics for it — a handshake that succeeds and a server that stays
   * silent. `workspaceFolders` is sent alongside it because servers differ in
   * which of the two they read.
   */
  rootUri?: string;
  workspaceFolders?: Array<{ uri: string; name: string }>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspServerCapabilities {
  diagnosticProvider?: {
    documentSelector?: unknown[];
    workDoneToken?: boolean;
  };
  textDocumentSync?: number | Record<string, unknown>;
  /** Phase 17: the navigation and hover features, when a server has them. */
  definitionProvider?: boolean | Record<string, unknown>;
  referencesProvider?: boolean | Record<string, unknown>;
  hoverProvider?: boolean | Record<string, unknown>;
  documentSymbolProvider?: boolean | Record<string, unknown>;
  workspaceSymbolProvider?: boolean | Record<string, unknown>;
}

/** Phase 17: an LSP `SymbolInformation`/`DocumentSymbol`, kept loose. */
export interface LspSymbol {
  name: string;
  kind?: number;
  detail?: string;
  /** 1-based, as the protocol states. Kept 1-based so it is printable as-is. */
  line?: number;
  containerName?: string;
}

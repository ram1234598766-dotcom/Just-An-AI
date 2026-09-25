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
}

export interface LspServerCapabilities {
  diagnosticProvider?: {
    documentSelector?: unknown[];
    workDoneToken?: boolean;
  };
  textDocumentSync?: number | Record<string, unknown>;
}

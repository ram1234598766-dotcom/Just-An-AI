import { PROVIDERS } from "../config/providers.js";
import { loadSettings, setSetting } from "../config/settings.js";
import { hasKey, setKey } from "../config/keyring.js";
import { listLocalModels, type LocalModel } from "./local-models.js";

export type SetupStep = "loading" | "choose-local" | "choose-provider" | "enter-key" | "done" | "skipped";

/** How long to wait for Ollama before deciding it is not there. */
const PROBE_TIMEOUT_MS = 1_500;

export interface SetupState {
  step: SetupStep;
  /** Models found on a local Ollama, newest-looking first. */
  local: LocalModel[];
  /** Index into `local` or the provider list. */
  cursor: number;
  /** Providers that need a key, i.e. everything that is not local-only. */
  providers: typeof PROVIDERS;
  /** The provider whose key is being entered. */
  pending: (typeof PROVIDERS)[number] | undefined;
  /** The key as typed. Never rendered, never logged. */
  key: string;
  /** What happened, for the person reading the screen. */
  message: string;
  /** Set when a key was rejected, so the bar can say why. */
  error: string | undefined;
}

export function initialSetupState(): SetupState {
  return {
    step: "loading",
    local: [],
    cursor: 0,
    providers: PROVIDERS.filter((p) => p.localOnly !== true),
    pending: undefined,
    key: "",
    message: "",
    error: undefined,
  };
}

/**
 * Does jaa already have a usable provider configured?
 *
 * The setup exists for the first run, so it has to be able to tell "first run"
 * from "second run" without a marker file. A provider that already has a key, or
 * a local provider with models on it, means someone has been here before.
 */
export function shouldRunSetup(explicitChoice = false): boolean {
  if (explicitChoice) return false;
  return !alreadyConfigured();
}

export function alreadyConfigured(): boolean {
  const settings = loadSettings();
  if (settings.defaultProvider !== undefined) {
    const def = PROVIDERS.find((p) => p.id === settings.defaultProvider);
    if (def?.localOnly === true) return true;
    if (def !== undefined && hasKey(def)) return true;
    if (def === undefined) return true;
  }
  return PROVIDERS.some((p) => p.localOnly !== true && hasKey(p));
}

/** What the setup screen should open on, given what is already configured. */
export async function detectSetup(): Promise<SetupState> {
  const state = initialSetupState();
  const local = await listLocalModels(PROBE_TIMEOUT_MS).catch(() => []);
  state.local = local;
  if (alreadyConfigured()) {
    state.step = "skipped";
    state.message = "a provider is already configured";
    return state;
  }
  // Local models first. If someone has Ollama running with something pulled,
  // that is the answer that needs no key, no account and no money, so it is the
  // one offered before any hosted provider is mentioned.
  state.step = local.length > 0 ? "choose-local" : "choose-provider";
  return state;
}

/** The label for the row under the cursor, used by the status line. */
export function currentRowLabel(state: SetupState): string | undefined {
  if (state.step === "choose-local") {
    const model = state.local[state.cursor];
    return model === undefined ? undefined : model.name;
  }
  if (state.step === "choose-provider") return state.providers[state.cursor]?.label;
  return undefined;
}

/** The URL to show under the cursor, for a provider row. */
export function currentKeyUrl(state: SetupState): string | undefined {
  if (state.step !== "choose-provider") return undefined;
  return state.providers[state.cursor]?.keyUrl;
}

/**
 * Move the cursor, and clear a key that was being typed for the previous
 * provider.
 *
 * A pasted key belongs to the provider it was pasted for. Keeping it in the bar
 * after moving to another provider is how a Groq key ends up stored as an
 * OpenAI one, which fails later and looks like a bad key.
 */
export function moveCursor(state: SetupState, delta: number): SetupState {
  const size = state.step === "choose-local" ? state.local.length : state.providers.length;
  if (size === 0) return state;
  const cursor = Math.min(size - 1, Math.max(0, state.cursor + delta));
  if (cursor === state.cursor) return state;
  return { ...state, cursor, key: state.step === "enter-key" ? "" : state.key, error: undefined };
}

/** Enter on a provider row moves to the key bar. */
export function choose(state: SetupState): SetupState {
  if (state.step === "choose-local") {
    const model = state.local[state.cursor];
    if (model === undefined) return state;
    applyChoice("ollama", model.name);
    return { ...state, step: "done", message: `using local model ${model.name}`, key: "", error: undefined };
  }
  if (state.step === "choose-provider") {
    const provider = state.providers[state.cursor];
    if (provider === undefined) return state;
    return {
      ...state,
      step: "enter-key",
      pending: provider,
      key: "",
      error: undefined,
      message: "",
    };
  }
  return state;
}

/**
 * Store the typed key and make that provider the default.
 *
 * The value is written through the existing keyring, which is the same path
 * `jaa key set` uses, so permissions and storage are one implementation rather
 * than two. Nothing here prints or logs the value.
 */
export function confirmKey(state: SetupState): SetupState {
  const provider = state.pending;
  if (provider === undefined) return state;
  const value = state.key.trim();
  if (value === "") {
    return { ...state, error: "paste a key, or press Esc to pick a different provider" };
  }
  setKey(provider, value);
  applyChoice(provider.id, undefined);
  return { ...state, step: "done", key: "", error: undefined, message: `using ${provider.label}` };
}

/** Esc: leave the key bar for the provider list. Never leaves a key behind. */
export function backToProviders(state: SetupState): SetupState {
  if (state.step !== "enter-key") return state;
  return { ...state, step: "choose-provider", pending: undefined, key: "", error: undefined, message: "" };
}

/** Abandon setup without changing anything. */
export function skip(state: SetupState): SetupState {
  return { ...state, step: "skipped", key: "", message: "setup skipped — nothing was changed" };
}

/**
 * A key is only stored once the screen says it is.
 *
 * Written through the existing `setSetting`, which is the same path `jaa config
 * set` uses, so validation and persistence are one implementation rather than
 * two — and an invalid value is refused by the same schema that reads it back.
 */
function applyChoice(providerId: string, model: string | undefined): void {
  setSetting("defaultProvider", providerId);
  if (model === undefined) return;
  // Models are configured per role, not as one default, so a local model picked
  // at setup has to be bound to the roles rather than left as a loose name that
  // nothing would read. `coder` and `fast` both: a local model is the one most
  // likely to be serving an edit and a quick lookup at the same time.
  for (const role of ["coder", "fast"] as const) {
    setSetting(`models.${role}`, model);
  }
}

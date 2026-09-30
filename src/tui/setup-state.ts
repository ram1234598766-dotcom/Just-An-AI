import { PROVIDERS } from "../config/providers.js";
import { loadSettings, setSetting } from "../config/settings.js";
import { hasKey, setKey } from "../config/keyring.js";
import { listLocalModels, type LocalModel } from "./local-models.js";

export type SetupStep = "loading" | "choose-local" | "choose-provider" | "enter-key" | "done" | "skipped";

/** How long to wait for Ollama before deciding it is not there. */
const PROBE_TIMEOUT_MS = 1_500;

/** The local provider, which needs no key and so is handled separately. */
const LOCAL_PROVIDER = PROVIDERS.find((p) => p.localOnly === true);

export interface SetupState {
  step: SetupStep;
  /** Models found on a local Ollama, newest-looking first. */
  local: LocalModel[];
  /** Index into `local` or the provider list. */
  cursor: number;
  /**
   * Every provider, Ollama included.
   *
   * Ollama used to be filtered out of this list and reachable only through the
   * `choose-local` step, which needs `/api/tags` to have answered. So Ollama was
   * invisible to anyone running it with nothing pulled, and to anyone whose probe
   * timed out at 1.5s on a slow boot - the two people most likely to be setting
   * jaa up for the first time. A local option you can only reach by already
   * having succeeded at the thing it is for is not an option.
   */
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
    providers: PROVIDERS,
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
  // A local provider has no key, so it has no key URL. Showing one anyway is how
  // a row for something that needs no account ends up pointing at a signup page.
  const provider = state.providers[state.cursor];
  if (provider === undefined || provider.localOnly === true) return undefined;
  return provider.keyUrl;
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

/**
 * Enter on a provider row.
 *
 * A local provider has no key to ask for, so choosing it goes straight to the
 * model list rather than to a key bar. Asking for a key that will never be used
 * is how you get an empty box that refuses every input.
 */
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
    if (provider.localOnly === true) {
      // Straight into the model list, seeded with anything already pulled.
      return { ...state, step: "choose-local", cursor: 0, key: "", error: undefined, message: "" };
    }
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

/**
 * Esc: leave the current step for the provider list, carrying no key with it.
 *
 * Applies to the key bar *and* to the model list. The model list is reachable
 * from the provider row now, so Esc has to be able to come back from it too -
 * otherwise "Ollama, but I have nothing pulled" is a dead end with no way out
 * but Ctrl+C, which discards the whole session.
 */
export function backToProviders(state: SetupState): SetupState {
  if (state.step === "enter-key") {
    return { ...state, step: "choose-provider", pending: undefined, key: "", error: undefined, message: "" };
  }
  if (state.step === "choose-local") {
    // Come back to the local row, which is where this step was entered from.
    const at = LOCAL_PROVIDER === undefined ? 0 : Math.max(0, PROVIDERS.indexOf(LOCAL_PROVIDER));
    return { ...state, step: "choose-provider", cursor: at, key: "", error: undefined, message: "" };
  }
  return state;
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

import { findSecret, type SecretSource } from "../config/env.js";
import { providerById, PROVIDERS, type ProviderDef } from "../config/providers.js";
import { hasKey, readKeyring } from "../config/keyring.js";
import { loadSettings } from "../config/settings.js";
import { createOpenAICompatible } from "./openaiCompatible.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOllamaAdapter } from "./ollama.js";
import type { ChatRequest, ChatResponse, ProviderAdapter, ResolvedModel } from "./types.js";

export interface ProviderKey {
  value: string;
  source: SecretSource | "keyring";
}

/**
 * Where the API key comes from: standard env vars first (process/project/home
 * layers), then the `~/.jaa/.env` keyring. Never logs or returns the value.
 */
export function resolveProviderKey(def: ProviderDef): ProviderKey | undefined {
  if (def.localOnly) return undefined;
  const fromEnv = findSecret(def.envKeys);
  if (fromEnv) return { value: fromEnv.value, source: fromEnv.source };
  if (hasKey(def)) {
    const value = readKeyring().get(def.keyringEnv);
    if (value) return { value, source: "keyring" };
  }
  return undefined;
}

/**
 * Builds a provider adapter from current config. Throws a helpful error when
 * the selected provider has no key (never echoes the key itself).
 */
export function resolveAdapter(providerId: string): ProviderAdapter {
  const def = providerById(providerId);
  if (!def) {
    throw new Error(
      `unknown provider "${providerId}" (try one of: ${PROVIDERS.map((p) => p.id).join(", ")})`,
    );
  }

  if (def.localOnly) {
    const settings = loadSettings();
    return createOllamaAdapter({ id: def.id, host: settings.ollamaBaseUrl });
  }

  const key = resolveProviderKey(def);
  if (!key) {
    throw new Error(
      `no API key found for "${providerId}" — run \`jaa setup\` or \`jaa key set ${providerId} <key>\``,
    );
  }

  switch (def.id) {
    case "openai":
      return createOpenAICompatible({ id: def.id, apiKey: key.value, baseURL: "https://api.openai.com/v1" });
    case "anthropic":
      return createAnthropicAdapter({ id: def.id, apiKey: key.value, baseURL: "https://api.anthropic.com" });
    case "google":
      return createGeminiAdapter({ id: def.id, apiKey: key.value });
    default: {
      // OpenAI-compatible family (Groq, DeepSeek, Mistral, Together, xAI, Azure...)
      const endpoints: Record<string, string> = {
        groq: "https://api.groq.com/openai/v1",
        deepseek: "https://api.deepseek.com",
        mistral: "https://api.mistral.ai/v1",
        together: "https://api.together.xyz/v1",
        xai: "https://api.x.ai/v1",
        azure: "https://your-resource.openai.azure.com/openai",
      };
      const baseURL = endpoints[def.id];
      if (!baseURL) throw new Error(`provider "${def.id}" has no endpoint mapping yet`);
      return createOpenAICompatible({ id: def.id, apiKey: key.value, baseURL });
    }
  }
}

/**
 * One entry point for the agent loop (Phase 3): pick the provider, resolve the
 * model and adapter, and run a single chat round-trip.
 */
export async function chat(providerId: string, model: string, req: ChatRequest): Promise<ChatResponse> {
  const adapter = resolveAdapter(providerId);
  return adapter.chat({ ...req, model });
}

/** Provider + model the agent loop should default to. Overridable by CLI flags. */
export function resolveModel(opts?: { provider?: string; model?: string }): ResolvedModel {
  const settings = loadSettings();
  const providerId = opts?.provider ?? settings.defaultProvider ?? "ollama";
  const def = providerById(providerId);
  if (!def) throw new Error(`unknown provider "${providerId}" (see \`jaa key list\`)`);

  const model = opts?.model ?? defaultModelFor(providerId);
  const adapter = resolveAdapter(providerId);
  const key = resolveProviderKey(def);

  const resolved: ResolvedModel = { provider: providerId, model, adapter };
  if (key) resolved.keySource = key.source;
  return resolved;
}

/**
 * Model defaults per provider — local-first picks are small + fast.
 *
 * Every entry here has been wrong at some point, which is the argument for
 * `replacementModel` below rather than against it. `gemini-1.5-flash` and
 * `claude-3-5-sonnet-20241022` were both correct when written; Google and
 * Anthropic have since retired them, and a turn that was otherwise fine died
 * with a 404 nobody could act on.
 *
 * So the defaults point at models each vendor's own SDK currently documents, and
 * when one of them is retired the loop swaps rather than stopping. Nothing here
 * is a claim that these will keep working - it is a claim that being wrong is now
 * cheap.
 */
export function defaultModelFor(providerId: string): string {
  const settings = loadSettings();
  const roleModel = settings.models.coder ?? settings.models.fast;
  if (roleModel && providerId === settings.defaultProvider) return roleModel;
  return currentDefaultModel(providerId) ?? "llama3.2";
}

/**
 * The model jaa uses for a provider when nothing has been configured.
 *
 * Split out from `defaultModelFor` so the retired-model fallback can ask "what
 * would you use?" without re-reading config, and without being fooled by a role
 * model that is itself the thing that just died.
 */
export function currentDefaultModel(providerId: string): string | undefined {
  const defaults: Record<string, string> = {
    openai: "gpt-4o-mini",
    // Anthropic's current Messages API model list no longer includes the 3.5
    // Sonnet id this used to name; the Sonnet tier is still what a mid-cost
    // default should be.
    anthropic: "claude-sonnet-4-6",
    // Google's own codegen guidance lists 1.5 as prohibited. The 2.5 series is
    // the stable one; the 3.x models are all preview.
    google: "gemini-2.5-flash",
    groq: "llama-3.1-8b-instant",
    deepseek: "deepseek-chat",
    mistral: "mistral-small-latest",
    together: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    xai: "grok-2-latest",
    azure: "gpt-4o-mini",
    ollama: "llama3.2",
  };
  return defaults[providerId];
}

/**
 * The model to use after one has been reported as gone, or undefined if there is
 * nothing better to try.
 *
 * Undefined when the dead model already *is* the current default: retrying it
 * would send the same request and fail identically, and a second 404 costs a
 * round trip and teaches nobody anything. In that case the error is the honest
 * answer, and the message says which setting to change.
 */
export function replacementModel(providerId: string, dead: string): string | undefined {
  const current = currentDefaultModel(providerId);
  if (current === undefined || current === dead) return undefined;
  return current;
}

export { PROVIDERS };
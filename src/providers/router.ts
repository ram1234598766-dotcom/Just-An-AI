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

/** Model defaults per provider — local-first picks are small + fast. */
export function defaultModelFor(providerId: string): string {
  const settings = loadSettings();
  const roleModel = settings.models.coder ?? settings.models.fast;
  if (roleModel && providerId === settings.defaultProvider) return roleModel;
  const defaults: Record<string, string> = {
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-sonnet-20241022",
    google: "gemini-1.5-flash",
    groq: "llama-3.1-8b-instant",
    deepseek: "deepseek-chat",
    mistral: "mistral-small-latest",
    together: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    xai: "grok-2-latest",
    azure: "gpt-4o-mini",
    ollama: "llama3.2",
  };
  return defaults[providerId] ?? "llama3.2";
}

export { PROVIDERS };
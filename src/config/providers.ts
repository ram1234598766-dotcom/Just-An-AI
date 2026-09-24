/**
 * Provider registry — pure metadata shared by keyring, setup, doctor and the
 * Phase 2 adapters. Nothing here reads secrets; adapters resolve keys via the
 * keyring/env layers at call time.
 */

export interface ProviderDef {
  /** Stable id, used for `jaa key set <id>` and config keys. */
  id: string;
  label: string;
  /** Standard env var names that count as a key source. */
  envKeys: string[];
  /** The keyring stores the secret under JAA_<ID>_API_KEY. */
  keyringEnv: string;
  /** Whether this provider is local-only (never needs a key). */
  localOnly?: boolean;
  note?: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI (GPT models)",
    envKeys: ["OPENAI_API_KEY"],
    keyringEnv: "JAA_OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude models)",
    envKeys: ["ANTHROPIC_API_KEY"],
    keyringEnv: "JAA_ANTHROPIC_API_KEY",
  },
  {
    id: "google",
    label: "Google Gemini",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    keyringEnv: "JAA_GOOGLE_API_KEY",
  },
  {
    id: "groq",
    label: "Groq (fast hosted Llama/Qwen)",
    envKeys: ["GROQ_API_KEY"],
    keyringEnv: "JAA_GROQ_API_KEY",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envKeys: ["DEEPSEEK_API_KEY"],
    keyringEnv: "JAA_DEEPSEEK_API_KEY",
  },
  {
    id: "mistral",
    label: "Mistral",
    envKeys: ["MISTRAL_API_KEY"],
    keyringEnv: "JAA_MISTRAL_API_KEY",
  },
  {
    id: "together",
    label: "Together AI",
    envKeys: ["TOGETHER_API_KEY"],
    keyringEnv: "JAA_TOGETHER_API_KEY",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    envKeys: ["XAI_API_KEY"],
    keyringEnv: "JAA_XAI_API_KEY",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    envKeys: ["AZURE_OPENAI_API_KEY"],
    keyringEnv: "JAA_AZURE_API_KEY",
  },
  {
    id: "ollama",
    label: "Ollama (local, no key)",
    envKeys: [],
    keyringEnv: "JAA_OLLAMA_API_KEY",
    localOnly: true,
    note: "Local-first. Set JAA_OLLAMA_BASE_URL to override http://localhost:11434.",
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providerIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

/** Oracle of whether a provider is usable from current env + keyring. */
export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  localOnly: boolean;
  source?: "process" | "project" | "home" | "keyring";
}

export function providerStatuses(hasKeyring: (def: ProviderDef) => boolean): ProviderStatus[] {
  const layers = envStatus();
  return PROVIDERS.map((p) => {
    if (p.localOnly) {
      return { id: p.id, label: p.label, configured: true, localOnly: true };
    }
    const env = layers.find((l) => p.envKeys.includes(l.key));
    if (env) return { id: p.id, label: p.label, configured: true, localOnly: false, source: env.source };
    if (hasKeyring(p)) {
      return { id: p.id, label: p.label, configured: true, localOnly: false, source: "keyring" };
    }
    return { id: p.id, label: p.label, configured: false, localOnly: false };
  });
}

import { envLayers } from "./env.js";
function envStatus(): { key: string; source: "process" | "project" | "home" }[] {
  const names = new Set(PROVIDERS.flatMap((p) => p.envKeys));
  return envLayers()
    .keys()
    .filter((k) => names.has(k.key))
    .map((k) => ({ key: k.key, source: k.source }));
}
import { bashTools } from "./bash.js";
import { fsTools } from "./fs.js";
import { gitTools } from "./git.js";
import { patchTools } from "./patch.js";
import { createRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";
import { webTools } from "./web.js";

/**
 * The standard tool set for `jaa ask`. All paths are confined to the provided
 * workspace root, and bash is gated by ToolContext.allowBash.
 */
export function defaultToolDefinitions(): ToolDefinition[] {
  return [...fsTools, ...patchTools, ...bashTools, ...webTools, ...gitTools];
}

export function createDefaultRegistry() {
  return createRegistry(defaultToolDefinitions());
}

export type { ToolContext, ToolDefinition } from "./types.js";
export type { Registry } from "./registry.js";
/**
 * What a local Ollama has, if there is one.
 *
 * Kept apart from the setup screen so the screen stays a rendering concern and
 * this stays a question with an answer. The distinction matters because the two
 * fail differently: a screen bug should not look like "no models installed", and
 * a missing Ollama should not look like a crash.
 */

export interface LocalModel {
  name: string;
  /** Bytes, when the server reports it. Used to sort, never shown raw. */
  sizeBytes: number;
}

/** Shape of the subset of `/api/tags` this reads. */
interface TagsResponse {
  models?: { name?: unknown; size?: unknown }[];
}

/**
 * List the models a local Ollama has pulled.
 *
 * Returns an empty list for every failure — no server, a timeout, a socket that
 * is not there, a response in an unexpected shape. Each of those means the same
 * thing to the person looking at the screen: there is nothing local to offer, so
 * the setup falls through to the hosted providers.
 *
 * Not swallowing silently, though: `fetchImpl` is injectable so the tests cover
 * each failure, and the timeout is short on purpose. A setup screen that waits
 * five seconds on a machine with no Ollama is a setup screen nobody finishes.
 */
export async function listLocalModels(
  timeoutMs = 1_500,
  deps: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<LocalModel[]> {
  const base = (deps.baseUrl ?? process.env.JAA_OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${base}/api/tags`, { signal: controller.signal });
    if (!response.ok) return [];
    const body = (await response.json()) as TagsResponse;
    if (!Array.isArray(body.models)) return [];
    return body.models
      .map((model) => ({
        name: typeof model.name === "string" ? model.name : undefined,
        sizeBytes: typeof model.size === "number" ? model.size : 0,
      }))
      .filter((model): model is LocalModel => model.name !== undefined && model.name !== "")
      // Biggest first: a larger local model is nearly always the one worth
      // offering as the default, and alphabetical order would bury it under
      // parameter-count prefixes.
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** `4.7 GB`, for a row under a model name. */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

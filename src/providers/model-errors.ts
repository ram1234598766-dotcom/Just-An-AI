/**
 * Recognising a provider error that means "that model does not exist".
 *
 * Model IDs rot. `gemini-1.5-flash` and `claude-3-5-sonnet-20241022` were both
 * correct when written, both are now rejected, and both failed the same way: a
 * turn that had nothing wrong with it died on a 404 the user could not act on.
 * A hardcoded default will rot again, so the thing that has to be right is not
 * the string - it is what happens when the string is wrong.
 *
 * So the loop retires the model on the spot and carries on. The alternative,
 * which is what shipped, is a raw provider payload in the transcript ending the
 * turn and telling the operator to go and look up a model name.
 */

/**
 * The providers word a missing model differently, so all the shapes are matched.
 *
 * Underscores are folded to spaces before matching, because the same condition
 * arrives as `NOT_FOUND` from Google, `not_found_error` from Anthropic, and
 * "is not found" in prose - and a list that enumerates those separately is a
 * list that misses the next one.
 */
const MISSING_MODEL_PATTERNS: readonly RegExp[] = [
  /\bnot found\b/i,
  /\bdoes not exist\b/i,
  /\bno such model\b/i,
  /\bmodel not found\b/i,
  /\bunknown model\b/i,
  /\bdeprecated model\b/i,
  /\bmodel is retired\b/i,
  /\bretired model\b/i,
  /\binvalid model\b/i,
  /\bunsupported model\b/i,
];

/** Status codes that mean the model, rather than the request, is the problem. */
const MISSING_MODEL_STATUS = new Set([404]);

/**
 * The HTTP-ish status on an error, if it exposes one.
 *
 * Read defensively across five shapes because the SDKs differ: a `status` field
 * on the error, a `statusCode`, a `code`, and Google's own `{ error: { code } }`
 * nesting where the code is a number that is not the HTTP status at all. Only a
 * genuine 404 is trusted as a status; a `code` of 404 from a different namespace
 * is not evidence about HTTP, so it is not used as such.
 */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const candidates = [record["status"], record["statusCode"], record["httpStatus"]];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && MISSING_MODEL_STATUS.has(candidate)) return candidate;
  }
  const nested = record["error"];
  if (typeof nested === "object" && nested !== null) {
    const status = (nested as Record<string, unknown>)["status"];
    if (typeof status === "number" && MISSING_MODEL_STATUS.has(status)) return status;
  }
  return undefined;
}

/** Every scrap of text an error object carries, joined, for pattern matching. */
function textOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message} ${cause === undefined ? "" : JSON.stringify(safe(cause))}`;
  }
  return safe(err);
}

function safe(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Does this failure mean the model is gone?
 *
 * Only ever true for a shape that is *about* a model. A 404 on some unrelated
 * path is not a missing model, so the text has to name one: every pattern above
 * is a phrase a provider uses when the model is the subject, not a bare status
 * code on its own.
 */
export function isMissingModelError(err: unknown): boolean {
  const text = textOf(err).replace(/_/g, " ");
  const status = statusOf(err);
  // A model name in the message, plus a not-found shape, is the signal. Requiring
  // both is what stops a 404 on some other resource from silently swapping the
  // model out from under a person who had configured it deliberately.
  const namesAModel = /\bmodels?[\/: ]|\bmodel\b/i.test(text);
  if (status === 404 && namesAModel) return true;
  return MISSING_MODEL_PATTERNS.some((pattern) => pattern.test(text)) && namesAModel;
}

/**
 * The model an error was complaining about, if it named one.
 *
 * Used to say which model died, so the notice is specific rather than "something
 * went wrong and I changed a setting".
 */
export function mentionedModel(err: unknown): string | undefined {
  const text = textOf(err);
  const match = /\bmodels?\/([A-Za-z0-9._:\-]+)/.exec(text);
  return match?.[1];
}

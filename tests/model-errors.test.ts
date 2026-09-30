import { describe, expect, it } from "vitest";

import { isMissingModelError, mentionedModel } from "../src/providers/model-errors.js";
import { currentDefaultModel, replacementModel } from "../src/providers/router.js";

/**
 * The retired-model fallback.
 *
 * The bug this exists for: `gemini-1.5-flash` was a correct default, Google
 * retired it, and a turn with nothing wrong with it died on
 *
 *   {"error":{"code":404,"message":"models/gemini-1.5-flash is not found for API
 *    version v1beta, or is not supported for generateContent. Call
 *    ModelService.ListModels to see the list of available models and their
 *    supported methods.","status":"NOT_FOUND"}}
 *
 * `claude-3-5-sonnet-20241022` failed the same way and nobody had noticed,
 * which is the point: the fix is the behaviour, not the two strings.
 */

const THE_REAL_ERROR = {
  error: {
    code: 404,
    message:
      "models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent. " +
      "Call ModelService.ListModels to see the list of available models and their supported methods.",
    status: "NOT_FOUND",
  },
};

describe("recognising a retired model", () => {
  it("matches the exact payload Google returned", () => {
    expect(isMissingModelError(THE_REAL_ERROR)).toBe(true);
  });

  it("matches an SDK Error carrying the body, which is how it arrives", () => {
    const err = new Error(JSON.stringify(THE_REAL_ERROR));
    expect(isMissingModelError(err)).toBe(true);
  });

  it("matches Anthropic's shape for a model it does not recognise", () => {
    const err = new Error(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-3-5-sonnet-20241022" } }),
    );
    expect(isMissingModelError(err)).toBe(true);
  });

  it("matches a plain Error naming a model as not found", () => {
    expect(isMissingModelError(new Error("model gpt-9-turbo does not exist"))).toBe(true);
  });

  it("names the model that died, so the notice can be specific", () => {
    expect(mentionedModel(THE_REAL_ERROR)).toBe("gemini-1.5-flash");
  });
});

describe("not mistaking other failures for a retired model", () => {
  it("ignores an auth failure", () => {
    expect(isMissingModelError({ status: 401, error: { message: "API key not valid" } })).toBe(false);
  });

  it("ignores a rate limit", () => {
    expect(isMissingModelError({ status: 429, message: "rate limit exceeded for model gemini-2.5-flash" })).toBe(false);
  });

  it("ignores a quota or billing refusal", () => {
    expect(isMissingModelError(new Error("quota exceeded for models/gemini-2.5-flash"))).toBe(false);
  });

  it("ignores a 404 that is not about a model", () => {
    // The trap: a 404 on some other resource must not quietly change which model
    // someone is paying for.
    expect(isMissingModelError({ status: 404, message: "Not Found" })).toBe(false);
  });

  it("ignores a 404 whose body never mentions a model", () => {
    expect(isMissingModelError({ status: 404, message: "The requested URL was not found on this server" })).toBe(false);
  });

  it("ignores a tool failure that happens to say 'not found'", () => {
    expect(isMissingModelError(new Error('tool "read" failed: ENOENT: no such file or directory'))).toBe(false);
  });

  it("ignores an empty error", () => {
    expect(isMissingModelError(undefined)).toBe(false);
    expect(isMissingModelError(null)).toBe(false);
  });

  it("survives an error object that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(isMissingModelError(circular)).toBe(false);
  });
});

describe("the defaults themselves", () => {
  it("no longer names a model Google has prohibited", () => {
    // Google's own codegen guidance lists gemini-1.5-* as prohibited.
    expect(currentDefaultModel("google")).toBe("gemini-2.5-flash");
    expect(currentDefaultModel("google")).not.toContain("1.5");
  });

  it("no longer names a model outside Anthropic's current model list", () => {
    expect(currentDefaultModel("anthropic")).toBe("claude-sonnet-4-6");
    expect(currentDefaultModel("anthropic")).not.toContain("3-5-sonnet");
  });

  it("offers a replacement for a dead model", () => {
    expect(replacementModel("google", "gemini-1.5-flash")).toBe("gemini-2.5-flash");
    expect(replacementModel("anthropic", "claude-3-5-sonnet-20241022")).toBe("claude-sonnet-4-6");
  });

  it("offers nothing when the dead model is already the default", () => {
    // Retrying it would send the same request and fail identically, so the
    // original error is the honest answer.
    expect(replacementModel("google", "gemini-2.5-flash")).toBeUndefined();
  });

  it("offers nothing for a provider it has no default for", () => {
    expect(replacementModel("something-new", "whatever")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent/loop.js";
import type { ChatRequest, ChatResponse, ProviderAdapter, ResolvedModel } from "../src/providers/types.js";

const DEAD = "gemini-1.5-flash";
const LIVE = "gemini-2.5-flash";
const PAYLOAD = {
  error: {
    code: 404,
    message: "models/" + DEAD + " is not found for API version v1beta. Call ModelService.ListModels to see the list.",
    status: "NOT_FOUND",
  },
};

function reply(model: string): ChatResponse {
  return {
    message: { role: "assistant", content: "answered by " + model },
    usage: { inputTokens: 1, outputTokens: 1 },
    model,
    provider: "google",
  };
}

function adapter(asked: string[], failOn: (model: string) => boolean, id = "google"): ProviderAdapter {
  return {
    id,
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      asked.push(req.model);
      if (failOn(req.model)) throw new Error(JSON.stringify(PAYLOAD));
      return reply(req.model);
    },
  };
}

function resolved(asked: string[], failOn: (m: string) => boolean): ResolvedModel {
  return { provider: "google", model: DEAD, adapter: adapter(asked, failOn) };
}

const noTools = async (): Promise<string> => "unused";

describe("the loop retires a model the provider has dropped", () => {
  it("answers the turn with the replacement instead of failing it", async () => {
    const asked: string[] = [];
    const retired: string[] = [];
    const result = await runAgentLoop({
      model: resolved(asked, (m) => m === DEAD),
      messages: [{ role: "user", content: "hello" }],
      executeTool: noTools,
      onModelRetired: (dead, replacement) => {
        retired.push(dead + "->" + replacement);
      },
    });
    expect(asked).toEqual([DEAD, LIVE]);
    expect(result.messages.at(-1)?.content).toBe("answered by " + LIVE);
    expect(retired).toEqual([DEAD + "->" + LIVE]);
  });

  it("announces the swap, because silently changing the model is not acceptable", async () => {
    const asked: string[] = [];
    let told = "";
    await runAgentLoop({
      model: resolved(asked, (m) => m === DEAD),
      messages: [{ role: "user", content: "hello" }],
      executeTool: noTools,
      onModelRetired: (dead) => {
        told = dead;
      },
    });
    expect(told).toBe(DEAD);
  });

  it("does not retry a failure that is not about a model", async () => {
    const asked: string[] = [];
    const authOnly: ResolvedModel = {
      provider: "google",
      model: DEAD,
      adapter: { id: "google", chat: async () => { throw new Error("API key not valid"); } },
    };
    // An auth failure must not cause a second call with a different model: that
    // would turn one clear error into two confusing ones.
    await expect(
      runAgentLoop({ model: authOnly, messages: [{ role: "user", content: "hi" }], executeTool: noTools }),
    ).rejects.toThrow(/API key not valid/);
    expect(asked).toEqual([]);
  });

  it("gives up honestly when the replacement is the same dead model", async () => {
    const asked: string[] = [];
    const model: ResolvedModel = { provider: "google", model: LIVE, adapter: adapter(asked, () => true) };
    // A second identical request would fail identically, so the original error is
    // the answer rather than a duplicated round trip.
    await expect(
      runAgentLoop({ model, messages: [{ role: "user", content: "hi" }], executeTool: noTools }),
    ).rejects.toThrow(/ListModels/);
    expect(asked).toEqual([LIVE]);
  });
});
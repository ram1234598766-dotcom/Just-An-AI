import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvLayers } from "../src/config/env.js";
import { setKey } from "../src/config/keyring.js";
import { providerById } from "../src/config/providers.js";
import { saveSettings, defaultSettings } from "../src/config/settings.js";
import {
  mapMessages as mapAnthropic,
  mapToolCalls as mapAnthropicToolCalls,
  createAnthropicAdapter,
} from "../src/providers/anthropic.js";
import { mapMessages as mapGemini, mapToolCalls as mapGeminiToolCalls } from "../src/providers/gemini.js";
import { mapMessages as mapOllama, mapToolCalls as mapOllamaToolCalls } from "../src/providers/ollama.js";
import {
  mapMessagesToWire,
  mapWireToolCalls,
  createOpenAICompatible,
} from "../src/providers/openaiCompatible.js";
import { resolveAdapter, resolveModel, defaultModelFor, PROVIDERS } from "../src/providers/router.js";
import type { ChatMessage, ToolDef } from "../src/providers/types.js";

function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

function toolCalls<T>(message: T): unknown {
  return (message as { tool_calls?: unknown }).tool_calls;
}

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-prov-"));
  process.env.JAA_HOME = tmp;
  resetEnvLayers();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  resetEnvLayers();
  rmSync(tmp, { recursive: true, force: true });
});

const sample: ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "List files" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "list_files", arguments: '{"path":"src"}' }],
  },
  { role: "tool", content: "index.ts", toolCallId: "call-1" },
];

const toolDef: ToolDef = { name: "list_files", description: "list dir", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

describe("message mapping (pure)", () => {
  it("openai-compatible wire format", () => {
    const wire = mapMessagesToWire(sample);
    expect(wire[0]).toEqual({ role: "system", content: "You are helpful." });
    const assistant = need(wire[2], "assistant message");
    expect(toolCalls(assistant)).toHaveLength(1);
    expect(wire[3]).toEqual({ role: "tool", content: "index.ts", tool_call_id: "call-1" });
    expect(mapWireToolCalls(toolCalls(assistant) as unknown[])).toEqual([
      { id: "call-1", name: "list_files", arguments: '{"path":"src"}' },
    ]);
  });

  it("openai-compatible wire format survives null tool_calls (non-tool reply)", () => {
    const wire = mapMessagesToWire([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    const asst = need(wire[1], "assistant message");
    expect(toolCalls(asst)).toBeUndefined();
    expect(mapWireToolCalls(toolCalls(asst) as unknown[])).toBeUndefined();
  });

  it("anthropic: system param + tool_result blocks", () => {
    const mapped = mapAnthropic(sample, [toolDef]);
    expect(mapped.system).toBe("You are helpful.");
    expect(mapped.messages).toHaveLength(3); // system skipped
    const asstBlock = need(mapped.messages[1], "assistant msg");
    const content = asstBlock.content;
    expect(Array.isArray(content) ? (content as { type?: string }[])[0] : null).toMatchObject({
      type: "tool_use",
      name: "list_files",
    });
    const toolMsg = need(mapped.messages[2], "tool msg");
    expect(toolMsg).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "index.ts" }],
    });
    expect(mapped.tools).toHaveLength(1);
    expect(mapAnthropicToolCalls([{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }])).toEqual([
      { id: "t1-0", name: "f", arguments: '{"a":1}' },
    ]);
  });

  it("gemini: systemInstruction + functionCall/functionResponse parts", () => {
    const mapped = mapGemini(sample);
    expect(mapped.systemInstruction).toBe("You are helpful.");
    expect(mapped.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(need(mapped.contents[1], "model content").parts[0]).toMatchObject({ functionCall: { name: "list_files" } });
    expect(need(mapped.contents[2], "tool content").parts).toEqual(
      expect.arrayContaining([
        { text: "index.ts" },
        { functionResponse: { name: "call-1", response: { result: "index.ts" } } },
      ]),
    );
    expect(mapGeminiToolCalls([{ functionCall: { name: "f", args: { b: 2 } } }])).toEqual([
      { id: "call-0", name: "f", arguments: '{"b":2}' },
    ]);
  });

  it("ollama: tool_calls as parsed objects", () => {
    const wire = mapOllama(sample);
    const asst = need(wire[2], "assistant msg");
    expect(asst.tool_calls).toEqual([{ function: { name: "list_files", arguments: { path: "src" } } }]);
    expect(wire[3]).toEqual({ role: "tool", content: "index.ts" });
    expect(mapOllamaToolCalls([{ function: { name: "f", arguments: { c: 3 } } }])).toEqual([
      { id: "call-0", name: "f", arguments: '{"c":3}' },
    ]);
  });
});

describe("adapter round-trips (fake fetch)", () => {
  it("openai-compatible chat maps response + usage", async () => {
    const payload = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from fake" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const fakeFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = createOpenAICompatible({
      id: "openai",
      apiKey: "sk-test",
      baseURL: "https://example.invalid/v1",
      fetch: fakeFetch,
    });
    const res = await adapter.chat({ model: "gpt-4o-mini", messages: sample });
    expect(res.provider).toBe("openai");
    expect(res.message.content).toBe("Hello from fake");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("anthropic chat maps text + usage", async () => {
    const payload = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "Hello Claude" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 7 },
    };
    const fakeFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = createAnthropicAdapter({
      id: "anthropic",
      apiKey: "sk-ant-test",
      baseURL: "https://example.invalid",
      fetch: fakeFetch,
    });
    const res = await adapter.chat({ model: "claude-3-5-sonnet-20241022", messages: sample });
    expect(res.message.content).toBe("Hello Claude");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });
});

describe("router", () => {
  it("resolves a keyed provider from the keyring", () => {
    const openai = need(providerById("openai"), "openai def");
    setKey(openai, "sk-test-12345");
    const adapter = resolveAdapter("openai");
    expect(adapter.id).toBe("openai");
  });

  it("resolves ollama without any key (local-first default)", () => {
    const adapter = resolveAdapter("ollama");
    expect(adapter.id).toBe("ollama");
  });

  it("throws a helpful error for an unknown provider", () => {
    expect(() => resolveAdapter("nope")).toThrow(/unknown provider "nope"/);
  });

  it("throws with setup hint when a cloud provider has no key", () => {
    expect(() => resolveAdapter("groq")).toThrow(/jaa setup|jaa key set/);
  });

  it("resolves provider + default model from settings", () => {
    const openai = need(providerById("openai"), "openai def");
    setKey(openai, "sk-x");
    const settings = defaultSettings();
    settings.defaultProvider = "openai";
    saveSettings(settings);

    const resolved = resolveModel();
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4o-mini");
    expect(resolved.keySource).toBe("keyring");

    const override = resolveModel({ provider: "ollama", model: "llama3.2" });
    expect(override.provider).toBe("ollama");
    expect(override.model).toBe("llama3.2");
    expect(override.keySource).toBeUndefined();
  });

  it("defaultModelFor covers every registered provider", () => {
    for (const p of PROVIDERS) {
      expect(defaultModelFor(p.id)).toBeTruthy();
    }
  });
});
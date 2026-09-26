import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTaskComplexity,
  estimateModelCapability,
  calculateSuccessProbability,
  applyJevRouting,
} from "../../open-sse/services/jevRouter.ts";
import type { ResolvedComboTarget, ComboLogger } from "../../open-sse/services/combo/types.ts";

const mockLog: ComboLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function createTarget(modelStr: string, weight = 1): ResolvedComboTarget {
  const parts = modelStr.split("/");
  const provider = parts.length > 1 ? parts[0] : "openai";
  return {
    kind: "model",
    stepId: `step-${modelStr}`,
    executionKey: `exec-${modelStr}`,
    modelStr,
    provider,
    providerId: provider,
    connectionId: `conn-${provider}`,
    weight,
    label: null,
  };
}

test("analyzeTaskComplexity classifies tasks accurately", () => {
  // Simple prompt
  const simple = analyzeTaskComplexity({
    messages: [{ role: "user", content: "Hello, what time is it?" }],
  });
  assert.equal(simple.taskType, "simple");
  assert.equal(simple.hasCode, false);
  assert.equal(simple.hasTools, false);
  assert.ok(simple.score < 0.35);

  // Coding prompt
  const coding = analyzeTaskComplexity({
    messages: [
      {
        role: "user",
        content:
          "Write a TypeScript function to parse JSON with recursive retry:\n```typescript\nfunction parse() {}\n```",
      },
    ],
  });
  assert.equal(coding.hasCode, true);
  assert.ok(coding.score >= 0.5);

  // Tool use
  const toolTask = analyzeTaskComplexity({
    messages: [{ role: "user", content: "Check the weather" }],
    tools: [
      {
        type: "function",
        function: { name: "get_weather", description: "Get weather" },
      },
    ],
  });
  assert.equal(toolTask.hasTools, true);
  assert.ok(toolTask.score >= 0.45);
});

test("estimateModelCapability ranks models by tier", () => {
  const o1 = estimateModelCapability("openai/o1");
  const sonnet = estimateModelCapability("anthropic/claude-3-5-sonnet");
  const mini = estimateModelCapability("openai/gpt-4o-mini");
  const haiku = estimateModelCapability("anthropic/claude-3-5-haiku");

  assert.ok(o1 > sonnet, "reasoning model capability > mid-tier");
  assert.ok(sonnet > mini, "mid-tier capability > lightweight model");
  assert.ok(mini < 0.65, "mini is lightweight tier");
  assert.ok(haiku < 0.65, "haiku is lightweight tier");
});

test("calculateSuccessProbability reflects capability vs complexity gap", () => {
  const probHigh = calculateSuccessProbability(0.85, 0.2); // Capable model, simple task
  const probLow = calculateSuccessProbability(0.45, 0.85); // Weak model, hard task

  assert.ok(probHigh > 0.9, "Capable model has >90% probability on simple task");
  assert.ok(probLow < 0.4, "Weak model has <40% probability on complex task");
});

test("applyJevRouting selects cheapest model for simple tasks", async () => {
  const targets = [
    createTarget("openai/o1"),
    createTarget("openai/gpt-4o"),
    createTarget("openai/gpt-4o-mini"),
  ];

  const body = {
    messages: [{ role: "user", content: "Tell me a short joke about coffee." }],
  };

  const combo = { name: "test-combo", models: [] };
  const config = { fastMode: true };

  const reordered = await applyJevRouting(targets, body, combo, config, mockLog);

  assert.equal(reordered.length, 3);
  // For a simple joke, gpt-4o-mini has high success probability and is the cheapest!
  assert.equal(reordered[0].modelStr, "openai/gpt-4o-mini");
  // Remaining targets are fallbacks
  assert.ok(reordered.map((t) => t.modelStr).includes("openai/gpt-4o"));
  assert.ok(reordered.map((t) => t.modelStr).includes("openai/o1"));
});

test("applyJevRouting promotes capable model for complex coding tasks", async () => {
  const targets = [
    createTarget("openai/gpt-4o-mini"),
    createTarget("openai/gpt-4o"),
    createTarget("openai/o1"),
  ];

  const body = {
    messages: [
      {
        role: "user",
        content: `
Debug and optimize this distributed Raft consensus algorithm implementation in Rust:
\`\`\`rust
impl RaftNode {
    pub async fn handle_append_entries(&mut self, req: AppendEntriesRequest) -> AppendEntriesResponse {
        // complex state machine transition and memory ordering logic
    }
}
\`\`\`
Prove step-by-step why a split-brain scenario cannot occur and analyze the trade-offs.
`,
      },
    ],
  };

  const combo = { name: "test-combo", models: [] };
  const config = { fastMode: true, jevMinConfidence: 0.75 };

  const reordered = await applyJevRouting(targets, body, combo, config, mockLog);

  assert.equal(reordered.length, 3);
  // For hard distributed systems code + proof, weak model fails confidence threshold;
  // Jev must pick gpt-4o or o1!
  assert.notEqual(reordered[0].modelStr, "openai/gpt-4o-mini");
  assert.ok(["openai/gpt-4o", "openai/o1"].includes(reordered[0].modelStr));
});

test("applyJevRouting handles single or empty target list gracefully", async () => {
  const single = [createTarget("openai/gpt-4o")];
  const resSingle = await applyJevRouting(single, {}, { name: "test", models: [] }, {}, mockLog);
  assert.deepEqual(resSingle, single);

  const empty: ResolvedComboTarget[] = [];
  const resEmpty = await applyJevRouting(empty, {}, { name: "test", models: [] }, {}, mockLog);
  assert.deepEqual(resEmpty, empty);
});

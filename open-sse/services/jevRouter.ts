/**
 * Jev System One Intelligent Decision Router for OmniRoute
 *
 * Implements System One routing:
 * "Select the cheapest model that has a sufficiently high probability
 * of successfully completing the user's task. Do NOT simply select the most capable model."
 *
 * Supports:
 * 1. TypeSafe Jev System One API (POST https://api.typesafe.ai/v1/systemone)
 * 2. High-performance internal System One heuristic decision engine
 * 3. Cost-effectiveness vs. capability threshold optimization
 * 4. Resilient progressive fallback cascade ordering
 */

import type { ComboLogger, ResolvedComboTarget, ComboLike } from "./combo/types.ts";

export interface JevRoutingConfig {
  apiKey?: string;
  apiUrl?: string;
  minConfidence?: number;
  fastMode?: boolean;
}

export interface TaskComplexityAnalysis {
  score: number; // 0.0 (simplest) to 1.0 (hardest)
  tokensEstimate: number;
  hasCode: boolean;
  hasMath: boolean;
  hasTools: boolean;
  hasReasoningKeywords: boolean;
  taskType: "simple" | "moderate" | "complex";
}

export interface ModelProfile {
  target: ResolvedComboTarget;
  modelStr: string;
  provider: string;
  model: string;
  inputCostPer1M: number;
  capabilityScore: number;
  successProbability: number;
}

const DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MIN_CONFIDENCE = 0.7;

/**
 * Analyzes request messages, tools, and options to estimate task complexity.
 */
export function analyzeTaskComplexity(body: Record<string, unknown>): TaskComplexityAnalysis {
  let text = "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      if (typeof m.content === "string") {
        text += " " + m.content;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") {
              text += " " + p.text;
            }
          }
        }
      }
    }
  }

  const length = text.length;
  const tokensEstimate = Math.ceil(length / 4);

  // Signals
  const hasCode =
    /```|function\s*\(|def\s+[a-zA-Z_]|class\s+[a-zA-Z_]|const\s+|let\s+|var\s+|import\s+|export\s+|public\s+static|#include|<script|SELECT\s+.*\s+FROM/i.test(
      text
    );

  const hasMath =
    /\b(derivative|integral|equation|theorem|eigenvalue|matrix|vector|probability|calculus|logarithm|quaternion|laplace|fourier)\b|\b\d+\s*[\+\-\*\/]\s*\d+\b|\\frac|\\sum|\\sqrt/i.test(
      text
    );

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  const hasReasoningKeywords =
    /\b(step[- ]by[- ]step|prove|deduce|debug|analyze\s+the\s+root\s+cause|compare\s+and\s+contrast|architect|optimize\s+performance|trade-offs|explain\s+why)\b/i.test(
      text
    );

  // Compute complexity score [0, 1]
  let score = 0.2; // Baseline for simple chat

  if (length > 4000) score += 0.2;
  else if (length > 1000) score += 0.1;

  if (hasCode) score += 0.3;
  if (hasMath) score += 0.25;
  if (hasTools) score += 0.25;
  if (hasReasoningKeywords) score += 0.15;

  score = Math.min(1.0, Math.max(0.1, score));

  let taskType: "simple" | "moderate" | "complex" = "simple";
  if (score >= 0.65) {
    taskType = "complex";
  } else if (score >= 0.35) {
    taskType = "moderate";
  }

  return {
    score,
    tokensEstimate,
    hasCode,
    hasMath,
    hasTools,
    hasReasoningKeywords,
    taskType,
  };
}

/**
 * Estimates baseline capability of a model based on known family and naming patterns.
 */
export function estimateModelCapability(modelName: string): number {
  const m = modelName.toLowerCase();

  // Tier 3: Reasoning / Frontier models (~0.90 - 0.98)
  if (
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("claude-3-7") ||
    m.includes("claude-3.7") ||
    m.includes("deepseek-r1") ||
    m.includes("qwq") ||
    m.includes("gemini-2.0-flash-thinking") ||
    m.includes("gpt-4.5")
  ) {
    return 0.95;
  }

  // Tier 2: Flagship / Mid-tier models (~0.75 - 0.85)
  if (
    (m.includes("gpt-4o") && !m.includes("mini")) ||
    m.includes("gpt-4-turbo") ||
    m.includes("claude-3-5-sonnet") ||
    m.includes("claude-3.5-sonnet") ||
    m.includes("gemini-1.5-pro") ||
    m.includes("gemini-2.0-pro") ||
    m.includes("deepseek-v3") ||
    m.includes("qwen-max") ||
    m.includes("glm-4-plus")
  ) {
    return 0.82;
  }

  // Tier 1: Fast / Cost-effective models (~0.45 - 0.60)
  if (
    m.includes("mini") ||
    m.includes("haiku") ||
    m.includes("flash") ||
    m.includes("turbo") ||
    m.includes("nano") ||
    m.includes("lite") ||
    m.includes("small") ||
    m.includes("deepseek-chat")
  ) {
    return 0.52;
  }

  // General default fallback
  return 0.65;
}

/**
 * Calculates estimated probability of success for a model on a given task complexity.
 * Logistic curve: p = 1 / (1 + exp(-k * (capability - complexity)))
 */
export function calculateSuccessProbability(capability: number, complexity: number): number {
  const diff = capability - complexity;
  const k = 7.5;
  const p = 1 / (1 + Math.exp(-k * diff));
  return Math.min(0.99, Math.max(0.01, p));
}

/**
 * Attempts to query the TypeSafe Jev System One API.
 */
async function queryTypeSafeJevApi(
  apiUrl: string,
  apiKey: string,
  analysis: TaskComplexityAnalysis,
  candidates: ModelProfile[],
  log: ComboLogger
): Promise<string | null> {
  const choices = candidates.map((c) => c.modelStr);
  const candidateSummaries = candidates.map(
    (c) =>
      `${c.modelStr} (input_cost: $${c.inputCostPer1M.toFixed(2)}/1M, capability: ${(c.capabilityScore * 100).toFixed(0)}%)`
  );

  const payload = {
    question: {
      type: "Choice",
      prompt:
        "You are Jev System One. Given this user request and task complexity, select the cheapest model choice that has a high probability of successfully completing the task.",
      choices,
    },
    context: [
      `Task complexity level: ${analysis.taskType} (score: ${analysis.score.toFixed(2)})`,
      `Estimated tokens: ${analysis.tokensEstimate}`,
      `Indicators: code=${analysis.hasCode}, math=${analysis.hasMath}, tools=${analysis.hasTools}`,
      `Available choices with cost and capability: \n${candidateSummaries.join("\n")}`,
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log.warn("COMBO", `[JEV] TypeSafe API returned status ${res.status}`);
      return null;
    }

    const data = (await res.json()) as Record<string, unknown>;
    // Check answer or result fields
    let chosen: unknown = data.answer ?? data.choice;
    if (!chosen && data.result && typeof data.result === "object") {
      const r = data.result as Record<string, unknown>;
      chosen = r.answer ?? r.choice;
    }

    if (typeof chosen === "string" && choices.includes(chosen)) {
      return chosen;
    }

    return null;
  } catch (err) {
    log.warn("COMBO", `[JEV] TypeSafe API query failed, falling back to heuristic`, { err });
    return null;
  }
}

/**
 * Main entry point for Jev System One combo routing.
 */
export async function applyJevRouting(
  orderedTargets: ResolvedComboTarget[],
  body: Record<string, unknown>,
  combo: ComboLike,
  config: Record<string, unknown>,
  log: ComboLogger
): Promise<ResolvedComboTarget[]> {
  if (orderedTargets.length <= 1) {
    return orderedTargets;
  }

  const analysis = analyzeTaskComplexity(body);

  // Retrieve pricing and profile each candidate
  let getPricingForModel:
    | ((provider: string, model: string) => Promise<{ input?: number; output?: number } | null>)
    | null = null;

  try {
    const settingsModule = await import("@/lib/db/settings");
    getPricingForModel = settingsModule.getPricingForModel;
  } catch {
    // Pricing lookup unavailable
  }

  const candidates: ModelProfile[] = await Promise.all(
    orderedTargets.map(async (target) => {
      const modelStr = target.modelStr || "";
      const provider = target.provider || "unknown";
      const model = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;

      let inputCost = 0;
      if (getPricingForModel) {
        try {
          const pricing = await getPricingForModel(provider, model);
          if (pricing && typeof pricing.input === "number" && Number.isFinite(pricing.input)) {
            inputCost = pricing.input;
          }
        } catch {
          // ignore error
        }
      }

      const capabilityScore = estimateModelCapability(modelStr);
      // If pricing is missing from DB, estimate cost relative to capability tier
      if (inputCost === 0) {
        if (capabilityScore >= 0.9) inputCost = 15.0;
        else if (capabilityScore >= 0.75) inputCost = 3.0;
        else inputCost = 0.2;
      }

      const successProbability = calculateSuccessProbability(capabilityScore, analysis.score);

      return {
        target,
        modelStr,
        provider,
        model,
        inputCostPer1M: inputCost,
        capabilityScore,
        successProbability,
      };
    })
  );

  const minConfidence =
    typeof config.jevMinConfidence === "number" ? config.jevMinConfidence : DEFAULT_MIN_CONFIDENCE;

  const apiKey =
    (typeof config.jevApiKey === "string" ? config.jevApiKey : "") ||
    process.env.JEV_API_KEY ||
    process.env.TYPESAFE_API_KEY ||
    "";

  const apiUrl =
    (typeof config.jevApiUrl === "string" ? config.jevApiUrl : "") ||
    process.env.JEV_API_URL ||
    DEFAULT_JEV_API_URL;

  let selectedModelStr: string | null = null;

  // 1. Try TypeSafe Jev API if API key is provided and fastMode is not forced
  if (apiKey && config.fastMode !== true) {
    selectedModelStr = await queryTypeSafeJevApi(apiUrl, apiKey, analysis, candidates, log);
  }

  // 2. If not selected via API, use internal System One decision rule:
  // "Select the cheapest model that has a sufficiently high probability of success"
  if (!selectedModelStr) {
    const eligible = candidates.filter((c) => c.successProbability >= minConfidence);

    let winner: ModelProfile;
    if (eligible.length > 0) {
      // Pick cheapest among eligible
      eligible.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);
      winner = eligible[0];
    } else {
      // No candidate reached min confidence, pick the most capable model
      candidates.sort((a, b) => b.capabilityScore - a.capabilityScore);
      winner = candidates[0];
    }
    selectedModelStr = winner.modelStr;
  }

  const winnerProfile = candidates.find((c) => c.modelStr === selectedModelStr) || candidates[0];

  // 3. Order targets:
  // - Winner first
  // - Fallbacks sorted by capability and cost so progressive fallback upgrades if needed
  const remaining = candidates.filter((c) => c.modelStr !== winnerProfile.modelStr);
  remaining.sort((a, b) => {
    // Higher capability first for fallbacks
    if (b.capabilityScore !== a.capabilityScore) {
      return b.capabilityScore - a.capabilityScore;
    }
    return a.inputCostPer1M - b.inputCostPer1M;
  });

  const reordered: ResolvedComboTarget[] = [
    winnerProfile.target,
    ...remaining.map((r) => r.target),
  ];

  log.info(
    "COMBO",
    `[Jev System One] Selected ${winnerProfile.modelStr} for combo "${combo.name}" (cost: $${winnerProfile.inputCostPer1M.toFixed(2)}/1M, probability: ${(winnerProfile.successProbability * 100).toFixed(0)}%, task complexity: ${analysis.score.toFixed(2)} [${analysis.taskType}])`
  );

  return reordered;
}

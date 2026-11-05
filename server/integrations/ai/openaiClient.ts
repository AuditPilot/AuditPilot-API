import OpenAI from "openai";
import { ENV } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * Thin OpenAI-compatible client wrapper (OpenRouter today).
 * The full AI Gateway (task routing, zod validation, retries, cost tracking)
 * lands in the jobs commit — this wrapper only centralizes construction and
 * JSON extraction so modules stop reading env vars directly.
 */

export const DEFAULT_TRIAGE_MODEL = "gemini-3.5-flash-lite";

let client: OpenAI | null = null;

export function ai(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: ENV.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: ENV.AI_INTEGRATIONS_OPENAI_BASE_URL.replace(/\/$/, ""),
      defaultHeaders: {
        "HTTP-Referer": "https://auditpilots.netlify.app",
        "X-Title": "AuditsPilot",
      },
    });
    logger.info(
      {
        keyPresent: Boolean(ENV.AI_INTEGRATIONS_OPENAI_API_KEY),
        base: ENV.AI_INTEGRATIONS_OPENAI_BASE_URL,
      },
      "AI client initialized",
    );
  }
  return client;
}

export function hasAiKey(): boolean {
  return Boolean(ENV.AI_INTEGRATIONS_OPENAI_API_KEY);
}

export function triageModel(): string {
  return ENV.AI_MODEL_TRIAGE || DEFAULT_TRIAGE_MODEL;
}

export function deepModel(): string {
  return ENV.AI_MODEL_DEEP || triageModel();
}

/**
 * AI models sometimes wrap JSON in markdown fences or prose. Extract the first
 * balanced-looking JSON object. Returns null when no JSON can be located.
 */
export function safeJsonParse(content: string): Record<string, unknown> | null {
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1) {
      const clean = content.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
      return JSON.parse(clean) as Record<string, unknown>;
    }
    return JSON.parse(content.substring(start, end + 1)) as Record<string, unknown>;
  } catch {
    logger.warn("Failed to parse AI response as JSON");
    return null;
  }
}

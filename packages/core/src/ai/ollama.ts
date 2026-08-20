/**
 * Ollama over its local HTTP API. No SDK — the surface we need is one endpoint,
 * and keeping it dependency-free means the core package stays installable
 * offline.
 */

import type { ChatMessage, GenerateOptions, LLMProvider } from "./provider.js";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** Ollama loads the model on first call; cold starts are slow. */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434"
    ).replace(/\/$/, "");
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
    // Long enough for a cold model load, short enough that a runaway
    // generation surfaces as an error instead of a two-minute stall.
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: { name?: string }[] };
      const models = body.models ?? [];
      if (models.length === 0) return false;
      // A configured-but-absent model is worse than no Ollama: it fails later.
      return models.some(
        (m) =>
          m.name === this.model ||
          m.name?.split(":")[0] === this.model.split(":")[0],
      );
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: { name?: string }[] };
      return (body.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => Boolean(n));
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(opts.json ? { format: "json" } : {}),
          options: {
            // Interpretation wants determinism, not flair.
            temperature: opts.temperature ?? 0,
            ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as OllamaChatResponse;
      if (body.error) throw new Error(`Ollama error: ${body.error}`);
      return body.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }
}

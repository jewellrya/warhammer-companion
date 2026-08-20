/**
 * Model-provider seam. Ollama is the only implementation that talks to a model
 * today, but nothing above this file knows that.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  /** Force JSON-shaped output where the backend supports it. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  chat(messages: ChatMessage[], opts?: GenerateOptions): Promise<string>;
}

/** Models wrap JSON in prose or fences no matter how firmly you ask them not to. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter(
    (c): c is string => typeof c === "string",
  );

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // Fall through to brace scanning.
    }
  }

  // Last resort: the outermost balanced {...}, ignoring braces inside strings.
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(`No JSON object found in model output: ${text.slice(0, 200)}`);
}

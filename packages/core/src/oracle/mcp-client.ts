/**
 * Thin MCP stdio client for a locally-running server.
 *
 * Owns process lifecycle and reconnection so callers can just await a tool
 * call. Connection is lazy and shared: the first call spawns the server, later
 * ones reuse it. A dead server is detected on the next call and respawned once.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  clientName?: string;
  /** Per-call timeout, ms. */
  timeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** The server ran and rejected the call — a bug in our arguments, not the link. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export class McpStdioClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private toolCache: McpToolInfo[] | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  /** Idempotent; concurrent callers share one in-flight connection. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.opts.command,
        args: this.opts.args ?? [],
        cwd: this.opts.cwd,
        env: this.opts.env
          ? { ...(process.env as Record<string, string>), ...this.opts.env }
          : undefined,
        // Oracle logs its banner to stderr; keep it out of our stdout.
        stderr: "pipe",
      });

      const client = new Client(
        { name: this.opts.clientName ?? "warhammer-companion", version: "0.1.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.client = null;
      this.transport = null;
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  async listTools(force = false): Promise<McpToolInfo[]> {
    if (this.toolCache && !force) return this.toolCache;
    const client = await this.connect();
    const res = await client.listTools();
    this.toolCache = res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return this.toolCache;
  }

  /**
   * Call a tool and flatten its content to text. MCP tool results are a content
   * array; Oracle only ever returns one text block, but joining is harmless
   * and survives a future server that splits its answer.
   */
  async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const run = async (): Promise<string> => {
      const client = await this.connect();
      const res = await client.callTool(
        { name, arguments: args },
        undefined,
        this.opts.timeoutMs ? { timeout: this.opts.timeoutMs } : undefined,
      );

      const content = (res as { content?: unknown }).content;
      if (!Array.isArray(content)) return "";
      const text = content
        .filter(
          (c): c is { type: "text"; text: string } =>
            typeof c === "object" &&
            c !== null &&
            (c as { type?: unknown }).type === "text",
        )
        .map((c) => c.text)
        .join("\n\n");

      // A tool error arrives as ordinary content with an isError flag, so
      // without this a schema rejection would be parsed as if it were data.
      if ((res as { isError?: boolean }).isError || /^MCP error -?\d+:/.test(text)) {
        throw new McpToolError(text || `Tool "${name}" reported an error`, name);
      }

      return text;
    };

    try {
      return await run();
    } catch (err) {
      // The server answered and disliked the call — reconnecting changes nothing.
      if (err instanceof McpToolError) throw err;
      // A crashed or closed server surfaces here; drop it and try once more.
      await this.reset();
      try {
        return await run();
      } catch (retryErr) {
        throw new Error(
          `MCP tool "${name}" failed: ${
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          }`,
          { cause: retryErr },
        );
      }
    }
  }

  private async reset(): Promise<void> {
    this.toolCache = null;
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  get connected(): boolean {
    return this.client !== null;
  }
}

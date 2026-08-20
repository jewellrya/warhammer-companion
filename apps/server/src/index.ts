/**
 * Local API host.
 *
 * Binds to loopback only — this process holds the user's whole collection and
 * shells out to a local model, and neither belongs on a LAN interface.
 * Tauri spawns this as a sidecar; in browser dev the Vite proxy points here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AppContext, defaultConfig } from "./context.js";
import { HttpError, matchRoute, type Req } from "./routes.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WH_PORT ?? 8787);

const ctx = new AppContext(defaultConfig());

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Army lists and pasted documents are the biggest thing we accept.
    if (size > 5_000_000) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body was not valid JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    // The Tauri webview and the Vite dev server are both distinct origins.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  });
  res.end(data);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "OPTIONS") {
      send(res, 204, null);
      return;
    }

    const route = matchRoute(req.method ?? "GET", url.pathname);
    if (!route) {
      send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return;
    }

    try {
      const parsed: Req = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        body: await readBody(req),
      };
      send(res, 200, await route.handler(parsed, ctx));
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${req.method} ${url.pathname}: ${message}`);
      send(res, 500, { error: message });
    }
  })();
});

async function main(): Promise<void> {
  const status = await ctx.refresh();

  console.log(`Warhammer Companion API  http://${HOST}:${PORT}`);
  console.log(`  database     ${status.dbPath}`);
  console.log(`  edition      ${status.edition}`);
  console.log(
    `  oracle       ${status.oracle.available ? `ready (${status.oracle.tools.length} tools)` : `unavailable${status.oracle.error ? ` — ${status.oracle.error}` : ""}`}`,
  );
  console.log(
    `  interpreter  ${status.interpreter}${status.llm.available ? "" : "  (no local model — using pattern rules)"}`,
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Almost always another copy of this app, not a real fault. Say so
      // plainly and exit rather than dumping an unhandled 'error' event.
      console.error(
        `Port ${PORT} is already in use — another companion server is running.\n` +
          `Use that one, stop it first, or set WH_PORT to a different port.`,
      );
      process.exit(0);
    }
    console.error("Server error:", err);
    process.exit(1);
  });

  server.listen(PORT, HOST);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      server.close();
      await ctx.close();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

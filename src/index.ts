#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { webcrypto } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DemoStore } from "./core.js";
import { createServer } from "./server.js";

// Node 18 has no global crypto, which the SDK HTTP transport expects.
(globalThis as any).crypto ??= webcrypto;

export function startHttp(store: DemoStore, host = process.env.BH_DEMO_HOST ?? "127.0.0.1", port = Number(process.env.BH_DEMO_PORT ?? 3333)): Promise<Server> {
  const http = createHttpServer(async (req, res) => {
    const send = (code: number, msg: string) => { res.writeHead(code, { "content-type": "text/plain" }).end(msg); };
    // Guard against DNS rebinding: only answer requests addressed to this machine (or the host set in BH_DEMO_HOST).
    const a = http.address() as { port: number } | null;
    const ok = new Set(["127.0.0.1", "localhost", "[::1]", host].map((h) => `${h}:${a?.port ?? port}`));
    if (!ok.has(req.headers.host ?? "")) return send(403, "Forbidden host");
    const origin = req.headers.origin;
    if (origin) {
      // "null" and malformed origins make new URL() throw, so treat them as forbidden rather than crash.
      let originHost = "";
      try { originHost = new URL(origin).host; } catch { return send(403, "Forbidden origin"); }
      if (!ok.has(originHost)) return send(403, "Forbidden origin");
    }
    if (req.url?.split("?")[0] !== "/mcp") return send(404, "Not found");
    if (req.method !== "POST") return send(405, "Use POST /mcp");
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return send(413, "Too large"); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return send(400, "Bad JSON"); }
    // Stateless: a fresh transport and server per request, all sharing the one store.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer(store);
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve(http));
  });
}

async function main() {
  const store = new DemoStore();
  if (process.argv.includes("--http")) {
    const http = await startHttp(store);
    const a = http.address() as { address: string; port: number };
    console.error(`bh-demo-erp (Streamable HTTP) on http://${a.address}:${a.port}/mcp, writes ${store.allowWrites ? "ON" : "off"}`);
  } else {
    await createServer(store).connect(new StdioServerTransport());
    console.error(`bh-demo-erp (stdio), writes ${store.allowWrites ? "ON" : "off"}`);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DemoStore, TOKEN_TTL_MS } from "../src/core.js";
import { createServer } from "../src/server.js";
import { request as httpRequest } from "node:http";
import { startHttp } from "../src/index.js";

const NOW = Date.parse("2026-10-13T08:00:00Z");
const ROOT = process.cwd(); // npm test runs in the server folder
const tmp = () => mkdtempSync(join(tmpdir(), "bh-demo-"));

async function rig(opts: { writes: boolean; clock?: { t: number } }) {
  const clock = opts.clock ?? { t: NOW };
  const auditPath = join(tmp(), "audit.log");
  const store = new DemoStore({ allowWrites: opts.writes, now: () => clock.t, auditPath });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { store, client, call, clock, auditPath };
}
const ORDER = { customer_id: "CUST-0001", lines: [{ item_code: "ITM-001", qty: 15 }, { item_code: "ITM-002", qty: 40 }] };

test("1 stdio server lists exactly the 7 tools", async () => {
  const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist/index.js")], env: { PATH: process.env.PATH ?? "", BH_AUDIT_LOG: join(tmp(), "a.log") } });
  const c = new Client({ name: "t", version: "1" });
  await c.connect(t);
  const names = (await c.listTools()).tools.map((x) => x.name).sort();
  await c.close();
  assert.deepEqual(names, ["check_stock", "confirm_sales_order", "get_customer", "list_customers", "list_overdue_invoices", "prepare_sales_order", "reset_demo"]);
});

test("2 overdue invoices at a fixed as_of", async () => {
  const { call } = await rig({ writes: false });
  const r = await call("list_overdue_invoices", { as_of: "2026-10-13" });
  assert.equal(r.data.count, 7);
  assert.equal(r.data.total, 22750 + 8100 + 15300 + 12500 + 7300 + 11200 + 31800);
  const over30 = await call("list_overdue_invoices", { min_days: 31, as_of: "2026-10-13" });
  assert.equal(over30.data.count, 3);
  assert.equal(over30.data.total, 22750 + 15300 + 7300);
});

test("currency is GBP on every money result", async () => {
  const { call } = await rig({ writes: true });
  assert.equal((await call("list_customers")).data.currency, "GBP");
  assert.equal((await call("get_customer", { customer_id: "CUST-0001" })).data.currency, "GBP");
  assert.equal((await call("list_overdue_invoices")).data.currency, "GBP");
  const p = await call("prepare_sales_order", ORDER);
  assert.equal(p.data.preview.currency, "GBP");
  assert.equal((await call("confirm_sales_order", { confirm_token: p.data.confirm_token })).data.currency, "GBP");
});

test("3 check_stock flags the below-reorder item", async () => {
  const { call } = await rig({ writes: false });
  const g = (await call("check_stock", { search: "angle grinder" })).data[0];
  assert.equal(g.on_hand, 12);
  assert.equal(g.below_reorder_level, true);
  assert.equal((await call("check_stock", { item_code: "ITM-002" })).data[0].below_reorder_level, false);
});

test("4 writes off: prepare refuses, nothing changes", async () => {
  const { call, store } = await rig({ writes: false });
  const r = await call("prepare_sales_order", ORDER);
  assert.equal(r.isError, true);
  assert.match(r.data.error, /Writes disabled/);
  assert.equal(store.orders.length, 0);
});

test("5 prepare then confirm creates one Draft; reuse fails", async () => {
  const { call, store } = await rig({ writes: true });
  const p = await call("prepare_sales_order", ORDER);
  assert.equal(p.isError, false);
  assert.equal(p.data.preview.total, 15 * 79 + 40 * 9);
  assert.equal(store.orders.length, 0);
  assert.ok(p.data.warnings.some((w: string) => w.startsWith("Stock")));
  const c = await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  assert.equal(c.data.status, "Draft");
  assert.equal(store.orders.length, 1);
  const again = await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  assert.equal(again.isError, true);
  assert.match(again.data.error, /already used/);
  assert.equal(store.orders.length, 1);
});

test("6 expired and tampered tokens fail", async () => {
  const { call, store, clock } = await rig({ writes: true });
  const p = await call("prepare_sales_order", ORDER);
  const tok: string = p.data.confirm_token;
  for (const i of [3, tok.length - 1]) {
    const bad = tok.slice(0, i) + (tok[i] === "A" ? "B" : "A") + tok.slice(i + 1);
    const r = await call("confirm_sales_order", { confirm_token: bad });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /Invalid/);
  }
  clock.t = NOW + TOKEN_TTL_MS + 1000;
  const r = await call("confirm_sales_order", { confirm_token: tok });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /expired/);
  assert.equal(store.orders.length, 0);
});

test("7 over credit limit: warning at prepare, refused at confirm", async () => {
  const { call, store } = await rig({ writes: true });
  const p = await call("prepare_sales_order", { customer_id: "CUST-0001", lines: [{ item_code: "ITM-001", qty: 5000 }] });
  assert.ok(p.data.warnings.some((w: string) => w.startsWith("Credit")));
  const r = await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /Refused/);
  assert.equal(store.orders.length, 0);
});

test("8 injection note is wrapped as untrusted_text", async () => {
  const { call } = await rig({ writes: false });
  const r = await call("get_customer", { customer_id: "CUST-0002" });
  const hit = r.data.notes.find((n: any) => /ignore previous instructions/i.test(n.untrusted_text ?? ""));
  assert.ok(hit);
  assert.ok(!/ignore previous instructions/i.test(JSON.stringify({ ...r.data, notes: [] })));
});

test("9 reset_demo restores the seed", async () => {
  const { call, store } = await rig({ writes: true });
  const p = await call("prepare_sales_order", ORDER);
  await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  assert.equal(store.orders.length, 1);
  await call("reset_demo");
  assert.equal(store.orders.length, 0);
  const again = await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  assert.equal(again.isError, true);
});

test("10 HTTP binds 127.0.0.1 by default, not the LAN address", async () => {
  const store = new DemoStore({ allowWrites: false, auditPath: null });
  const saved = process.env.BH_DEMO_HOST;
  delete process.env.BH_DEMO_HOST;
  const http = await startHttp(store, undefined, 0);
  if (saved !== undefined) process.env.BH_DEMO_HOST = saved;
  try {
    const { address, port } = http.address() as net.AddressInfo;
    assert.equal(address, "127.0.0.1");
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) {
      const refused = await new Promise<boolean>((ok) => {
        const s = net.connect(port, lan.address);
        s.once("connect", () => { s.destroy(); ok(false); });
        s.once("error", () => ok(true));
      });
      assert.equal(refused, true);
    }
    // and it speaks MCP on 127.0.0.1
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert.equal((await c.listTools()).tools.length, 7);
    await c.close();
  } finally {
    http.close();
  }
});

test("audit log: one line per call, no token", async () => {
  const { call, auditPath } = await rig({ writes: true });
  const p = await call("prepare_sales_order", ORDER);
  await call("confirm_sales_order", { confirm_token: p.data.confirm_token });
  const lines = readFileSync(auditPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!readFileSync(auditPath, "utf8").includes(p.data.confirm_token));
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["time", "tool", "args", "result_size"]);
});

test("11 repo scan: no env files, secrets, outbound network, em dashes", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (["node_modules", "dist", "dist-test", "package-lock.json"].includes(n)) continue;
      const p = join(d, n);
      statSync(p).isDirectory() ? walk(p) : files.push(p);
    }
  };
  walk(ROOT);
  const emDash = String.fromCharCode(0x2014);
  for (const f of files) {
    assert.ok(!/(^|\/)\.env/.test(f) && !/\.(pem|key)$/.test(f), `secret-like file ${f}`);
    const txt = readFileSync(f, "utf8");
    assert.ok(!txt.includes(emDash), `em dash in ${f}`);
    assert.ok(!/(sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,})/.test(txt), `secret in ${f}`);
    if (f.includes("/src/")) {
      assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket)\s*\(|node:(https|http2|dgram|dns)|net\.connect|\.request\(/.test(txt), `outbound network call in ${f}`);
    }
  }
});

test("14 HTTP mode refuses bad Host and Origin headers and stays up", async () => {
  const store = new DemoStore();
  const http = await startHttp(store, undefined, 0);
  try {
    const { port } = http.address() as net.AddressInfo;
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal((await post({ origin: "null" })).status, 403);
    assert.equal((await post({ origin: "not a url" })).status, 403);
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    // fetch cannot set Host, so use a raw request for that case.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", reject);
      r.end("{}");
    });
    assert.equal(hostStatus, 403);
    assert.notEqual((await post({})).status, 403, "server still answers a normal request");
  } finally {
    http.close();
  }
});

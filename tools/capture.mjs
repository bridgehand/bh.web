// Drives the real bh-demo-erp server over stdio with the demo-script calls and saves the real replies to session.json.
// Mock data only, localhost only (stdio, no network). Usage: node capture.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.cwd().replace(/[\/]tools$/, "");
const audit = join(mkdtempSync(join(tmpdir(), "bh-")), "audit.log");
const t = new StdioClientTransport({ command: "node", args: [join(dir, "dist/index.js")], cwd: dir,
  env: { ...process.env, BH_ALLOW_WRITES: "1", BH_AUDIT_LOG: audit } });
const c = new Client({ name: "proof-capture", version: "1" });
await c.connect(t);
const call = async (tool, args = {}) => {
  const r = await c.callTool({ name: tool, arguments: args });
  return { tool, args, result: JSON.parse(r.content[0].text) };
};
await call("reset_demo");
const steps = [];
steps.push({ title: "Read", prompt: "Which customers are overdue by more than 30 days, and how much do they owe in total?", calls: [await call("list_overdue_invoices", { min_days: 30 })] });
steps.push({ title: "Read", prompt: "Do we have enough angle grinders in stock for a 15-unit order?", calls: [await call("check_stock", { search: "grinder" })] });
const prep = await call("prepare_sales_order", { customer_id: "CUST-0001", lines: [{ item_code: "ITM-001", qty: 15 }, { item_code: "ITM-002", qty: 40 }] });
steps.push({ title: "Propose", prompt: "Draft a sales order for Brindleton Builders for 15 angle grinders and 40 boxes of 50 mm screws.", calls: [prep] });
const token = prep.result.confirm_token;
const conf = await call("confirm_sales_order", { confirm_token: token });
steps.push({ title: "Confirm", prompt: "Yes, confirm.", calls: [conf] });
steps.push({ title: "Safety", prompt: "Read me the notes on the Ostravel Traders account.", calls: [await call("get_customer", { customer_id: "CUST-0002" })] });
await call("reset_demo");
await c.close();
let s = JSON.stringify(steps, null, 1);
if (token) s = s.split(token).join("[token masked]");
writeFileSync("session.json", s);
console.log("ok", prep.result.confirm_token ? "token masked" : "no token field", Object.keys(prep.result));

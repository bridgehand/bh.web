// SPDX-License-Identifier: Apache-2.0
// Bridgehand demo: mock ERP store, tool logic and confirm-token handling. Fictional data only.
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CURRENCY = "GBP";
export const TOKEN_TTL_MS = 5 * 60 * 1000;
const DAY = 86400000;

export interface Customer { id: string; name: string; city: string; credit_limit: number; notes: string[] }
export interface Item { code: string; name: string; uom: string; rate: number; on_hand: number; reorder_level: number }
export interface Invoice { id: string; customer_id: string; amount: number; posting_date: string; due_date: string; status: "Paid" | "Unpaid" }
export interface Line { item_code: string; qty: number }
export interface SalesOrder { id: string; customer_id: string; status: "Draft"; lines: { item_code: string; qty: number; rate: number; amount: number }[]; total: number }

export interface Options {
  allowWrites?: boolean;
  now?: () => number;
  auditPath?: string | null;
  seedPath?: string;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export class DemoError extends Error {}

export class DemoStore {
  readonly allowWrites: boolean;
  readonly now: () => number;
  private auditPath: string | null;
  private seedPath: string;
  private key = randomBytes(32); // signing key: memory only, never written anywhere; rotated on reset
  private usedNonces = new Set<string>();
  customers: Customer[] = [];
  items: Item[] = [];
  invoices: Invoice[] = [];
  orders: SalesOrder[] = [];

  constructor(opts: Options = {}) {
    this.allowWrites = opts.allowWrites ?? process.env.BH_ALLOW_WRITES === "1";
    this.now = opts.now ?? Date.now;
    this.auditPath = opts.auditPath === undefined ? process.env.BH_AUDIT_LOG ?? "demo-audit.log" : opts.auditPath;
    this.seedPath = opts.seedPath ?? [new URL("../data/seed.json", import.meta.url), new URL("../../data/seed.json", import.meta.url)].map((u) => fileURLToPath(u)).find((f) => existsSync(f)) ?? "data/seed.json";
    this.reset();
  }

  /** Restore the seed. Offsets in the seed are relative to the current date so the data never goes stale. */
  reset() {
    const seed = JSON.parse(readFileSync(this.seedPath, "utf8"));
    const today = Math.floor(this.now() / DAY) * DAY;
    this.customers = seed.customers;
    this.items = seed.items;
    this.invoices = seed.invoices.map((i: any) => ({
      id: i.id, customer_id: i.customer_id, amount: i.amount, status: i.status,
      posting_date: isoDate(today + i.posting_offset_days * DAY),
      due_date: isoDate(today + i.due_offset_days * DAY),
    }));
    this.orders = [];
    this.usedNonces.clear();
    this.key = randomBytes(32); // tokens issued before a reset stop working
  }

  audit(tool: string, args: unknown, resultSize: number) {
    if (!this.auditPath) return;
    const safe = JSON.parse(JSON.stringify(args ?? {}));
    if (safe && typeof safe === "object" && "confirm_token" in safe) safe.confirm_token = "[redacted]";
    const line = JSON.stringify({ time: new Date(this.now()).toISOString(), tool, args: safe, result_size: resultSize });
    appendFileSync(this.auditPath, line + "\n");
  }

  private balance(customerId: string) {
    return this.invoices.filter((i) => i.customer_id === customerId && i.status === "Unpaid").reduce((s, i) => s + i.amount, 0);
  }
  private customer(id: string) {
    const c = this.customers.find((x) => x.id === id);
    if (!c) throw new DemoError(`Unknown customer_id ${id}`);
    return c;
  }
  private item(code: string) {
    const i = this.items.find((x) => x.code === code);
    if (!i) throw new DemoError(`Unknown item_code ${code}`);
    return i;
  }

  listCustomers(search?: string) {
    const s = search?.toLowerCase();
    const customers = this.customers
      .filter((c) => !s || c.name.toLowerCase().includes(s) || c.city.toLowerCase().includes(s))
      .map((c) => ({ id: c.id, name: c.name, city: c.city, credit_limit: c.credit_limit, balance: this.balance(c.id) }));
    return { currency: CURRENCY, customers };
  }

  getCustomer(id: string) {
    const c = this.customer(id);
    return {
      currency: CURRENCY, id: c.id, name: c.name, city: c.city, credit_limit: c.credit_limit, balance: this.balance(c.id),
      notes: c.notes.map((n) => ({ untrusted_text: n })), // free text from data is never returned bare
      open_invoices: this.invoices.filter((i) => i.customer_id === id && i.status === "Unpaid"),
    };
  }

  listOverdue(minDays = 1, asOf?: string) {
    const asOfMs = Date.parse(asOf ?? isoDate(this.now()));
    if (Number.isNaN(asOfMs)) throw new DemoError("as_of must be a date like 2026-10-01");
    const rows = this.invoices
      .filter((i) => i.status === "Unpaid")
      .map((i) => ({ i, days: Math.round((asOfMs - Date.parse(i.due_date)) / DAY) }))
      .filter((r) => r.days >= minDays)
      .map((r) => ({ invoice_id: r.i.id, customer_id: r.i.customer_id, customer: this.customer(r.i.customer_id).name, amount: r.i.amount, days_overdue: r.days }));
    return { currency: CURRENCY, as_of: isoDate(asOfMs), count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0), invoices: rows };
  }

  checkStock(itemCode?: string, search?: string) {
    const s = search?.toLowerCase();
    const rows = this.items.filter((i) => (itemCode ? i.code === itemCode : !s || i.name.toLowerCase().includes(s)));
    return rows.map((i) => ({ code: i.code, name: i.name, on_hand: i.on_hand, reorder_level: i.reorder_level, below_reorder_level: i.on_hand < i.reorder_level }));
  }

  private sign(payload: string) {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  private price(customerId: string, lines: Line[]) {
    this.customer(customerId);
    if (!lines.length) throw new DemoError("lines must not be empty");
    const priced = lines.map((l) => {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new DemoError(`qty for ${l.item_code} must be a positive whole number`);
      const it = this.item(l.item_code);
      return { item_code: l.item_code, name: it.name, qty: l.qty, rate: it.rate, amount: it.rate * l.qty };
    });
    const total = priced.reduce((s, l) => s + l.amount, 0);
    const warnings: string[] = [];
    for (const l of priced) {
      const on = this.item(l.item_code).on_hand;
      if (l.qty > on) warnings.push(`Stock: ${l.name} has ${on} on hand, order needs ${l.qty}.`);
    }
    const c = this.customer(customerId);
    const exposure = this.balance(customerId) + total;
    const overCredit = exposure > c.credit_limit;
    if (overCredit) warnings.push(`Credit: balance plus this order is ${CURRENCY} ${exposure}, above the credit limit of ${CURRENCY} ${c.credit_limit}.`);
    return { priced, total, warnings, overCredit };
  }

  prepareSalesOrder(customerId: string, lines: Line[]) {
    if (!this.allowWrites) throw new DemoError("Writes disabled: start the server with BH_ALLOW_WRITES=1 to allow prepare_sales_order.");
    const p = this.price(customerId, lines);
    const exp = this.now() + TOKEN_TTL_MS;
    const payload = b64(JSON.stringify({ c: customerId, l: lines.map((l) => ({ item_code: l.item_code, qty: l.qty })), exp, n: randomBytes(12).toString("hex") }));
    return {
      preview: { customer_id: customerId, lines: p.priced, total: p.total, currency: CURRENCY, status_on_confirm: "Draft" },
      warnings: p.warnings,
      confirm_token: `${payload}.${this.sign(payload)}`,
      expires_at: new Date(exp).toISOString(),
      note: "Nothing is saved yet. Call confirm_sales_order with the token to create a Draft order.",
    };
  }

  confirmSalesOrder(token: string) {
    if (!this.allowWrites) throw new DemoError("Writes disabled: start the server with BH_ALLOW_WRITES=1.");
    const [payload, sig, extra] = token.split(".");
    if (!payload || !sig || extra !== undefined || sig !== this.sign(payload)) throw new DemoError("Invalid confirm token.");
    let d: { c: string; l: Line[]; exp: number; n: string };
    try { d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new DemoError("Invalid confirm token."); }
    if (this.now() > d.exp) throw new DemoError("Confirm token expired (5 minutes). Prepare the order again.");
    if (this.usedNonces.has(d.n)) throw new DemoError("Confirm token already used.");
    const p = this.price(d.c, d.l); // re-check stock and credit now
    if (p.overCredit) throw new DemoError(`Refused: ${p.warnings.find((w) => w.startsWith("Credit")) ?? "credit limit exceeded"}`);
    this.usedNonces.add(d.n);
    const order: SalesOrder = {
      id: `SO-${String(this.orders.length + 1).padStart(4, "0")}`, customer_id: d.c, status: "Draft",
      lines: p.priced.map(({ item_code, qty, rate, amount }) => ({ item_code, qty, rate, amount })), total: p.total,
    };
    this.orders.push(order);
    return { currency: CURRENCY, sales_order_id: order.id, status: order.status, total: order.total, warnings: p.warnings, note: "Draft only: never submitted or invoiced." };
  }
}

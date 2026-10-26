// Turns session.json (real server replies) into demo.cast (asciinema v2) and HTML terminal pages for screenshots.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const S = JSON.parse(readFileSync("session.json", "utf8"));
const C = { dim: "\x1b[90m", g: "\x1b[92m", y: "\x1b[93m", b: "\x1b[96m", w: "\x1b[97m", r: "\x1b[91m", x: "\x1b[0m", bold: "\x1b[1m" };
const gbp = (n) => "£" + n.toLocaleString("en-GB");
const banner = [
  `${C.bold}${C.g}bh-demo-erp${C.x}  ${C.dim}Ask your ERP · Bridgehand${C.x}`,
  `${C.y}Demo with fictional data${C.x} ${C.dim}(Duskridge Hardware Ltd, mock ERP) · runs on one laptop, nothing leaves it${C.x}`,
  "",
];
const you = (t) => [`${C.b}you ›${C.x} ${C.w}${t}${C.x}`, ""];
const call = (k) => `${C.dim}  ⟶ tool call${C.x} ${C.g}${k.tool}${C.x}${C.dim}(${Object.entries(k.args).map(([a, v]) => a + "=" + (typeof v === "object" ? "…" : v)).join(", ")})${C.x}`;
const [over, stock, prep, conf, safe] = S;
const L = {};
L.read = [
  ...you(over.prompt), call(over.calls[0]),
  `${C.bold}agent ›${C.x} 3 invoices are more than 30 days overdue, ${C.bold}${gbp(over.calls[0].result.total)}${C.x} in total:`,
  ...over.calls[0].result.invoices.map((i) => `    ${i.customer.padEnd(26)} ${gbp(i.amount).padStart(8)}   ${C.dim}${i.days_overdue} days${C.x}`),
  "",
  ...you(stock.prompt), call(stock.calls[0]),
  `${C.bold}agent ›${C.x} ${C.y}Not enough.${C.x} ${stock.calls[0].result[0].name}: ${stock.calls[0].result[0].on_hand} on hand, reorder level ${stock.calls[0].result[0].reorder_level}.`,
];
const p = prep.calls[0].result;
L.propose = [
  ...you(prep.prompt), call(prep.calls[0]).replace("lines=…", "lines=[2]"),
  `${C.bold}agent ›${C.x} Here is the order. ${C.bold}Nothing is saved yet.${C.x}`,
  ...p.preview.lines.map((l) => `    ${(l.qty + " × " + l.name).padEnd(38)} ${gbp(l.amount).padStart(8)}`),
  `    ${"Total".padEnd(38)} ${C.bold}${gbp(p.preview.total).padStart(8)}${C.x}`,
  `    ${C.y}⚠ ${p.warnings[0]}${C.x}`,
  `    ${C.dim}Will be created as: ${p.preview.status_on_confirm}. Confirm token is single use and expires in 5 minutes.${C.x}`,
  `${C.bold}agent ›${C.x} Shall I create it?`,
];
const q = conf.calls[0].result;
L.confirm = [
  ...you("Yes, confirm."), call(conf.calls[0]).replace(/token=.*\)/, "token=[masked])"),
  `${C.bold}agent ›${C.x} Done: ${C.g}${q.sales_order_id}${C.x} created as a ${C.bold}${q.status}${C.x}, ${gbp(q.total)}.`,
  `    ${C.dim}${q.note} Your people stay in charge of anything that touches money.${C.x}`,
];
const cu = safe.calls[0].result;
L.safety = [
  ...you(safe.prompt), call(safe.calls[0]),
  `${C.bold}agent ›${C.x} ${cu.name}, ${cu.city}. Balance ${gbp(cu.balance)} of a ${gbp(cu.credit_limit)} limit.`,
  `    The account has one note, shown here as plain text:`,
  `    ${C.y}"${cu.notes[0].untrusted_text}"${C.x}`,
  `    ${C.dim}That is an instruction hidden in the data. I report it and do not act on it.${C.x}`,
];
const footer = ["", `${C.dim}Recording: scripted client calling the real demo server. Replies are unedited; the agent lines are summaries.${C.x}`];

// asciicast v2
const W = 104, H = 34;
const events = []; let t = 0.5;
const out = (s) => events.push([+t.toFixed(3), "o", s]);
const typeLine = (l, fast) => { out(l + "\r\n"); t += fast ? 0.12 : 0.45; };
out("\x1b[2J\x1b[H"); banner.forEach((l) => typeLine(l, true)); t += 0.8;
const titles = { read: "1 of 4 · Read data", propose: "2 of 4 · Propose a change", confirm: "3 of 4 · A human confirms", safety: "4 of 4 · Safe by design" };
let first = true;
for (const k of ["read", "propose", "confirm", "safety"]) {
  if (!first) { t += 1.6; out("\x1b[2J\x1b[H"); banner.forEach((l) => typeLine(l, true)); }
  first = false;
  typeLine(`${C.dim}── ${titles[k]} ──${C.x}`, true); t += 0.4;
  for (const l of L[k]) {
    if (l.includes("you ›")) { out(l.slice(0, l.indexOf("you ›") + 12 + 5)); const rest = l.slice(l.indexOf("you ›") + 17); t += 0.3; for (const ch of rest) { out(ch); t += 0.025; } out("\r\n"); t += 0.5; }
    else typeLine(l, false);
  }
}
t += 0.8; footer.forEach((l) => typeLine(l, true)); t += 3;
writeFileSync("../demo.cast", [JSON.stringify({ version: 2, width: W, height: H, timestamp: 1792000000, title: "Ask your ERP: demo with fictional data", env: { TERM: "xterm-256color" } }), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");

// HTML
const map = { "90": "#6b7280", "92": "#6ee7b7", "93": "#fbbf24", "96": "#67e8f9", "97": "#e8eaed", "91": "#f87171" };
const html = (s) => {
  let o = "", open = 0;
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[(\d+)m$/);
    if (!m) { o += part; continue; }
    if (m[1] === "0") { o += "</span>".repeat(open); open = 0; } else if (m[1] === "1") { o += '<span style="font-weight:700">'; open++; } else { o += `<span style="color:${map[m[1]]}">`; open++; }
  }
  return o + "</span>".repeat(open);
};
const page = (k) => `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0a0b0d;width:1280px;height:720px;font:18px/1.55 'DejaVu Sans Mono',monospace;color:#c9ced6">
<div style="margin:40px;border:1px solid #23262d;border-radius:12px;background:#111317;height:640px;box-sizing:border-box;overflow:hidden">
<div style="padding:12px 18px;border-bottom:1px solid #23262d;color:#6b7280;font-size:14px;display:flex;justify-content:space-between"><span>● ● ●  &nbsp;bh-demo-erp · localhost</span><span>${titles[k]}</span></div>
<pre style="margin:0;padding:22px 26px;white-space:pre-wrap;font:inherit">${[...banner, ...L[k], ...footer].map(html).join("\n")}</pre></div>`;
mkdirSync("pages", { recursive: true });
for (const k of Object.keys(L)) writeFileSync(`pages/${k}.html`, page(k));
console.log("cast events", events.length, "duration", t.toFixed(1));

# bh-demo-erp

A small MCP (Model Context Protocol) server over a fictional ERP, Duskridge Hardware Ltd. It is a demo by [Bridgehand](https://bridgehand.co.uk). All data is made up, the server makes no outbound network calls and holds no secrets.

It shows one pattern: an agent reads business data, proposes a change, and a person confirms before anything is written.

## Run it

Needs Node 18 or later.

```
npm ci && npm run build
claude mcp add bh-demo-erp -e BH_ALLOW_WRITES=1 -- node dist/index.js
```

Run from this folder so the audit log lands here, or set `BH_AUDIT_LOG` to a full path.

To serve over HTTP on your own machine instead:

```
BH_ALLOW_WRITES=1 npm run start:http
```

Connect the client to `http://127.0.0.1:3333/mcp`. Do not expose it to the internet. The server only answers requests whose `Host` header is this machine (127.0.0.1, localhost, or `BH_DEMO_HOST`), which blocks DNS-rebinding attacks from web pages.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BH_ALLOW_WRITES` | unset (off) | `1` lets `prepare_sales_order` and `confirm_sales_order` work |
| `BH_DEMO_HOST` | `127.0.0.1` | HTTP bind address |
| `BH_DEMO_PORT` | `3333` | HTTP port |
| `BH_AUDIT_LOG` | `demo-audit.log` | one JSON line per tool call, confirm tokens redacted |

## Behaviour to know

- Seed dates are offsets from today, so "overdue" always looks right. `reset_demo` restores the seed and invalidates old confirm tokens.
- Confirm tokens are HMAC-signed, last 5 minutes, work once, and the key is held in memory only.
- A stock shortfall is a warning. A credit-limit breach is refused at confirm.
- Orders are only ever created as `Draft`.
- Text in customer notes is returned as data. The tests check that an instruction hidden in a note is not acted on.

## Tests

```
npm test
```

## Recording scripts

`tools/capture.mjs` drives the server over stdio and saves the real replies to `session.json`. `tools/render.mjs` turns that into an asciinema recording. Run both from `tools/` after `npm run build`.

## Licence

Apache-2.0. See `LICENSE`.

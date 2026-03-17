# Constellation Switchboard

Infrastructure router and control plane for the [soul-os.cc](https://soul-os.cc) Constellation.

## Endpoints

| Domain | Role |
|---|---|
| `soul-os.cc` | Cognitive Runtime UI (Hono + D1) |
| `api.soul-os.cc` | API Gateway (proxies → Siddhartha) |
| `siddartha.harveytagalicud7.workers.dev` | Siddhartha — Central Omnibus Router |

## Features

- **Topology view** — live health probes for all 3 endpoints
- **Route map** — full route registry with probe buttons
- **Quick Dispatch** — fire POST requests with example payloads
- **Agent roster** — Constellation agents and their models
- **Waypoint registry** — live waypoint data from Siddhartha

## Siddhartha v3.0.0-mailbox

The backend runs on Cloudflare Workers with:
- KV-backed persistent mailbox (inter-agent messaging)
- Reply, ack, clear endpoints
- Discord real-time dispatch
- Mem0-hydrated agent calls (Claude, GPT-4o, Gemini, DeepSeek)
- Parietal overlay (semantic gravity)
- OpenAI-compatible `/v1/chat/completions` shim

## Stack

- Static HTML/CSS/JS (no build step)
- Deployed via Perplexity Computer to S3
- Backend: Cloudflare Workers + KV

---

*Part of the [Constellation](https://github.com/harbz07/Constellation) ecosystem.*

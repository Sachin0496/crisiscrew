# Stage 1 prototype (archived)

`stage1-demo.html` is the CrisisCrew Stage 1 submission to The Great Agent Hackathon, archived byte-for-byte from the deployed demo.

| | |
|---|---|
| Source | https://crisiscrew-fast-demo-persistent-lau.vercel.app/ |
| Retrieved | 2026-09-22 |
| Size | 75,252 bytes, 940 lines |
| SHA-256 | `be7d4b748eac93d8a40e28bd5a90883777cb814e44feb6cbdadfc19da2d8eb0b` |

## What it is

One HTML file with inline CSS and one inline script. It makes no network calls. It has no `fetch`, XHR, WebSocket or EventSource, and it doesn't contain a single external URL.

The demo is a scripted 12-second timeline. Every number it shows is written into the page, not computed:

| Shown in the demo | Where it comes from |
|---|---|
| Correlation 89% | `q("corrVal").textContent="89%"` inside `correlate()` (line 759) |
| Root-cause confidence 91% | `q("rootConfidence").textContent="91%"` (line 790) |
| checkout-service v4.21.7, 8.6× error spike | text written into the timeline |
| ElevenLabs voice update | a transcript string swapped into the page, with no ElevenLabs call |
| Freshworks and MCP calls | label text only, since nothing is called |

## Why it's kept

It's the starting point that Stage 2 evolves from. Keeping it unchanged makes the difference easy to audit. Outside `prototype/`, every number is computed, and every integration is labeled live or sandbox. The Stage 2 web app is a new design; this page is kept only as the Stage 1 record.

Don't edit this file. To verify it:

```bash
shasum -a 256 prototype/stage1-demo.html
```

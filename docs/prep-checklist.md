# Prep checklist

What the team does before and at Stage 2 (Bangalore, 25–26 September 2026). The project is complete in sandbox mode. What's left is setup, rehearsal and submission.

## Before the event

### The laptop

- [ ] **Node.** Node 24 LTS matches CI:
  ```bash
  brew install node@24
  echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc
  ```
  Node 25, which is installed now, also runs everything; Vitest just prints an engine warning.
- [ ] **pnpm 10.** Run `corepack enable`. The repo pins the exact version in `package.json`.
- [ ] **A clean run:**
  ```bash
  git pull
  pnpm install
  pnpm test
  pnpm start
  ```
- [ ] **The embedding model is on disk.** It's already in `.models/` (23 MB) on this laptop. On a fresh clone, start the server while online and type one complaint; the model downloads once.
- [ ] **Offline check.** Turn Wi-Fi off, restart with `pnpm start`, and type a complaint you haven't used before. It should be classified within a second. (This was verified on 2026-09-23 with the network blocked.)
- [ ] **Demo tokens.** Put fixed values in `.env` for `MCP_TOKEN_PATTERN` and `MCP_TOKEN_OPERATOR` (see [demo-script.md](demo-script.md)).
- [ ] **Resources.** On the MacBook Air, run `pnpm start` for demos, not `pnpm dev`, and never both at once. The server uses about 400 MB. Close other heavy apps and keep the laptop plugged in.

### Rehearsal

- [ ] Run the [demo script](demo-script.md) end to end twice, once at 5 minutes and once at 3.
- [ ] Rehearse the answers to the likely questions at the end of the script.
- [ ] Rehearse the fallback: `pnpm replay checkout-v4.21.7` in the terminal.

### Submission material

- [ ] Paste [submission.md](submission.md) into Devpost as the updated description, and fix the "Built With" tags as it says.
- [ ] Keep the organizers' email, which allowed work before the event, where you can show it (see [compliance.md](compliance.md)).
- [ ] Decide when to make the repository public. It must be public by submission time:
  ```bash
  gh repo edit Sachin0496/crisiscrew --visibility public --accept-visibility-change-consequences
  ```
  Afterwards, open the repo page and check that the README renders: the diagram, the screenshots and the tables.

## At the event

- [ ] Re-read the rules page and any new email from the organizers.
- [ ] **Collect the API keys the organizers hand out.** Put them only in `.env`, which git ignores. Never paste them into code, docs or chat. The variables are already listed in `.env.example`:

  | Service | Variables |
  |---|---|
  | Freshdesk | `FRESHDESK_DOMAIN`, `FRESHDESK_API_KEY` |
  | Freshservice / Agent Studio | `FRESHSERVICE_DOMAIN`, `FRESHSERVICE_API_KEY` |
  | ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
  | Anthropic | `ANTHROPIC_API_KEY` |
  | Sarvam | `SARVAM_API_KEY` |
  | Dodo Payments | `DODO_PAYMENTS_API_KEY` |
  | Vobiz | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` |
  | AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

- [ ] **Keys alone switch nothing on.** The live adapters aren't written yet, and selecting one (for example `VOICE=elevenlabs`) stops the server with a clear message. If the team decides to wire one on site, the design gives the endpoints (design section 10.5). The easiest order:
  1. Razorpay status: public, no key.
  2. GitHub deployments.
  3. Freshdesk.
  4. ElevenLabs.

  After wiring any of them, update the README's status table and the Devpost tags to match.
- [ ] **A public URL, only if a judge or webhook needs one:**
  ```bash
  brew install cloudflared
  cloudflared tunnel --url http://localhost:8787
  ```
  Put the printed URL in `PUBLIC_BASE_URL`, and set `ADMIN_TOKEN` and `APPROVER_TOKEN` first, because the endpoints are open without them.
- [ ] Bring a phone hotspot as a network backup, although the demo itself needs no network.

## Before submitting

- [ ] `pnpm test` passes, and CI is green on the last commit (`gh run list --limit 1`).
- [ ] The repository is public, and the README renders.
- [ ] Devpost has the updated description, the repo link and the corrected tags.
- [ ] Every claim on the page matches what's wired. The environment box in the UI is the source of truth.

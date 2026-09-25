# Prep checklist

What the team does before and at Stage 2 (Bangalore, 25–26 September 2026). The project is complete in sandbox mode, and the Freshdesk and Freshservice adapters are wired. What's left:
- switching Freshworks on with a trial account;
- rehearsal;
- submission.

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

  | Service | Variables | Status |
  |---|---|---|
  | Freshdesk | `FRESHDESK_DOMAIN`, `FRESHDESK_API_KEY` (+ `FRESHDESK_WEBHOOK_SECRET`) | **Wired:** `TICKETS=freshdesk` switches it on |
  | Freshservice | `FRESHSERVICE_DOMAIN`, `FRESHSERVICE_API_KEY`, `FRESHSERVICE_REQUESTER_EMAIL` | **Wired:** `INCIDENTS=freshservice` switches it on |
  | ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | designed, not wired |
  | Anthropic | `ANTHROPIC_API_KEY` | designed, not wired |
  | Sarvam | `SARVAM_API_KEY` | designed, not wired |
  | Dodo Payments | `DODO_PAYMENTS_API_KEY` | designed, not wired |
  | Vobiz | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER` | **Wired:** `TELEPHONY=vobiz` switches it on (needs an https `PUBLIC_BASE_URL` and `ADMIN_TOKEN`) |
  | AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | designed, not wired |

### Switch Freshdesk on (about 20 minutes)

1. **The account.**
   - A Freshdesk trial (or the organizers' account).
   - Your API key: profile picture → **Profile settings** → **View API key**.
2. **A public URL.** The webhook and the sidebar app need one; Freshworks refuses `localhost`:
   ```bash
   brew install cloudflared
   cloudflared tunnel --url http://localhost:8787
   ```
3. **`.env`:**
   ```bash
   TICKETS=freshdesk
   FRESHDESK_DOMAIN=yourcompany.freshdesk.com
   FRESHDESK_API_KEY=...
   FRESHDESK_INGEST=webhook
   FRESHDESK_WEBHOOK_SECRET=<a long random string>
   PUBLIC_BASE_URL=https://<the tunnel's host>
   ADMIN_TOKEN=<random>
   APPROVER_TOKEN=<random>
   ```
   - Set both tokens: the tunnel makes the server public.
   - Restart with `pnpm start`. The console prints the webhook URL, and the environment box shows **Tickets: Live**.
4. **The automation rule.** In Freshdesk: **Admin → Workflows → Automations → Ticket Creation → New rule**.
   - **Name:** CrisisCrew.
   - **Condition:** every new ticket, or only portal and email tickets.
   - **Action: Trigger webhook**:
     - request type `POST`;
     - URL `https://<tunnel host>/api/webhooks/freshdesk`;
     - custom header `X-CrisisCrew-Secret: <FRESHDESK_WEBHOOK_SECRET>`;
     - encoding JSON, advanced content `{"ticket_id": {{ticket.id}}}`.
5. **No webhook?** Set `FRESHDESK_INGEST=poll` instead. CrisisCrew reads new tickets every 15 seconds and needs no rule. The sidebar app still needs the tunnel.
6. **The requesters.** The demo's customers live in the sandbox world, so create tickets as their emails. Use **New ticket**, then type the contact's email:
   - `priya.k@example.com`, `arjun.k@example.com`, `sneha.m@example.com`, `varun.n@example.com`;
   - `ritika.s@example.com`, `karan.d@example.com`, `meera.j@example.com`, `rohit.p@example.com`.

   A ticket from any other email is ingested too, but it's **not verified**: there's no payment for it in the sandbox world. Replies to `example.com` addresses go nowhere, which is intended.
7. **Rehearse:**
   - create four complaints as Priya, Arjun, Sneha and Varun (the sentences in [demo-script.md](demo-script.md) work);
   - check that the incident opens in CrisisCrew;
   - check that each Freshdesk ticket gets the private link note, the reply and the outcome note.
8. **Optional: Freshdesk's MCP server.** Set `FRESHDESK_ACTIONS=mcp` to write notes and replies through `https://<domain>/mcp` instead of REST.
   - The console says whether it connected.
   - Each call counts against the plan's MCP quota: 1,200 actions a year on Growth.
   - If it fails, go back to `rest`.
9. **The sidebar app.** Follow [integrations/freshdesk-sidebar/README.md](../integrations/freshdesk-sidebar/README.md):
   - `fdk run`, with the tunnel's host as **CrisisCrew host**;
   - then open a ticket with `?dev=true`.
10. **After it works live:** update the README's status note and table, and add the `freshdesk` tag on Devpost. See [compliance.md](compliance.md) section 8.

### Switch Freshservice on (optional, 10 minutes)

1. **`.env`:**
   ```bash
   INCIDENTS=freshservice
   FRESHSERVICE_DOMAIN=yourcompany.freshservice.com
   FRESHSERVICE_API_KEY=...
   FRESHSERVICE_REQUESTER_EMAIL=<an address that exists as a Freshservice requester>
   ```
2. **Restart.** Every CrisisCrew incident, **replays included**, now files a Freshservice incident with notes. Turn it off for rehearsals you don't want in Freshservice.
3. **Agent Studio:** if the organizers give access to the Freshservice Agent Studio MCP Gateway, register `https://<tunnel host>/mcp` with the header `Authorization: Bearer <MCP_TOKEN_OPERATOR>`. It sees the seven read tools, including `get_customer_impact` and `get_recovery_coverage`.

### Other APIs

- **Keys alone switch nothing on** for the other APIs. Selecting one (for example `VOICE=elevenlabs`) stops the server with a clear message.
- If the team decides to wire one on site, the design gives the endpoints (design section 10.5).
- Do them in order of what strengthens the recovery story. Voice for priority customers is the obvious next one.

- [ ] Bring a phone hotspot as a network backup, although the demo itself needs no network.

## Before submitting

- [ ] `pnpm test` passes, and CI is green on the last commit (`gh run list --limit 1`).
- [ ] The repository is public, and the README renders.
- [ ] Devpost has the updated description, the repo link and the corrected tags.
- [ ] Every claim on the page matches what's wired. The environment box in the UI is the source of truth.

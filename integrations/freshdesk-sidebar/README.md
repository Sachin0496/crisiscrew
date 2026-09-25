# CrisisCrew for Freshdesk: ticket sidebar

A Freshworks app (platform 3.0) for Freshdesk's ticket sidebar. On any ticket, it shows what CrisisCrew knows about that ticket's customer:
- the incident and its likely cause;
- the incident's Recovery Coverage;
- whether this customer is **confirmed** (a failed payment inside the incident window) or **not verified**;
- the evidence and each step of their recovery;
- any credit that's waiting for a human decision.

It reads `GET /api/freshdesk/tickets/:id` from your CrisisCrew server. It's read-only: decisions stay in CrisisCrew.

```
manifest.json            ticket_sidebar placement, one request template
config/iparams.json      the CrisisCrew host, asked for at install
config/requests.json     getTicketImpact: GET https://<host>/api/freshdesk/tickets/<ticket id>
app/index.html           the sidebar page
app/scripts/app.js       Freshworks client glue: ticket id → request → render
app/scripts/render.js    pure rendering; CrisisCrew's tests run it against the server's real payload
app/styles/              styles and icon
```

## Run it against a Freshdesk trial

You need:
- CrisisCrew running with `TICKETS=freshdesk` (see [the main README](../../README.md#freshworks));
- a **public HTTPS host** for it. Freshworks request templates refuse `localhost` and IP addresses. A Cloudflare quick tunnel works:
  ```bash
  cloudflared tunnel --url http://localhost:8787
  ```
- the Freshworks CLI (`fdk`), which needs Node 18. Follow Freshworks' current install instructions.

Then:
1. Run the app locally from this folder:
   ```bash
   fdk run
   ```
   When asked for **CrisisCrew host**, give the tunnel's host without `https://`, for example `abc-def.trycloudflare.com`. The CLI serves the settings page at http://localhost:10001/custom_configs if it doesn't ask.
2. Open any ticket in your Freshdesk and add `?dev=true` to its URL. The sidebar shows the CrisisCrew panel.
3. To install it for the whole helpdesk, run `fdk validate` and then `fdk pack`, and upload the zip from `dist/` as a custom app: **Admin → Apps → Build it yourself → Custom app**.

## What it shows

| The ticket is… | The sidebar says |
|---|---|
| Not seen by CrisisCrew in the current session | *Not tracked yet* |
| Seen, but in no incident (a question, or a failure no burst confirmed) | *Not part of an incident* |
| In an incident | The incident, its cause and coverage, then this customer's state, evidence and recovery, and a link to their evidence chain in the CrisisCrew console |

## Status

Written for this pivot and checked against CrisisCrew's real API payload by `apps/server/src/http/sidebar.test.ts`. It hasn't been run inside a Freshdesk account yet: that needs the team's Freshdesk trial and the `fdk` CLI. `fdk run` may ask to update `engines` in `manifest.json` to your installed Node and FDK versions; accept it.

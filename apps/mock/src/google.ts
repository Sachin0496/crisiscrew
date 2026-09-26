import { MOCK } from "@crisiscrew/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { json, logCalls } from "./freshworks";
import { iso, type Store } from "./store";

/** One paragraph of a mock Google Doc, as the viewer draws it. */
export type DocParagraph = { text: string; style: string; bullet: boolean; link?: string };

export type MockDoc = {
  id: string;
  title: string;
  text: string;
  styles: { start: number; end: number; style: string }[];
  bullets: { start: number; end: number }[];
  links: { start: number; end: number; url: string }[];
  shares: { email: string; role: string; at: string }[];
  created_at: string;
};

/** Team runbooks and postmortems in the mock Drive, found by full-text search. */
const DRIVE = [
  {
    id: "rb-gateway",
    name: "Runbook · Payment gateway timeouts",
    description: "UPI collect and 3-D Secure confirmations take 2 to 8 s at p95 (up to 12 s at bank peaks). Keep the gateway timeout at 15 s or more, and never fail an order on a timeout: mark it PENDING and let reconciliation settle it.",
    text: "payment gateway timeout timeouts upi 3-d secure confirmation pending reconciliation checkout",
  },
  {
    id: "pm-2025-11",
    name: "Postmortem PM-2025-11 · UPI orders failed while debited",
    description: "A 5 s timeout in the mobile app marked UPI orders failed after the bank had captured the money. 312 customers were charged for failed orders; fixed by raising the timeout and reconciling pending payments.",
    text: "postmortem upi timeout gateway orders failed debited captured pending reconciliation",
  },
];

/** Splits a doc into paragraphs with their styles, bullets and links (indexes start at 1, like Google Docs). */
export function paragraphs(doc: MockDoc): DocParagraph[] {
  const out: DocParagraph[] = [];
  let index = 1;
  for (const line of doc.text.split("\n")) {
    const start = index;
    const end = index + line.length + 1;
    index = end;
    if (!line && start === 1 + doc.text.length) continue;
    const style = doc.styles.find((s) => s.start <= start && s.end >= end)?.style ?? "NORMAL_TEXT";
    const bullet = doc.bullets.some((b) => b.start <= start && b.end >= end);
    const link = doc.links.find((l) => l.start >= start && l.start < end)?.url;
    out.push({ text: line, style, bullet, ...(link ? { link } : {}) });
  }
  return out.filter((p, i, all) => p.text || i < all.length - 1);
}

/** Google Docs (documents, batchUpdate) and Drive (permissions, file search), as much as the adapter uses. */
export function googleApi(store: Store, docs: MockDoc[], viewUrl: (id: string) => string): Hono {
  const app = new Hono();
  const auth: MiddlewareHandler = async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${MOCK.googleToken}`) return c.json({ error: { code: 401, message: "Request had invalid authentication credentials." } }, 401);
    await next();
  };
  app.use("/*", logCalls(store, "google"), auth);

  app.post("/v1/documents", async (c) => {
    const body = await json(c);
    const doc: MockDoc = { id: `1${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`, title: String(body?.title ?? "Untitled document"), text: "", styles: [], bullets: [], links: [], shares: [], created_at: iso() };
    docs.push(doc);
    store.touch();
    return c.json({ documentId: doc.id, title: doc.title });
  });

  app.post("/v1/documents/:spec", async (c) => {
    const [id, verb] = c.req.param("spec").split(":");
    const doc = docs.find((d) => d.id === id);
    if (!doc || verb !== "batchUpdate") return c.json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    const requests = ((await json(c))?.requests as Record<string, any>[] | undefined) ?? [];
    for (const r of requests) {
      if (r.insertText) {
        const at = Math.max(0, (r.insertText.location?.index ?? 1) - 1);
        doc.text = doc.text.slice(0, at) + String(r.insertText.text ?? "") + doc.text.slice(at);
      } else if (r.updateParagraphStyle) {
        doc.styles.push({ start: r.updateParagraphStyle.range.startIndex, end: r.updateParagraphStyle.range.endIndex, style: r.updateParagraphStyle.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT" });
      } else if (r.createParagraphBullets) {
        doc.bullets.push({ start: r.createParagraphBullets.range.startIndex, end: r.createParagraphBullets.range.endIndex });
      } else if (r.updateTextStyle?.textStyle?.link?.url) {
        doc.links.push({ start: r.updateTextStyle.range.startIndex, end: r.updateTextStyle.range.endIndex, url: r.updateTextStyle.textStyle.link.url });
      }
    }
    store.touch();
    return c.json({ documentId: doc.id, replies: requests.map(() => ({})) });
  });

  app.get("/v1/documents/:id", (c) => {
    const doc = docs.find((d) => d.id === c.req.param("id"));
    return doc ? c.json({ documentId: doc.id, title: doc.title }) : c.json({ error: { code: 404 } }, 404);
  });

  app.post("/drive/v3/files/:id/permissions", async (c) => {
    const doc = docs.find((d) => d.id === c.req.param("id"));
    if (!doc) return c.json({ error: { code: 404, message: "File not found." } }, 404);
    const body = await json(c);
    const email = String(body?.emailAddress ?? "");
    doc.shares.push({ email, role: String(body?.role ?? "reader"), at: iso() });
    if (c.req.query("sendNotificationEmail") !== "false") {
      store.notify({ to: email, app: "Google Docs", title: `CrisisCrew shared “${doc.title}”`, body: c.req.query("emailMessage") ?? "", url: viewUrl(doc.id) });
    }
    store.touch();
    return c.json({ kind: "drive#permission", id: `perm-${doc.shares.length}`, type: "user", role: body?.role, emailAddress: email });
  });

  // Only full-text search is understood: fullText contains 'a' and fullText contains 'b'.
  app.get("/drive/v3/files", (c) => {
    const terms = [...(c.req.query("q") ?? "").matchAll(/fullText contains '([^']+)'/g)].map((m) => m[1]!.toLowerCase());
    const files = DRIVE.filter((d) => terms.length > 0 && terms.every((t) => d.text.includes(t) || d.description.toLowerCase().includes(t)));
    const size = Number(c.req.query("pageSize") ?? 10) || 10;
    return c.json({ files: files.slice(0, size).map((d) => ({ id: d.id, name: d.name, description: d.description, webViewLink: viewUrl(d.id) })) });
  });

  return app;
}

/** The Slack Web API's message search, over the #payments-oncall history. */
export function slackApi(store: Store, uiOrigin: string): Hono {
  const minutesAgo = (m: number) => ((Date.now() - m * 60_000) / 1000).toFixed(6);
  const MESSAGES = [
    { username: "vikram-s", channel: "payments-oncall", minutes: 16, text: "Shipping v4.21.7: cut the gateway timeout to 1.5 s so checkout fails fast when the gateway is slow." },
    { username: "kiran-desai", channel: "payments-oncall", minutes: 15, text: "Careful with that timeout: UPI confirmations take several seconds. See the gateway runbook before we go that low." },
    { username: "meghna-p", channel: "tracking", minutes: 9, text: "Courier webhooks are lagging on tracking-service, some parcels show no updates. Looking." },
  ];
  const app = new Hono();
  app.use("/*", logCalls(store, "slack"));
  app.get("/api/search.messages", (c) => {
    if (c.req.header("authorization") !== `Bearer ${MOCK.slackToken}`) return c.json({ ok: false, error: "invalid_auth" });
    const terms = (c.req.query("query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matches = MESSAGES.filter((m) => terms.some((t) => m.text.toLowerCase().includes(t)))
      .sort((a, b) => terms.filter((t) => b.text.toLowerCase().includes(t)).length - terms.filter((t) => a.text.toLowerCase().includes(t)).length)
      .slice(0, Number(c.req.query("count") ?? 20) || 20)
      .map((m) => ({ text: m.text, username: m.username, channel: { name: m.channel }, ts: minutesAgo(m.minutes), permalink: `${uiOrigin}/#/slack` }));
    return c.json({ ok: true, query: c.req.query("query"), messages: { total: matches.length, matches } });
  });
  return app;
}

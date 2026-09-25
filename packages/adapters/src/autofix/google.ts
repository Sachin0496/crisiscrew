import type { DocBlock, DocsPort, KnowledgeHit, KnowledgePort } from "@crisiscrew/core";
import { jsonRequest } from "./http";

export type GoogleDocsOptions = {
  /** https://docs.googleapis.com, or the mock's origin. */
  docsBase: string;
  /** https://www.googleapis.com, or the mock's origin. */
  driveBase: string;
  token: string;
  /** Where a document opens: https://docs.google.com/document/d/ (the id and /edit follow), or the mock's viewer. */
  viewBase: string;
  fetch?: typeof fetch;
};

type Request = Record<string, unknown>;

/**
 * The document as one text insert plus styles. Google Docs indexes are
 * UTF-16 offsets starting at 1; every paragraph ends with a newline.
 */
export function docRequests(title: string, blocks: DocBlock[]): Request[] {
  let text = "";
  const styles: Request[] = [];
  const paragraph = (line: string, style?: string) => {
    const start = 1 + text.length;
    text += `${line}\n`;
    const range = { startIndex: start, endIndex: start + line.length + 1 };
    if (style) styles.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: style }, fields: "namedStyleType" } });
    return range;
  };
  paragraph(title, "TITLE");
  for (const block of blocks) {
    if (block.kind === "heading") paragraph(block.text, "HEADING_1");
    else if (block.kind === "subheading") paragraph(block.text, "HEADING_2");
    else if (block.kind === "paragraph") paragraph(block.text);
    else if (block.kind === "link") {
      const range = paragraph(block.text);
      styles.push({ updateTextStyle: { range: { startIndex: range.startIndex, endIndex: range.endIndex - 1 }, textStyle: { link: { url: block.url } }, fields: "link" } });
    } else if (block.kind === "bullets") {
      const first = 1 + text.length;
      for (const item of block.items) paragraph(item);
      styles.push({ createParagraphBullets: { range: { startIndex: first, endIndex: 1 + text.length }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    }
  }
  return [{ insertText: { location: { index: 1 }, text } }, ...styles];
}

/** Google Docs (create and write) and Drive (share, which emails each person). */
export function googleDocs(options: GoogleDocsOptions): DocsPort {
  const base = { token: options.token, ...(options.fetch ? { fetch: options.fetch } : {}) };
  return {
    mode: "live",
    adapter: "google-docs",
    async publish({ title, blocks, shareWith, message }) {
      const doc = await jsonRequest<{ documentId: string }>({ ...base, base: options.docsBase }, "POST", "/v1/documents", { title });
      await jsonRequest({ ...base, base: options.docsBase }, "POST", `/v1/documents/${doc.documentId}:batchUpdate`, { requests: docRequests(title, blocks) });
      for (const person of shareWith) {
        const query = new URLSearchParams({ sendNotificationEmail: "true", emailMessage: message });
        await jsonRequest({ ...base, base: options.driveBase }, "POST", `/drive/v3/files/${doc.documentId}/permissions?${query}`, { type: "user", role: person.role, emailAddress: person.email });
      }
      return { id: doc.documentId, url: `${options.viewBase}${doc.documentId}` };
    },
  };
}

export type KnowledgeOptions = {
  slack: { apiBase: string; token: string };
  drive: { apiBase: string; token: string };
  fetch?: typeof fetch;
};

/** Team knowledge: Slack message search and Google Drive full-text search, top hits of each. A source that fails is left out. */
export function teamKnowledge(options: KnowledgeOptions): KnowledgePort {
  const f = options.fetch ? { fetch: options.fetch } : {};
  return {
    mode: "live",
    adapter: "slack+drive",
    async search(query) {
      const slack = jsonRequest<{ ok: boolean; messages?: { matches?: { text: string; username?: string; channel?: { name?: string }; permalink?: string }[] } }>(
        { ...f, base: options.slack.apiBase, token: options.slack.token },
        "GET",
        `/api/search.messages?${new URLSearchParams({ query, count: "2", sort: "score" })}`,
      ).then((r) =>
        (r.messages?.matches ?? []).slice(0, 2).map<KnowledgeHit>((m) => ({ source: "slack", title: `Slack #${m.channel?.name ?? "channel"}${m.username ? ` · ${m.username}` : ""}`, snippet: m.text.slice(0, 280), ...(m.permalink ? { url: m.permalink } : {}) })),
      );
      const terms = query.split(/\s+/).filter(Boolean).map((t) => `fullText contains '${t.replace(/'/g, "")}'`).join(" and ");
      const drive = jsonRequest<{ files?: { name: string; description?: string; webViewLink?: string }[] }>(
        { ...f, base: options.drive.apiBase, token: options.drive.token },
        "GET",
        `/drive/v3/files?${new URLSearchParams({ q: terms, pageSize: "2", fields: "files(id,name,description,webViewLink)" })}`,
      ).then((r) => (r.files ?? []).map<KnowledgeHit>((d) => ({ source: "runbook", title: d.name, snippet: (d.description ?? "").slice(0, 280), ...(d.webViewLink ? { url: d.webViewLink } : {}) })));
      const settled = await Promise.allSettled([slack, drive]);
      return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    },
  };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FreshdeskWriter } from "./freshdesk";
import { textToHtml } from "./http";

type ToolInfo = { name: string; inputSchema: { properties?: Record<string, unknown> } };
type Shaped = { name: string; args(ticketId: number, html: string): Record<string, unknown> };

const ID_KEYS = ["ticket_id", "ticketId", "id"];
const BODY_KEYS = ["body", "content", "note", "message", "description"];

/**
 * Freshdesk doesn't publish its MCP tools' argument names, so they're read
 * from each tool's input schema when the adapter connects.
 */
export function shapeTool(tool: ToolInfo, privateNote: boolean): Shaped {
  const props = Object.keys(tool.inputSchema.properties ?? {});
  const idKey = ID_KEYS.find((k) => props.includes(k));
  const bodyKey = BODY_KEYS.find((k) => props.includes(k));
  if (!idKey || !bodyKey) {
    throw new Error(`Freshdesk's MCP tool ${tool.name} takes (${props.join(", ") || "nothing"}); CrisisCrew needs a ticket id and a body`);
  }
  const hasPrivate = privateNote && props.includes("private");
  return { name: tool.name, args: (ticketId, html) => ({ [idKey]: ticketId, [bodyKey]: html, ...(hasPrivate ? { private: true } : {}) }) };
}

function textOf(result: object): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? (raw as { type?: string; text?: string }[]) : [];
  return content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join(" ")
    .slice(0, 300);
}

export type FreshdeskMcpOptions = {
  /** e.g. "acme.freshdesk.com"; the server is https://<domain>/mcp. */
  domain: string;
  apiKey: string;
  fetch?: typeof fetch;
};

/**
 * Writes notes and replies through Freshdesk's official MCP server
 * (createTicketNote and replyTicket) instead of the REST API. It connects on
 * first use, over Streamable HTTP with a fallback to HTTP+SSE, and
 * reconnects after a failure. Freshdesk counts every call against the
 * plan's MCP action quota.
 */
export function freshdeskMcpWriter(options: FreshdeskMcpOptions): FreshdeskWriter & { connect(): Promise<void> } {
  const base = options.fetch ?? fetch;
  const authed: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", options.apiKey);
    return base(input, { ...init, headers });
  };
  let ready: Promise<{ client: Client; note: Shaped; reply: Shaped }> | null = null;

  const connect = () => {
    ready ??= (async () => {
      const url = new URL(`https://${options.domain}/mcp`);
      let client = new Client({ name: "crisiscrew", version: "0.2.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch: authed }));
      } catch {
        client = new Client({ name: "crisiscrew", version: "0.2.0" });
        await client.connect(new SSEClientTransport(url, { fetch: authed }));
      }
      const { tools } = await client.listTools();
      const find = (name: string) => {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new Error(`Freshdesk's MCP server has no ${name} tool`);
        return tool as ToolInfo;
      };
      return { client, note: shapeTool(find("createTicketNote"), true), reply: shapeTool(find("replyTicket"), false) };
    })().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };

  const call = async (which: "note" | "reply", ticketId: number, text: string) => {
    const tools = await connect();
    const tool = tools[which];
    const result = await tools.client.callTool({ name: tool.name, arguments: tool.args(ticketId, textToHtml(text)) });
    if (result.isError) throw new Error(`Freshdesk MCP ${tool.name} failed: ${textOf(result) || "no detail"}`);
  };

  return {
    adapter: "freshdesk-mcp",
    connect: async () => {
      await connect();
    },
    note: (ticketId, text) => call("note", ticketId, text),
    reply: (ticketId, text) => call("reply", ticketId, text),
  };
}

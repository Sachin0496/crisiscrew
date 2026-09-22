import type { Identity } from "@crisiscrew/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import type { Config } from "../config";
import type { Runtime } from "../runtime";

const INSTRUCTIONS =
  "CrisisCrew turns bursts of similar customer complaints into incidents. Every tool call goes through a policy gate: " +
  "you only see the tools your token's identity may use, and every call, allowed or refused, is written to a hash-chained audit log.";

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function identityFor(token: string, config: Config): Identity | null {
  const given = Buffer.from(token);
  for (const [identity, expected] of Object.entries(config.mcpTokens) as [Identity, string][]) {
    const e = Buffer.from(expected);
    if (given.length === e.length && timingSafeEqual(given, e)) return identity;
  }
  return null;
}

/**
 * The MCP server at /mcp (Streamable HTTP, stateless). The bearer token picks
 * the identity. Tools come from that identity's allow-list, and every call
 * goes through the same policy gate as the internal agents, so MCP clients
 * act on the same live incident the UI shows.
 */
export function mountMcp(app: Hono, deps: { runtime: Runtime; config: Config }): void {
  app.all("/mcp", async (c) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const identity = token ? identityFor(token, deps.config) : null;
    if (!identity) return c.json(rpcError(null, -32001, "Missing or unknown bearer token"), 401);
    if (c.req.method !== "POST") return c.json(rpcError(null, -32000, "This MCP server is stateless: send JSON-RPC with POST"), 405);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const gate = deps.runtime.engineNow().gate;
    const permitted = gate.permitted(identity);
    const message = body as { id?: unknown; method?: string; params?: { name?: unknown; arguments?: unknown } };

    // A call to a tool this identity may not use still goes through the gate, so the refusal is audited.
    if (!Array.isArray(body) && message.method === "tools/call" && !permitted.some((t) => t.name === message.params?.name)) {
      const refused = await gate.call(identity, String(message.params?.name ?? ""), message.params?.arguments ?? {});
      const reason = refused.ok ? "not permitted" : refused.reason;
      return c.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { content: [{ type: "text", text: `Refused by the CrisisCrew policy gate: ${reason}` }], isError: true },
      });
    }

    const server = new McpServer({ name: "crisiscrew", version: "0.1.0" }, { instructions: INSTRUCTIONS });
    const catalog = new Map(gate.catalog().map((t) => [t.name, t]));
    for (const tool of permitted) {
      const levels = catalog.get(tool.name)?.levels.map((l) => `L${l}`).join("/") ?? "";
      server.registerTool(
        tool.name,
        {
          description: `${tool.description} (authority ${levels})`,
          inputSchema: (tool.input as z.ZodObject<z.ZodRawShape>).shape,
        },
        async (args) => {
          const r = await gate.call(identity, tool.name, args);
          if (!r.ok) return { content: [{ type: "text", text: `Refused by the CrisisCrew policy gate: ${r.reason}` }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }] };
        },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: body });
  });
}

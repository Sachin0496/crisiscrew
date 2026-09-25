import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * One infrastructure MCP server CrisisCrew may ask: over Streamable HTTP
 * (url) or as a local process (command). Configured by the operator in
 * INFRA_MCP_SERVERS, never by data CrisisCrew reads.
 */
export type McpServerConfig = {
  name: string;
  kind: "kubernetes" | "cloudwatch";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Kubernetes: the namespace the services run in. */
  namespace?: string;
  /** Kubernetes: the label selector for a service's pods; {service} is replaced. Defaults to app={service}. */
  labelSelector?: string;
  timeoutMs?: number;
};

/** A tool call's text: its text content joined, or its structured content as JSON. */
export function resultText(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[]; structuredContent?: unknown };
  const text = (r.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
  return text || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "");
}

/**
 * Calls tools on one MCP server. It connects on first use and again after
 * a failure, and gives every call a deadline, so a slow or dead server
 * costs one "not checked", never a hung investigation.
 */
export class McpToolClient {
  private ready: Promise<Client> | null = null;

  constructor(
    readonly config: McpServerConfig,
    private readonly transport: () => Transport = () => defaultTransport(config),
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.connect();
    const timeout = this.config.timeoutMs ?? 3_000;
    try {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout });
      const text = resultText(result);
      if (result.isError) throw new Error(`${this.config.name} ${tool} failed: ${text.slice(0, 200) || "no detail"}`);
      return text;
    } catch (error) {
      // Drop the connection so the next call starts clean.
      this.ready = null;
      void client.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const ready = this.ready;
    this.ready = null;
    if (ready) await (await ready).close().catch(() => undefined);
  }

  private connect(): Promise<Client> {
    this.ready ??= (async () => {
      const client = new Client({ name: "crisiscrew", version: "0.2.0" });
      const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${this.config.name} did not connect in time`)), this.config.timeoutMs ?? 3_000));
      await Promise.race([client.connect(this.transport()), deadline]);
      return client;
    })().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }
}

function defaultTransport(config: McpServerConfig): Transport {
  if (config.url) return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
  if (config.command) return new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...(process.env as Record<string, string>), ...config.env }, stderr: "ignore" });
  throw new Error(`MCP server ${config.name} needs a url or a command`);
}

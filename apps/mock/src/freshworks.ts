import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Product, Store } from "./store";

/** Freshworks API-key auth: Basic base64("<key>:X"). Answers 401 the way Freshworks does. */
export function apiKeyAuth(key: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":")[0] : "";
    if (given !== key) return c.json({ code: "invalid_credentials", message: "You have to be logged in to perform this action." }, 401);
    await next();
  };
}

/** Logs every API call CrisisCrew makes, for the UI's activity feed. */
export function logCalls(store: Store, product: Product): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const url = new URL(c.req.url);
    store.record(product, "in", `${c.req.method} ${url.pathname}${url.search ? decodeURIComponent(url.search) : ""} → ${c.res.status}`, c.res.status < 400);
  };
}

export async function json(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A Freshworks validation error: 400 with the fields that failed. */
export function invalid(c: Context, errors: { field: string; message: string }[]) {
  return c.json({ description: "Validation failed", errors: errors.map((e) => ({ ...e, code: "missing_field" })) }, 400);
}

export const notFound = (c: Context) => c.json({ code: "access_denied", message: "Record not found" }, 404);

/** The redirects that turn a Freshworks record URL (…/a/tickets/42) into the mock UI's page for it. */
export function recordLinks(app: Hono, uiOrigin: string, product: "freshdesk" | "freshservice"): void {
  app.get("/a/:kind/:id", (c) => c.redirect(`${uiOrigin}/#/${product}/${c.req.param("kind")}/${c.req.param("id")}`));
}

/** JSON over HTTP with a bearer token, for the GitHub, Google and Slack adapters. Errors say what the service answered. */
export async function jsonRequest<T>(
  options: { base: string; token: string; fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> },
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.base.replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 4_000),
    });
  } catch (error) {
    throw new Error(`${method} ${url} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${method} ${url} failed with ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

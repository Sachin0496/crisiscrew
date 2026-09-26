import { serve } from "@hono/node-server";
import { MOCK, mockPorts } from "@crisiscrew/contracts";
import { existsSync } from "node:fs";
import { createMock } from "./app";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ports = mockPorts(Number(process.env.MOCK_PORT) || MOCK.defaultPort);
const crisiscrewUrl = (process.env.CRISISCREW_URL ?? `http://localhost:${Number(process.env.PORT) || 8787}`).replace(/\/+$/, "");
const uiOrigin = `http://localhost:${ports.freshdesk}`;

const mock = createMock({
  crisiscrewUrl,
  uiOrigin,
  watch: true,
  ...(process.env.ADMIN_TOKEN ? { crisiscrewAdminToken: process.env.ADMIN_TOKEN } : {}),
});

// localhost only: the mock's keys are fixed and public.
const servers = (["freshdesk", "freshservice", "vobiz", "github", "google", "slack"] as const).map((name) =>
  serve({ fetch: mock.apps[name].fetch, port: ports[name], hostname: "127.0.0.1" }),
);

console.log(
  [
    "",
    "CrisisCrew mock services are running",
    `  Demo view      ${uiOrigin}`,
    `  Freshdesk      http://localhost:${ports.freshdesk}/api/v2`,
    `  Freshservice   http://localhost:${ports.freshservice}/api/v2`,
    `  Vobiz          http://localhost:${ports.vobiz}/api/v1`,
    `  GitHub         http://localhost:${ports.github}  (acme-shop/checkout-service, a real git repo)`,
    `  Google Docs    http://localhost:${ports.google}  (Docs and Drive)`,
    `  Slack          http://localhost:${ports.slack}`,
    `  CrisisCrew     ${crisiscrewUrl} (start it with INTEGRATIONS=mock, e.g. \`pnpm start:mock\`)`,
    "",
  ].join("\n"),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    mock.stop();
    for (const server of servers) server.close();
    process.exit(0);
  });
}

/**
 * Mock Freshworks and Vobiz (apps/mock): one local process that answers the
 * same REST APIs as Freshdesk, Freshservice and Vobiz, on three ports. With
 * INTEGRATIONS=mock the server's real adapters talk to it instead of the
 * real services. The keys and secrets are fixed: the mock only listens on
 * localhost, and a fixed value keeps both processes in step with no setup.
 */
export const MOCK = {
  /** The Freshdesk API and the mock's web UI. Freshservice is port + 1, Vobiz port + 2. */
  defaultPort: 8788,
  freshdeskApiKey: "mock-freshdesk-key",
  freshserviceApiKey: "mock-freshservice-key",
  /** The X-CrisisCrew-Secret the mock sends with its Freshdesk and Freshservice webhooks. */
  webhookSecret: "mock-webhook-secret",
  requesterEmail: "crisiscrew@mock.freshservice.local",
  oncallScheduleId: 1,
  vobizAuthId: "MOCKVOBIZ",
  vobizAuthToken: "mock-vobiz-token",
  vobizFrom: "+918065550100",
  githubToken: "mock-github-token",
  googleToken: "mock-google-token",
  slackToken: "mock-slack-token",
  /** The repository the mock GitHub hosts for each service. */
  repos: { "checkout-service": "acme-shop/checkout-service" } as Record<string, string>,
} as const;

/** Freshdesk and the cockpit on the first port, then Freshservice, Vobiz, GitHub, Google (Docs and Drive) and Slack. */
export type MockPorts = { freshdesk: number; freshservice: number; vobiz: number; github: number; google: number; slack: number };

export function mockPorts(base: number = MOCK.defaultPort): MockPorts {
  return { freshdesk: base, freshservice: base + 1, vobiz: base + 2, github: base + 3, google: base + 4, slack: base + 5 };
}

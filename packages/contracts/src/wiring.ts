import { z } from "zod";

export type PortName =
  | "tickets"
  | "incidents"
  | "deployments"
  | "payments"
  | "metrics"
  | "orders"
  | "voice"
  | "telephony"
  | "oncall"
  | "alerts"
  | "infra"
  | "llm"
  | "embeddings"
  | "credits"
  | "translate"
  | "classifier"
  | "guard"
  | "tracing";

export type PortMode = "sandbox" | "live" | "off";

export type WiringPort = {
  port: PortName;
  mode: PortMode;
  adapter: string;
  detail: string;
  /** Live adapters that are wired and can be switched on with keys. */
  available: string[];
  /** Live adapters that are designed but not wired yet. */
  planned: string[];
  /** The variable that switches this port. */
  env: string;
};

export type WiringReport = { ports: WiringPort[]; liveCount: number };

export const DecisionBody = z
  .object({
    decision: z.enum(["approve", "modify", "reject"]),
    amountInr: z.number().positive().optional(),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((body) => body.decision !== "modify" || body.amountInr !== undefined, {
    message: "amountInr is required when the decision is modify",
    path: ["amountInr"],
  });
export type DecisionBody = z.infer<typeof DecisionBody>;

export const ReplayBody = z
  .object({
    scenario: z.string().min(1),
    speed: z.number().min(0.25).max(500).optional(),
  })
  .strict();
export type ReplayBody = z.infer<typeof ReplayBody>;

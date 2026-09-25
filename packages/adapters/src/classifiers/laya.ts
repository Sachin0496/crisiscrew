import type { Surface, TicketType } from "@crisiscrew/contracts";
import type { ClassifierVerdict, TicketClassifier } from "@crisiscrew/core";
import { z } from "zod";

/**
 * Laya (github.com/NandhaKishorM/laya, Apache 2.0): a non-generative
 * "System 1" decision model. It takes a state and typed questions and
 * returns labels with probabilities in one forward pass, so it can't
 * hallucinate an action. It speaks one wire protocol, POST /v1/systemone,
 * whether self-hosted (`pip install "laya[serve]"; laya-serve`, port 8000)
 * or hosted by Laya Studio (https://api.laya.studio, bearer key).
 *
 * CrisisCrew asks it two bounded questions per ticket: is this a failure
 * report, a question or a request, and which product area is it about.
 * The answers only feed the detection gates; the gates, not Laya, decide
 * whether an incident opens, and nothing Laya says can call a tool.
 */

export const LAYA_QUESTIONS = {
  ticket_type: {
    type: "choice",
    instructions: "What is the customer doing in this support ticket?",
    criteria: {
      failure: "Reports that something is broken, failing, stuck, declined or not working, or that money was taken but the order didn't go through.",
      question: "Asks how something works, whether an option is available, or about a policy. Nothing is reported broken.",
      request: "Asks for a change, cancellation, refund or other action, without reporting that something failed.",
    },
  },
  product_area: {
    type: "choice",
    instructions: "Which part of an online store is this ticket about?",
    criteria: {
      checkout_payments: "Paying for an order: checkout, card, UPI, netbanking or wallet payments, a payment declined, stuck or debited.",
      login_account: "Signing in: OTP, password, account access or a locked account.",
      delivery_orders: "Orders after purchase: shipping, delivery, tracking, wrong or missing items.",
      refunds_billing: "Money after purchase: refunds, invoices, double charges, subscriptions.",
      app_performance: "The app or website itself: crashing, freezing, slow or not loading.",
      other: "Anything else.",
    },
  },
} as const;

const TYPES = Object.keys(LAYA_QUESTIONS.ticket_type.criteria) as TicketType[];
const AREAS = Object.keys(LAYA_QUESTIONS.product_area.criteria) as Surface[];

const Answer = z.object({
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

/** The part of Laya's response CrisisCrew reads. Anything else in it is ignored. */
const LayaResponse = z.object({
  answers: z.object({ ticket_type: Answer, product_area: Answer }),
  routing: z.object({ model: z.string().optional() }).partial().optional(),
  model: z.string().optional(),
});

export class LayaError extends Error {
  override name = "LayaError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type LayaOptions = {
  /** http://localhost:8000 for laya-serve, or https://api.laya.studio. */
  baseUrl: string;
  /** Bearer key: LAYA_API_KEY on a self-hosted server, lsk_live_… on Laya Studio. */
  apiKey?: string;
  /** Pin a checkpoint ("english", "multilingual", "typed-decisions"); unset lets Laya's router pick. */
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** The probability of the chosen label; Laya's own `confidence` is an entropy measure, so it's the fallback. */
function probabilityOf(answer: z.infer<typeof Answer>): number {
  return answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0;
}

function pick<T extends string>(answer: z.infer<typeof Answer>, allowed: readonly T[], question: string): { label: T; confidence: number; probabilities: Partial<Record<T, number>> } {
  // Output validation: a label outside the question's criteria is refused, never mapped or guessed.
  if (!allowed.includes(answer.choice as T)) throw new LayaError(200, `Laya answered "${answer.choice}" to ${question}, which isn't one of ${allowed.join(", ")}`);
  const probabilities = Object.fromEntries(allowed.map((k) => [k, answer.probabilities?.[k] ?? 0])) as Partial<Record<T, number>>;
  return { label: answer.choice as T, confidence: probabilityOf(answer), probabilities };
}

export class LayaClassifier implements TicketClassifier {
  readonly mode = "live" as const;
  readonly adapter = "laya";
  private readonly base: string;

  constructor(private readonly options: LayaOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
  }

  async classify(text: string): Promise<ClassifierVerdict> {
    const started = performance.now();
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.base}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ state: { body: text }, questions: LAYA_QUESTIONS, ...(this.options.model ? { model: this.options.model } : {}) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new LayaError(0, `Laya at ${this.base} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new LayaError(res.status, `Laya at ${this.base} answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const parsed = LayaResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LayaError(res.status, `Laya's answer didn't have the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const { answers } = parsed.data;
    const model = parsed.data.routing?.model ?? parsed.data.model;
    return {
      source: "laya",
      ...(model ? { model } : {}),
      ticketType: pick(answers.ticket_type, TYPES, "ticket_type"),
      surface: pick(answers.product_area, AREAS, "product_area"),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

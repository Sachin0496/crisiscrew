import type { Surface, TicketType } from "@crisiscrew/contracts";
import type { ClassifierVerdict, TicketClassifier } from "@crisiscrew/core";

/**
 * A stand-in for Laya (CLASSIFIER=laya-sim) for machines that can't run the
 * 1.7 GB checkpoint. It answers Laya's same two bounded questions (see
 * LAYA_QUESTIONS), failure/question/request and the product area, from
 * keyword evidence, and reports honest confidence: with little evidence it
 * says so, and the Pattern Agent keeps its built-in answer. Its verdicts are
 * labeled model "simulated" everywhere they show.
 */

type Rule<T extends string> = { label: T; test: RegExp; weight: number };

const TYPE_RULES: Rule<TicketType>[] = [
  { label: "failure", weight: 3, test: /\b(fail(s|ed|ing)?|declin(e|ed|es)|reject(ed)?|error|not working|isn'?t working|doesn'?t work|won'?t|stuck|loading forever|goes blank|blank|crash(es|ed|ing)?|broken)\b/ },
  { label: "failure", weight: 2, test: /\b(no update|hasn'?t arrived|never arrived|not (arrived|received|delivered)|missing)\b/ },
  { label: "failure", weight: 2, test: /\b(deducted|debited|debit|charged|money (got|was) taken|can'?t (complete|pay|log ?in|sign ?in)|couldn'?t|unable to|not placed|still fails)\b/ },
  { label: "question", weight: 2, test: /^(how|can|is|are|where|what|when|why|do|does|will|which)\s/ },
  { label: "question", weight: 1, test: /\?\s*$/ },
  { label: "request", weight: 2, test: /\b(please (cancel|change|update|refund)|i want to|i'?d like to|cancel my|change my|update my)\b/ },
];

const AREA_RULES: Rule<Surface>[] = [
  { label: "checkout_payments", weight: 3, test: /\b(checkout|payment|pay|paid|upi|card|netbanking|wallet|bank otp|transaction)\b/ },
  { label: "checkout_payments", weight: 2, test: /\b(deducted|debited|debit|charged|money)\b/ },
  { label: "login_account", weight: 3, test: /\b(log ?in|sign ?in|password|account (locked|access)|locked out)\b/ },
  { label: "login_account", weight: 1, test: /\botp\b/ },
  { label: "delivery_orders", weight: 3, test: /\b(deliver(y|ed)?|parcel|package|track(ing)?|shipping|courier|arriv(e|ed)|delivery address|cash on delivery)\b/ },
  { label: "refunds_billing", weight: 3, test: /\b(refund|invoice|subscription|double charge|charged twice|coupon)\b/ },
  { label: "app_performance", weight: 3, test: /\b(app|website|site)\b.*\b(slow|freez(es|ing)|crash(es|ing)?|not loading|down)\b/ },
];

function score<T extends string>(text: string, rules: Rule<T>[], labels: readonly T[], fallback: T) {
  const totals = new Map<T, number>(labels.map((l) => [l, 0]));
  for (const rule of rules) if (rule.test.test(text)) totals.set(rule.label, (totals.get(rule.label) ?? 0) + rule.weight);
  // A softmax over the evidence, with the fallback holding one point so no evidence means an unsure answer.
  totals.set(fallback, (totals.get(fallback) ?? 0) + 1);
  const exp = labels.map((l) => Math.exp(totals.get(l)!));
  const sum = exp.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(labels.map((l, i) => [l, Math.round((exp[i]! / sum) * 1000) / 1000])) as Record<T, number>;
  const label = labels.reduce((best, l) => (probabilities[l] > probabilities[best] ? l : best), labels[0]!);
  return { label, confidence: probabilities[label], probabilities };
}

const TYPES = ["failure", "question", "request"] as const satisfies readonly TicketType[];
const AREAS = ["checkout_payments", "login_account", "delivery_orders", "refunds_billing", "app_performance", "other"] as const satisfies readonly Surface[];

export function simulatedLaya(): TicketClassifier {
  return {
    mode: "live",
    adapter: "laya-sim",
    async classify(text: string): Promise<ClassifierVerdict> {
      const started = performance.now();
      const lower = text.toLowerCase().replace(/[’‘]/g, "'").trim();
      const ticketType = score(lower, TYPE_RULES, TYPES, "request");
      // A failure with money taken outranks a question-shaped sentence ("Why did my payment fail?").
      if (ticketType.label === "question" && ticketType.probabilities.failure > 0.2 && /\bfail|declin|deduct|debit/.test(lower)) {
        ticketType.label = "failure";
        ticketType.confidence = ticketType.probabilities.failure;
      }
      const surface = score(lower, AREA_RULES, AREAS, "other");
      return {
        source: "laya",
        model: "simulated",
        ticketType,
        surface,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      };
    },
  };
}

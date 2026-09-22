import type { Surface } from "@crisiscrew/contracts";

/**
 * Short example sentences that define each product surface and the
 * difference between "something is broken" and "I have a question".
 * Tickets are compared with these in embedding space; there are no keyword
 * lists, so a complaint is classified by meaning, whatever its wording.
 */
export type Prototypes = {
  surfaces: Record<Exclude<Surface, "other">, string[]>;
  failure: string[];
  question: string[];
};

export const DEFAULT_PROTOTYPES: Prototypes = {
  surfaces: {
    checkout_payments: [
      "The checkout page is stuck and my payment will not go through.",
      "My payment failed while I was placing the order.",
      "UPI or card payment was declined at checkout.",
      "Money was debited from my bank account but the order was not placed.",
      "I cannot complete my purchase because the payment step keeps failing.",
    ],
    login_account: [
      "I cannot log in to my account.",
      "The OTP for login never arrives.",
      "The password reset link does not work.",
      "My account is locked and I cannot sign in.",
    ],
    delivery_orders: [
      "My order has not been delivered yet.",
      "The delivery is late and tracking has no update.",
      "I received the wrong item in my package.",
      "Where is my parcel? It was supposed to arrive yesterday.",
    ],
    refunds_billing: [
      "My refund has not been credited yet.",
      "I was charged twice for my subscription.",
      "I want a refund for the item I returned.",
      "There is a wrong charge on my invoice.",
    ],
    app_performance: [
      "The app keeps crashing when I open it.",
      "The website is very slow to load.",
      "The app freezes and shows a blank screen.",
      "Pages take forever to load and then time out.",
    ],
  },
  failure: [
    "It is not working.",
    "The payment failed.",
    "I got an error and could not finish.",
    "It keeps loading and never completes.",
    "Money was deducted but nothing happened.",
    "It was rejected even though everything is correct.",
    "I tried several times and it keeps failing.",
  ],
  question: [
    "How do I do this?",
    "Can I use this option?",
    "What is your policy on this?",
    "Is it possible to change this?",
    "Could you tell me whether this is available?",
    "Please explain how this works.",
  ],
};

export function prototypeTexts(p: Prototypes): string[] {
  return [...Object.values(p.surfaces).flat(), ...p.failure, ...p.question];
}

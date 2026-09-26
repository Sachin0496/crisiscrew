export type PaymentMethod = "upi" | "card" | "netbanking";
export type PaymentRequest = { orderId: string; amountInr: number; method: PaymentMethod };
export type GatewayResult = { status: "captured" | "declined"; paymentId: string };

/** The payment gateway's client: authorizes and captures one payment. */
export interface Gateway {
  authorize(request: PaymentRequest): Promise<GatewayResult>;
}

/** The gateway didn't answer in time. The payment may still have been captured. */
export class GatewayTimeout extends Error {
  constructor(orderId: string, timeoutMs: number) {
    super(`gateway did not confirm order ${orderId} within ${timeoutMs} ms`);
    this.name = "GatewayTimeout";
  }
}

/** Asks the gateway to authorize a payment, giving up after timeoutMs. */
export async function authorize(gateway: Gateway, request: PaymentRequest, timeoutMs: number): Promise<GatewayResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayTimeout(request.orderId, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([gateway.authorize(request), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

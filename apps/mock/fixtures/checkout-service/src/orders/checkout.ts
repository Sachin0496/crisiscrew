import { GATEWAY_TIMEOUT_MS } from "../config.ts";
import { authorize, type Gateway, type PaymentRequest } from "../payments/gateway.ts";

export type OrderStatus = "PAID" | "FAILED" | "PENDING";
export type Order = { id: string; status: OrderStatus; paymentId?: string; reason?: string };

/** Takes payment for an order and records how it went. */
export async function placeOrder(gateway: Gateway, request: PaymentRequest, timeoutMs = GATEWAY_TIMEOUT_MS): Promise<Order> {
  try {
    const result = await authorize(gateway, request, timeoutMs);
    if (result.status === "declined") return { id: request.orderId, status: "FAILED", reason: "declined by the bank" };
    return { id: request.orderId, status: "PAID", paymentId: result.paymentId };
  } catch (error) {
    return { id: request.orderId, status: "FAILED", reason: error instanceof Error ? error.message : String(error) };
  }
}

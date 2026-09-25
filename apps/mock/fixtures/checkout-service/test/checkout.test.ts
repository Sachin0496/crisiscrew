import assert from "node:assert/strict";
import { test } from "node:test";
import { placeOrder } from "../src/orders/checkout.ts";
import type { Gateway } from "../src/payments/gateway.ts";

const gateway = (delayMs: number, status: "captured" | "declined" = "captured"): Gateway => ({
  authorize: (request) => new Promise((resolve) => setTimeout(() => resolve({ status, paymentId: `pay_${request.orderId}` }), delayMs)),
});

test("a captured payment marks the order paid", async () => {
  const order = await placeOrder(gateway(5), { orderId: "o1", amountInr: 649, method: "card" });
  assert.equal(order.status, "PAID");
  assert.equal(order.paymentId, "pay_o1");
});

test("a declined card fails the order", async () => {
  const order = await placeOrder(gateway(5, "declined"), { orderId: "o2", amountInr: 2199, method: "card" });
  assert.equal(order.status, "FAILED");
});

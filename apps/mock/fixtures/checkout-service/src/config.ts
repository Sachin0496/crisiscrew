/**
 * How long checkout waits for the payment gateway to confirm a payment.
 * UPI and 3-D Secure confirmations routinely take 2 to 8 seconds.
 */
export const GATEWAY_TIMEOUT_MS = 15_000;

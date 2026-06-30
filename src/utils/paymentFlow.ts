/** Payment Forwarded First — Advanced Payment flow. */
export function isPffPaymentMethod(paymentMethod: string | null | undefined): boolean {
  const normalized = String(paymentMethod ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    normalized === "pff" ||
    normalized === "payment_forwarded_first" ||
    normalized === "advanced_payment" ||
    normalized === "advanced_payment_flow"
  );
}

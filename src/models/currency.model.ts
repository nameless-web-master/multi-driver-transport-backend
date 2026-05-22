/**
 * Curated ISO 4217 codes covering the major reserve currencies, every G20
 * economy, and the most common trade-hub / shipping currencies. Add new
 * codes here as needed — the database CHECK constraint and the frontend
 * dropdown both derive from this single list.
 */
export const CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CNY",
  "AUD", "CAD", "CHF", "HKD", "SGD",
  "NZD", "KRW", "INR", "MXN", "BRL",
  "RUB", "ZAR", "TRY", "SEK", "NOK",
  "DKK", "PLN", "THB", "IDR", "MYR",
  "PHP", "VND", "AED", "SAR", "ILS",
  "EGP", "NGN", "ARS", "CLP", "COP",
  "CZK", "HUF", "RON", "UAH", "TWD",
  "PKR", "BDT", "LKR", "KES", "MAD",
  "QAR", "KWD", "BHD", "OMR",
] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "USD";

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export function normalizeCurrency(value: unknown): Currency {
  if (typeof value !== "string") return DEFAULT_CURRENCY;
  const upper = value.trim().toUpperCase();
  return isCurrency(upper) ? upper : DEFAULT_CURRENCY;
}

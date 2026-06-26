export class ExternalQuoteError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface ExternalQuoteRequest {
  transport_method: string;
  segment_index: number;
  segment_cost_id: number;
  order_id: number;
  from: { lat: number | null; lng: number | null; label: string };
  to: { lat: number | null; lng: number | null; label: string };
  weight_lbs: number | null;
  package_type: string | null;
  package_factor: number | null;
  dimensions_in: {
    length: number | null;
    width: number | null;
    height: number | null;
  };
  currency: string;
}

export interface ExternalQuoteResponse {
  quoted_cost: number;
  currency?: string;
}

export function isExternalQuoteConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_QUOTE_WEBHOOK_URL?.trim());
}

function parseQuotedCost(body: unknown): ExternalQuoteResponse {
  if (body == null || typeof body !== "object") {
    throw new ExternalQuoteError("Quote API returned an invalid response", 502);
  }
  const record = body as Record<string, unknown>;
  const cost = Number(record.quoted_cost);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new ExternalQuoteError(
      "Quote API response missing valid quoted_cost",
      502,
    );
  }
  const currency =
    typeof record.currency === "string" && record.currency.trim()
      ? record.currency.trim()
      : undefined;
  return { quoted_cost: cost, currency };
}

export async function fetchExternalQuote(
  payload: ExternalQuoteRequest,
): Promise<ExternalQuoteResponse> {
  const url = process.env.EXTERNAL_QUOTE_WEBHOOK_URL?.trim();
  if (!url) {
    throw new ExternalQuoteError(
      "External quote webhook is not configured (EXTERNAL_QUOTE_WEBHOOK_URL)",
      503,
    );
  }

  const timeoutMs = Number(process.env.EXTERNAL_QUOTE_TIMEOUT_MS ?? 15000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const apiKey = process.env.EXTERNAL_QUOTE_API_KEY?.trim();
  const authHeader = (
    process.env.EXTERNAL_QUOTE_AUTH_HEADER ?? "Authorization"
  ).trim();
  if (apiKey) {
    if (authHeader.toLowerCase() === "authorization") {
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      headers[authHeader] = apiKey;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new ExternalQuoteError("Quote API returned non-JSON response", 502);
    }

    if (!res.ok) {
      const message =
        body != null &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).error === "string"
          ? String((body as Record<string, unknown>).error)
          : `Quote API returned HTTP ${res.status}`;
      throw new ExternalQuoteError(message, res.status >= 500 ? 502 : 400);
    }

    return parseQuotedCost(body);
  } catch (err) {
    if (err instanceof ExternalQuoteError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ExternalQuoteError("Quote API request timed out", 504);
    }
    const message =
      err instanceof Error ? err.message : "Quote API request failed";
    throw new ExternalQuoteError(message, 502);
  } finally {
    clearTimeout(timer);
  }
}

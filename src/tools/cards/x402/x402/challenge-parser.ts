import { X402ChallengeError } from "./errors.js";
import {
  type HeaderBag,
  type PaymentRequired,
  PaymentRequiredSchema,
  type X402HeaderMode,
} from "./types.js";

const HEADER_PAYMENT_REQUIRED_V2 = "PAYMENT-REQUIRED";
const HEADER_PAYMENT_REQUIRED_V1 = "X-PAYMENT";

function getHeader(headers: HeaderBag, key: string): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(key);
    return value ?? undefined;
  }

  const target = key.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === target && typeof headerValue === "string") {
      return headerValue;
    }
  }

  return undefined;
}

function decodeBase64ToUtf8(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    throw new X402ChallengeError("Invalid base64 payment challenge header");
  }
}

function parseChallengeJson(value: string): PaymentRequired {
  try {
    const parsed = JSON.parse(value);
    return PaymentRequiredSchema.parse(parsed);
  } catch {
    throw new X402ChallengeError("Invalid PAYMENT-REQUIRED payload");
  }
}

export interface ParsedX402Challenge {
  readonly headerMode: X402HeaderMode;
  readonly headerName: string;
  readonly challenge: PaymentRequired;
}

export function parsePaymentRequired(headers: HeaderBag): ParsedX402Challenge {
  const v2 = getHeader(headers, HEADER_PAYMENT_REQUIRED_V2);
  if (v2) {
    const decoded = decodeBase64ToUtf8(v2);
    return {
      headerMode: "v2",
      headerName: HEADER_PAYMENT_REQUIRED_V2,
      challenge: parseChallengeJson(decoded),
    };
  }

  const v1 = getHeader(headers, HEADER_PAYMENT_REQUIRED_V1);
  if (v1) {
    const decoded = decodeBase64ToUtf8(v1);
    return {
      headerMode: "v1",
      headerName: HEADER_PAYMENT_REQUIRED_V1,
      challenge: parseChallengeJson(decoded),
    };
  }

  throw new X402ChallengeError("Missing payment challenge header");
}

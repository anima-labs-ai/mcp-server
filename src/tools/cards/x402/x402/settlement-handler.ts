import { X402SettlementError } from "./errors.js";
import {
  type HeaderBag,
  type SettleResponse,
  SettleResponseSchema,
  type X402HeaderMode,
} from "./types.js";

const HEADER_SETTLEMENT_V2 = "PAYMENT-RESPONSE";
const HEADER_SETTLEMENT_V1 = "X-PAYMENT-RESPONSE";

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

function decodeAndParseSettlement(raw: string): SettleResponse {
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return SettleResponseSchema.parse(parsed);
  } catch {
    throw new X402SettlementError("Invalid settlement response header payload");
  }
}

export interface ParsedSettlement {
  readonly headerMode: X402HeaderMode;
  readonly headerName: string;
  readonly settlement: SettleResponse;
}

export function parseSettlementResponse(headers: HeaderBag): ParsedSettlement {
  const v2 = getHeader(headers, HEADER_SETTLEMENT_V2);
  if (v2) {
    return {
      headerMode: "v2",
      headerName: HEADER_SETTLEMENT_V2,
      settlement: decodeAndParseSettlement(v2),
    };
  }

  const v1 = getHeader(headers, HEADER_SETTLEMENT_V1);
  if (v1) {
    return {
      headerMode: "v1",
      headerName: HEADER_SETTLEMENT_V1,
      settlement: decodeAndParseSettlement(v1),
    };
  }

  throw new X402SettlementError("Missing settlement response header");
}

export function assertSettlementSuccess(settlement: SettleResponse): void {
  if (!settlement.success) {
    throw new X402SettlementError(settlement.errorReason ?? "x402 settlement failed");
  }
}

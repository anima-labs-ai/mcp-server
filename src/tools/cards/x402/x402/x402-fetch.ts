import { X402BudgetGuard } from "./budget-guard.js";
import { parsePaymentRequired } from "./challenge-parser.js";
import { X402ChallengeError, X402UnsupportedSchemeError } from "./errors.js";
import {
  buildPaymentPayload,
  encodePaymentPayload,
  SandboxPaymentSigner,
  selectAcceptedRequirement,
} from "./payment-builder.js";
import { assertSettlementSuccess, parseSettlementResponse } from "./settlement-handler.js";
import {
  type PaymentSigner,
  type SettleResponse,
  type X402Config,
  X402ConfigSchema,
} from "./types.js";

const HEADER_SIGNATURE_V2 = "PAYMENT-SIGNATURE";
const HEADER_SIGNATURE_V1 = "X-PAYMENT";

export interface X402FetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly signer?: PaymentSigner;
  readonly config?: Partial<X402Config>;
  readonly budgetGuard?: X402BudgetGuard;
}

export interface X402SettlementMeta {
  readonly settlement: SettleResponse;
  readonly headerMode: "v1" | "v2";
}

export interface X402FetchResult {
  readonly response: Response;
  readonly settlement?: X402SettlementMeta;
  readonly paid: boolean;
  readonly sandbox: boolean;
  readonly selectedScheme?: string;
}

function mergeHeaders(base?: Record<string, string>): Headers {
  const headers = new Headers();
  if (!base) {
    return headers;
  }
  for (const [key, value] of Object.entries(base)) {
    headers.set(key, value);
  }
  return headers;
}

export async function x402Fetch(url: string, options: X402FetchOptions = {}): Promise<X402FetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const method = options.method ?? "GET";
  const parsedConfig = X402ConfigSchema.parse(options.config ?? {});
  const signer =
    options.signer ?? (parsedConfig.sandbox ? new SandboxPaymentSigner() : undefined);
  if (!signer) {
    throw new X402ChallengeError("x402 signer is required when sandbox mode is disabled");
  }
  const budgetGuard =
    options.budgetGuard ??
    new X402BudgetGuard({
      maxPerRequestAtomic: parsedConfig.maxPerRequestAtomic,
      maxSessionAtomic: parsedConfig.maxSessionAtomic,
    });

  const requestHeaders = mergeHeaders(options.headers);
  const initialResponse = await fetcher(url, {
    method,
    headers: requestHeaders,
    body: options.body,
  });

  if (initialResponse.status !== 402) {
    return {
      response: initialResponse,
      paid: false,
      sandbox: parsedConfig.sandbox,
    };
  }

  const parsedChallenge = parsePaymentRequired(initialResponse.headers);
  const accepted = selectAcceptedRequirement(parsedChallenge.challenge, parsedConfig.supportedSchemes);
  if (!accepted) {
    throw new X402UnsupportedSchemeError("No acceptable x402 payment scheme found");
  }

  const amountAtomic = BigInt(accepted.amount);
  budgetGuard.check(amountAtomic);

  const payload = await buildPaymentPayload({
    challenge: parsedChallenge.challenge,
    accepted,
    signer,
    request: {
      method,
      url,
      headers: Object.fromEntries(requestHeaders.entries()),
      body: options.body,
    },
  });
  const encoded = encodePaymentPayload(payload);

  const retryHeaders = mergeHeaders(options.headers);
  if (parsedChallenge.headerMode === "v2") {
    retryHeaders.set(HEADER_SIGNATURE_V2, encoded);
  } else {
    retryHeaders.set(HEADER_SIGNATURE_V1, encoded);
  }

  const finalResponse = await fetcher(url, {
    method,
    headers: retryHeaders,
    body: options.body,
  });

  const hasSettlementHeader =
    finalResponse.headers.get("PAYMENT-RESPONSE") !== null ||
    finalResponse.headers.get("X-PAYMENT-RESPONSE") !== null;

  if (!hasSettlementHeader) {
    throw new X402ChallengeError("Missing settlement header after x402 payment attempt");
  }

  const settlement = parseSettlementResponse(finalResponse.headers);
  assertSettlementSuccess(settlement.settlement);
  budgetGuard.record(amountAtomic);

  return {
    response: finalResponse,
    paid: true,
    sandbox: parsedConfig.sandbox,
    selectedScheme: accepted.scheme,
    settlement: {
      settlement: settlement.settlement,
      headerMode: settlement.headerMode,
    },
  };
}

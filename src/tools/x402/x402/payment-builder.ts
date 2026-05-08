import { X402UnsupportedSchemeError } from "./errors.js";
import {
  type PaymentPayload,
  PaymentPayloadSchema,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentSigner,
  type PaymentSigningInput,
} from "./types.js";

export class SandboxPaymentSigner implements PaymentSigner {
  public async signPayment(input: PaymentSigningInput): Promise<Record<string, unknown>> {
    return {
      mode: "sandbox",
      scheme: input.accepted.scheme,
      network: input.accepted.network,
      amount: input.accepted.amount,
      payTo: input.accepted.payTo,
      authorization: "sandbox-authorized",
      signedAt: new Date().toISOString(),
    };
  }
}

export function selectAcceptedRequirement(
  challenge: PaymentRequired,
  supportedSchemes: readonly string[]
): PaymentRequirements {
  const candidate = challenge.accepts.find((option) => supportedSchemes.includes(option.scheme));
  if (!candidate) {
    throw new X402UnsupportedSchemeError("No supported payment scheme offered by x402 challenge");
  }
  return candidate;
}

export interface BuildPaymentPayloadInput {
  readonly challenge: PaymentRequired;
  readonly accepted: PaymentRequirements;
  readonly signer: PaymentSigner;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  };
}

export async function buildPaymentPayload(input: BuildPaymentPayloadInput): Promise<PaymentPayload> {
  const signedPayload = await input.signer.signPayment({
    challenge: input.challenge,
    accepted: input.accepted,
    request: input.request,
    resource: input.challenge.resource,
  });

  return PaymentPayloadSchema.parse({
    x402Version: 2,
    resource: input.challenge.resource,
    accepted: input.accepted,
    payload: signedPayload,
  });
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64");
}

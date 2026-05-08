import { z } from "zod";

export const ResourceInfoSchema = z.object({
  url: z.string().min(1),
  description: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.unknown()).default({}),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.record(z.unknown()),
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string().optional(),
  network: z.string().optional(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

export const X402ConfigSchema = z.object({
  sandbox: z.boolean().default(true),
  supportedSchemes: z.array(z.string().min(1)).default(["exact"]),
  maxPerRequestAtomic: z.bigint().nonnegative().optional(),
  maxSessionAtomic: z.bigint().nonnegative().optional(),
});
export type X402Config = z.infer<typeof X402ConfigSchema>;

export interface PaymentRequestContext {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface PaymentSigningInput {
  readonly challenge: PaymentRequired;
  readonly accepted: PaymentRequirements;
  readonly request: PaymentRequestContext;
  readonly resource?: ResourceInfo;
}

export interface PaymentSigner {
  signPayment(input: PaymentSigningInput): Promise<Record<string, unknown>>;
}

export type HeaderBag = Headers | Record<string, string | undefined>;

export type X402HeaderMode = "v1" | "v2";

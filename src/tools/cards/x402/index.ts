import { x402Fetch } from "./x402/x402-fetch.js";
import { z } from "zod";

import { toolSuccess, withErrorHandling, type ToolRegistrationOptions } from "../../../shared/index.js";

const x402FetchSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1).optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  budget_limit_cents: z.number().int().positive().optional(),
  sandbox: z.boolean().optional(),
});

export interface X402ToolDependencies {
  readonly x402Fetcher?: typeof x402Fetch;
}

export function registerX402Tools(
  options: ToolRegistrationOptions,
  dependencies: X402ToolDependencies = {}
): void {
  const { server } = options;
  const x402Fetcher = dependencies.x402Fetcher ?? x402Fetch;

  server.registerTool(
    "x402_fetch",
    {
      description: "Fetch an x402-protected resource using challenge-response settlement flow.",
      inputSchema: x402FetchSchema.shape,
    },
    withErrorHandling(async (args) => {
      const budgetAtomic =
        typeof args.budget_limit_cents === "number"
          ? BigInt(args.budget_limit_cents) * 10000000000000000n
          : undefined;

      const result = await x402Fetcher(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.body,
        config: {
          sandbox: args.sandbox ?? true,
          maxPerRequestAtomic: budgetAtomic,
          maxSessionAtomic: budgetAtomic,
        },
      });

      const bodyText = await result.response.text();
      return toolSuccess({
        status: result.response.status,
        paid: result.paid,
        sandbox: result.sandbox,
        selectedScheme: result.selectedScheme,
        settlement: result.settlement,
        body: bodyText,
      });
    }, options.context)
  );
}

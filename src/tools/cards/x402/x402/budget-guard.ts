import { X402BudgetExceededError } from "./errors.js";

export interface X402BudgetGuardConfig {
  readonly maxPerRequestAtomic?: bigint;
  readonly maxSessionAtomic?: bigint;
}

export interface X402BudgetState {
  spentAtomic: bigint;
}

export interface BudgetCheckResult {
  readonly amountAtomic: bigint;
  readonly nextSessionSpentAtomic: bigint;
}

export class X402BudgetGuard {
  private readonly maxPerRequestAtomic?: bigint;

  private readonly maxSessionAtomic?: bigint;

  private state: X402BudgetState;

  public constructor(config: X402BudgetGuardConfig, initialState?: Partial<X402BudgetState>) {
    this.maxPerRequestAtomic = config.maxPerRequestAtomic;
    this.maxSessionAtomic = config.maxSessionAtomic;
    this.state = {
      spentAtomic: initialState?.spentAtomic ?? 0n,
    };
  }

  public getSpentAtomic(): bigint {
    return this.state.spentAtomic;
  }

  public check(amountAtomic: bigint): BudgetCheckResult {
    if (amountAtomic < 0n) {
      throw new X402BudgetExceededError("Payment amount cannot be negative");
    }

    if (this.maxPerRequestAtomic !== undefined && amountAtomic > this.maxPerRequestAtomic) {
      throw new X402BudgetExceededError(
        `x402 payment amount ${amountAtomic.toString()} exceeds per-request limit ${this.maxPerRequestAtomic.toString()}`
      );
    }

    const nextSessionSpentAtomic = this.state.spentAtomic + amountAtomic;
    if (this.maxSessionAtomic !== undefined && nextSessionSpentAtomic > this.maxSessionAtomic) {
      throw new X402BudgetExceededError(
        `x402 session spend ${nextSessionSpentAtomic.toString()} exceeds session limit ${this.maxSessionAtomic.toString()}`
      );
    }

    return {
      amountAtomic,
      nextSessionSpentAtomic,
    };
  }

  public record(amountAtomic: bigint): void {
    const result = this.check(amountAtomic);
    this.state = {
      spentAtomic: result.nextSessionSpentAtomic,
    };
  }
}

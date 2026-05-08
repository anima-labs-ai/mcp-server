export class X402Error extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "X402Error";
  }
}

export class X402ChallengeError extends X402Error {
  public constructor(message: string) {
    super(message);
    this.name = "X402ChallengeError";
  }
}

export class X402BudgetExceededError extends X402Error {
  public constructor(message: string) {
    super(message);
    this.name = "X402BudgetExceededError";
  }
}

export class X402SettlementError extends X402Error {
  public constructor(message: string) {
    super(message);
    this.name = "X402SettlementError";
  }
}

export class X402UnsupportedSchemeError extends X402Error {
  public constructor(message: string) {
    super(message);
    this.name = "X402UnsupportedSchemeError";
  }
}

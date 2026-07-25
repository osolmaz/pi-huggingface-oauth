export type OAuthStage = "configuration" | "device authorization" | "token polling" | "token refresh";

export class HuggingFaceOAuthError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly stage: OAuthStage;

  constructor(stage: OAuthStage, message: string, options?: { code?: string; retryable?: boolean }) {
    super(message);
    this.name = "HuggingFaceOAuthError";
    this.stage = stage;
    this.code = options?.code;
    this.retryable = options?.retryable ?? false;
  }
}

export class HuggingFaceOAuthCancelledError extends HuggingFaceOAuthError {
  constructor(stage: OAuthStage) {
    super(stage, "Hugging Face login was cancelled.", { code: "cancelled" });
    this.name = "HuggingFaceOAuthCancelledError";
  }
}

export type SmsErrorCode =
  | "INVALID_PHONE"
  | "INVALID_MESSAGE"
  | "INVALID_INPUT"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_VARIABLE_MISSING"
  | "CONFIG"
  | "UNAUTHORIZED"
  | "FORBIDDEN_SCOPE"
  | "NETWORK"
  | "HTTP";

export class SmsError extends Error {
  readonly code: SmsErrorCode;
  readonly status?: number;
  constructor(code: SmsErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SmsError";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** Duck-typed so it works across ESM/CJS and separate entry-point bundles. */
export function isSmsError(e: unknown): e is SmsError {
  return e instanceof Error && e.name === "SmsError" && typeof (e as { code?: unknown }).code === "string";
}

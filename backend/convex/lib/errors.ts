import { ConvexError, type Value } from 'convex/values';

/**
 * Error codes that the UI and MCP tell apart.
 * `budget_warning` is deliberately NOT an error but a hint in the result.
 */
export type ErrorCode = 'access_denied' | 'not_found' | 'conflict' | 'invalid' | 'invalid_transition' | 'rejected' | 'rate_limited';

export type ErrorData = { code: ErrorCode; message: string } & Record<string, Value>;

/** Throws a business error with a code and a readable message (shown in the UI and to MCP clients). */
export function fail(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): never {
  // Convex values must not contain undefined.
  const data: Record<string, Value> = { code, message };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) data[key] = value as Value;
  throw new ConvexError(data as ErrorData);
}

export function notFound(what: string, extra?: Record<string, unknown>): never {
  return fail('not_found', `${what} does not exist.`, extra);
}

export function invalid(message: string, extra?: Record<string, unknown>): never {
  return fail('invalid', message, extra);
}

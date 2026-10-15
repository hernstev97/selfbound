// Read-only GraphQL client for Linear.
//
// - API key from ~/.config/xlr8/linear-api-key (mode 600, otherwise abort).
// - Read-only guard: every document is parsed with `graphql.parse` before it is sent.
//   Exactly one named OperationDefinition with `operation === 'query'` is allowed,
//   nothing else (no mutation, no subscription, no fragments, no type definitions).
//   No string matching.
// - Pagination through `first`/`after`/`pageInfo`.
// - Waits on rate limits (HTTP 429 or `RATELIMITED`) and on 5xx/network errors.
// - Logs every operation name sent (proof of "read access only").

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { graphql } from './graphql.ts';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
export const DEFAULT_KEY_FILE = join(homedir(), '.config', 'xlr8', 'linear-api-key');

export class ReadOnlyViolation extends Error {
  override name = 'ReadOnlyViolation';
}

export class LinearApiError extends Error {
  override name = 'LinearApiError';
  readonly status?: number;
  readonly codes: string[];
  constructor(message: string, status?: number, codes: string[] = []) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

/**
 * Checks that `document` is exactly one named query and returns its name.
 * Throws `ReadOnlyViolation` for anything else.
 */
export function assertReadOnly(document: string): string {
  let ast;
  try {
    ast = graphql.parse(document);
  } catch (error) {
    throw new ReadOnlyViolation(`GraphQL document cannot be parsed: ${(error as Error).message}`);
  }
  const definitions = ast.definitions;
  if (definitions.length !== 1) {
    throw new ReadOnlyViolation(`Exactly one operation allowed, found ${definitions.length} definitions.`);
  }
  const def = definitions[0]!;
  if (def.kind !== graphql.Kind.OPERATION_DEFINITION) {
    throw new ReadOnlyViolation(`Only query operations allowed, found ${def.kind}.`);
  }
  if (def.operation !== graphql.OperationTypeNode.QUERY) {
    throw new ReadOnlyViolation(`Only read access allowed, found ${def.operation}.`);
  }
  if (!def.name?.value) throw new ReadOnlyViolation('Every query needs a name (for the log).');
  return def.name.value;
}

/** Reads the API key. Aborts if the file is missing or readable by others. */
export function readApiKey(file = DEFAULT_KEY_FILE): string {
  // One handle for check and read: the file cannot be swapped in between. O_NOFOLLOW refuses symlinks.
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${file} is not a regular file (symlinks are not allowed).`);
    throw new Error(
      `No Linear API key at ${file}.\n` +
        'Create a key with read access in Linear under Settings → Security & access → Personal API keys\n' +
        `and store it like this:  install -D -m 600 /dev/stdin ${file}  (paste the key, Ctrl+D)`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file (symlinks are not allowed).`);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `${file} is readable by others (mode ${(stat.mode & 0o777).toString(8)}). ` +
          `Only you may read the key: chmod 600 ${file}`,
      );
    }
    const key = readFileSync(fd, 'utf8').trim();
    if (!key) throw new Error(`${file} is empty.`);
    return key;
  } finally {
    closeSync(fd);
  }
}

export interface OperationLogEntry {
  operation: string;
  kind: 'query';
  at: string; // ISO time
  status: number | 'network-error';
  attempt: number;
  ms: number;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

export interface LinearClientOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries on rate limits (default 8) and on 5xx/network errors (default 4). */
  maxRateLimitRetries?: number;
  maxServerRetries?: number;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LinearClient {
  readonly log: OperationLogEntry[] = [];
  private readonly opts: Required<Omit<LinearClientOptions, 'apiKey'>> & { apiKey: string };

  constructor(options: LinearClientOptions) {
    // Options passed without a value (e.g. `sleep: undefined` from runFetch) keep their default.
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as LinearClientOptions;
    this.opts = {
      endpoint: LINEAR_ENDPOINT,
      fetch: globalThis.fetch,
      sleep: defaultSleep,
      maxRateLimitRetries: 8,
      maxServerRetries: 4,
      now: Date.now,
      ...given,
    };
  }

  /** Runs a query. The guard runs before every send. */
  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const operation = assertReadOnly(document);
    let rateRetries = 0;
    let serverRetries = 0;
    for (let attempt = 1; ; attempt++) {
      const started = this.opts.now();
      let response: Response;
      try {
        response = await this.opts.fetch(this.opts.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            // Personal Linear API keys are sent without "Bearer".
            Authorization: this.opts.apiKey,
          },
          body: JSON.stringify({ query: document, variables, operationName: operation }),
        });
      } catch (error) {
        this.record(operation, 'network-error', attempt, started);
        if (++serverRetries > this.opts.maxServerRetries) {
          throw new LinearApiError(`Network error in ${operation}: ${(error as Error).message}`);
        }
        await this.opts.sleep(backoff(serverRetries));
        continue;
      }
      this.record(operation, response.status, attempt, started);

      let payload: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] } | undefined;
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = undefined;
      }
      const codes = (payload?.errors ?? []).map((e) => e.extensions?.code ?? '').filter(Boolean);

      if (response.status === 429 || codes.includes('RATELIMITED')) {
        if (++rateRetries > this.opts.maxRateLimitRetries) {
          throw new LinearApiError(`Rate limit in ${operation} persists, aborting.`, response.status, codes);
        }
        await this.opts.sleep(rateLimitWait(response, rateRetries, this.opts.now()));
        continue;
      }
      if (response.status >= 500) {
        if (++serverRetries > this.opts.maxServerRetries) {
          throw new LinearApiError(`Linear answered ${response.status} to ${operation}.`, response.status, codes);
        }
        await this.opts.sleep(backoff(serverRetries));
        continue;
      }
      if (response.status === 401 || response.status === 403 || codes.includes('AUTHENTICATION_ERROR')) {
        throw new LinearApiError(
          `Linear rejects the API key (HTTP ${response.status}). Is it valid and does it have read access?`,
          response.status,
          codes,
        );
      }
      if (!response.ok || payload?.errors?.length || !payload?.data) {
        const messages = (payload?.errors ?? []).map((e) => e.message).join('; ');
        throw new LinearApiError(
          `Error in ${operation} (HTTP ${response.status})${messages ? `: ${messages}` : ''}`,
          response.status,
          codes,
        );
      }
      return payload.data;
    }
  }

  /** Fetches all pages of a connection. `pick` selects the connection from the response. */
  async paginate<TNode, TData = unknown>(
    document: string,
    variables: Record<string, unknown>,
    pick: (data: TData) => Connection<TNode> | null | undefined,
    pageSize = 50,
  ): Promise<TNode[]> {
    const out: TNode[] = [];
    let after: string | null | undefined = null;
    for (let page = 0; ; page++) {
      if (page > 10_000) throw new LinearApiError('More than 10,000 pages, aborting (loop?).');
      const data: TData = await this.query<TData>(document, { ...variables, first: pageSize, after });
      const connection = pick(data);
      if (!connection) break;
      out.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) break;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) {
        throw new LinearApiError('pageInfo.hasNextPage without a new endCursor, aborting.');
      }
      after = connection.pageInfo.endCursor;
    }
    return out;
  }

  /** Number of calls per operation name. */
  summary(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.log) counts[entry.operation] = (counts[entry.operation] ?? 0) + 1;
    return counts;
  }

  private record(operation: string, status: OperationLogEntry['status'], attempt: number, started: number) {
    this.log.push({
      operation,
      kind: 'query',
      at: new Date(started).toISOString(),
      status,
      attempt,
      ms: this.opts.now() - started,
    });
  }
}

/** 1 s, 2 s, 4 s, … at most 60 s. */
function backoff(retry: number) {
  return Math.min(60_000, 1000 * 2 ** (retry - 1));
}

/** Wait time from Linear's reset headers, otherwise exponential. */
function rateLimitWait(response: Response, retry: number, now: number) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15 * 60_000);
  for (const header of ['x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset']) {
    const reset = Number(response.headers.get(header)); // milliseconds since the epoch
    if (Number.isFinite(reset) && reset > now) return Math.min(reset - now + 250, 15 * 60_000);
  }
  return backoff(retry);
}

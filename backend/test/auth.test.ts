import { makeFunctionReference } from 'convex/server';
import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { OWNER_KIND } from '../convex/shared/constants';
import { expectCode, modules, setup } from './helpers';

// Sign-in sweep: EVERY exported public function from all modules is called
// without an identity and with a foreign identity and must be rejected with
// access_denied. New functions cannot slip through this way.
// Only exception: health.status (it only shows whether the backend is running).

const PUBLIC_WITHOUT_LOGIN = new Set(['health:status']);

type Kind = 'query' | 'mutation' | 'action';
interface RegisteredFunction {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  exportArgs: () => string;
}

interface JsonValidator {
  type: string;
  value?: unknown;
  tableName?: string;
  keys?: JsonValidator;
  values?: { fieldType: JsonValidator };
}

/** Smallest valid value for a validator (required fields only), so argument validation passes. */
function sample(validator: JsonValidator): unknown {
  switch (validator.type) {
    case 'string':
      return 'x';
    case 'number':
      return 1;
    case 'bigint':
      return 1n;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'any':
      return null;
    case 'bytes':
      return new ArrayBuffer(1);
    case 'literal':
      return validator.value;
    case 'id':
      // convex-test reads the table from the end of the ID.
      return `1000${validator.tableName}`;
    case 'array':
      return [];
    case 'record':
      return {};
    case 'union':
      return sample((validator.value as JsonValidator[])[0]);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(validator.value as Record<string, { fieldType: JsonValidator; optional: boolean }>)) {
        if (!field.optional) out[key] = sample(field.fieldType);
      }
      return out;
    }
    default:
      throw new Error(`Unknown validator ${validator.type}`);
  }
}

async function publicFunctions() {
  const found: { path: string; kind: Kind; args: Record<string, unknown> }[] = [];
  for (const [file, load] of Object.entries(modules)) {
    const module = /\.\.\/convex\/(.+)\.[jt]s$/.exec(file)?.[1];
    if (!module || module.startsWith('_generated') || module === 'schema' || module === 'auth.config' || module === 'crons') continue;
    const exports = (await load()) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== 'function') continue;
      const fn = value as unknown as RegisteredFunction;
      if (!fn.isPublic) continue;
      const kind: Kind = fn.isQuery ? 'query' : fn.isMutation ? 'mutation' : 'action';
      found.push({ path: `${module}:${name}`, kind, args: sample(JSON.parse(fn.exportArgs())) as Record<string, unknown> });
    }
  }
  return found;
}

async function call(client: ReturnType<typeof setup>['t'], fn: { path: string; kind: Kind; args: Record<string, unknown> }) {
  if (fn.kind === 'query') return await client.query(makeFunctionReference<'query'>(fn.path), fn.args);
  if (fn.kind === 'mutation') return await client.mutation(makeFunctionReference<'mutation'>(fn.path), fn.args);
  return await client.action(makeFunctionReference<'action'>(fn.path), fn.args);
}

describe('Sign-in required', () => {
  test('the sweep finds the public functions', async () => {
    const paths = (await publicFunctions()).map((f) => f.path);
    // Spot check: if one of these is missing, the sweep no longer finds the modules.
    for (const p of ['issues:create', 'issues:bucket', 'meta:get', 'sprints:close', 'teams:setLogo', 'agents:create', 'seed:reset', 'ops:status']) {
      expect(paths).toContain(p);
    }
    expect(paths.length).toBeGreaterThan(50);
  });

  test('every public function rejects calls without sign-in and with a foreign identity', async () => {
    const { t, stranger } = setup();
    const checked: string[] = [];
    for (const fn of await publicFunctions()) {
      if (PUBLIC_WITHOUT_LOGIN.has(fn.path)) continue;
      for (const client of [t, stranger]) {
        let error: unknown;
        try {
          await call(client as typeof t, fn);
        } catch (e) {
          error = e;
        }
        expect((error as { data?: { code?: string } } | undefined)?.data?.code, `${fn.path}: ${String(error)}`).toBe('access_denied');
      }
      checked.push(fn.path);
    }
    expect(checked.length).toBeGreaterThan(50);
  });

  test('without XLR8_OWNER_IDS nobody gets in, not even the owner', async () => {
    const { owner } = setup();
    process.env.XLR8_OWNER_IDS = '';
    await expectCode(owner.query(api.meta.counter, {}), 'access_denied');
  });

  test('health.status is readable without sign-in, whoami only when signed in', async () => {
    const { t, owner } = setup();
    expect((await t.query(api.health.status, {})).ok).toBe(true);
    await expectCode(t.query(api.health.whoami, {}), 'access_denied');
    expect(await owner.query(api.health.whoami, {})).toEqual({ kind: OWNER_KIND });
  });
});

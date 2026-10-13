// Lean validator for tool arguments.
//
// Each rule yields both the JSON Schema for `tools/list` and the check including
// normalization (e.g. identifier upper-cased, priority as a number), so description and
// check cannot drift apart. Error messages always name the path.

export type JsonSchema = Record<string, unknown>;

export interface Schema<T, Opt extends boolean = false> {
  readonly json: JsonSchema;
  readonly optional: Opt;
  readonly defaultValue?: T;
  /** Checks `value`, appends errors to `errors` and returns the normalized value. */
  check(value: unknown, path: string, errors: string[]): T;
}

export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;
type AnySchema = Schema<any, boolean>;
type Shape = Record<string, AnySchema>;
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K]['optional'] extends true ? never : K }[keyof S];
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K]['optional'] extends true ? K : never }[keyof S];
export type ObjectOf<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

const at = (path: string) => (path ? `${path}` : 'arguments');
const describeType = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function make<T>(json: JsonSchema, check: Schema<T>['check']): Schema<T> {
  return { json, optional: false, check };
}

export function string(opts: {
  description?: string;
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternHint?: string;
  enum?: readonly string[];
  transform?: (s: string) => string;
} = {}): Schema<string> {
  const json: JsonSchema = { type: 'string' };
  if (opts.description) json.description = opts.description;
  if (opts.min !== undefined) json.minLength = opts.min;
  if (opts.max !== undefined) json.maxLength = opts.max;
  if (opts.pattern) json.pattern = opts.pattern.source;
  return make(json, (value, path, errors) => {
    if (typeof value !== 'string') {
      errors.push(`${at(path)}: expected a string, got ${describeType(value)}`);
      return '';
    }
    const s = opts.transform ? opts.transform(value) : value;
    if (opts.min !== undefined && s.length < opts.min)
      errors.push(`${at(path)}: must be at least ${opts.min} character${opts.min === 1 ? '' : 's'} long`);
    if (opts.max !== undefined && s.length > opts.max) errors.push(`${at(path)}: must be at most ${opts.max} characters long`);
    if (opts.pattern && !opts.pattern.test(s))
      errors.push(`${at(path)}: ${JSON.stringify(value)} is not ${opts.patternHint ?? `matching ${opts.pattern.source}`}`);
    return s;
  });
}

export function enumOf<const V extends readonly string[]>(values: V, opts: { description?: string } = {}): Schema<V[number]> {
  const json: JsonSchema = { type: 'string', enum: [...values] };
  if (opts.description) json.description = opts.description;
  return make(json, (value, path, errors) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      errors.push(`${at(path)}: ${JSON.stringify(value)} is not one of ${values.join(', ')}`);
    }
    return value as V[number];
  });
}

export function integer(opts: { description?: string; min?: number; max?: number } = {}): Schema<number> {
  const json: JsonSchema = { type: 'integer' };
  if (opts.description) json.description = opts.description;
  if (opts.min !== undefined) json.minimum = opts.min;
  if (opts.max !== undefined) json.maximum = opts.max;
  return make(json, (value, path, errors) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${at(path)}: expected an integer, got ${JSON.stringify(value) ?? describeType(value)}`);
      return 0;
    }
    if (opts.min !== undefined && value < opts.min) errors.push(`${at(path)}: must be >= ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) errors.push(`${at(path)}: must be <= ${opts.max}`);
    return value;
  });
}

export function number(opts: { description?: string; min?: number; max?: number } = {}): Schema<number> {
  const json: JsonSchema = { type: 'number' };
  if (opts.description) json.description = opts.description;
  if (opts.min !== undefined) json.minimum = opts.min;
  if (opts.max !== undefined) json.maximum = opts.max;
  return make(json, (value, path, errors) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${at(path)}: expected a number, got ${describeType(value)}`);
      return 0;
    }
    if (opts.min !== undefined && value < opts.min) errors.push(`${at(path)}: must be >= ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) errors.push(`${at(path)}: must be <= ${opts.max}`);
    return value;
  });
}

export function boolean(opts: { description?: string } = {}): Schema<boolean> {
  const json: JsonSchema = { type: 'boolean' };
  if (opts.description) json.description = opts.description;
  return make(json, (value, path, errors) => {
    if (typeof value !== 'boolean') errors.push(`${at(path)}: expected true or false, got ${describeType(value)}`);
    return value as boolean;
  });
}

export function array<T>(
  item: Schema<T>,
  opts: { description?: string; min?: number; max?: number; unique?: boolean } = {},
): Schema<T[]> {
  const json: JsonSchema = { type: 'array', items: item.json };
  if (opts.description) json.description = opts.description;
  if (opts.min !== undefined) json.minItems = opts.min;
  if (opts.max !== undefined) json.maxItems = opts.max;
  if (opts.unique) json.uniqueItems = true;
  return make(json, (value, path, errors) => {
    if (!Array.isArray(value)) {
      errors.push(`${at(path)}: expected an array, got ${describeType(value)}`);
      return [];
    }
    if (opts.min !== undefined && value.length < opts.min)
      errors.push(`${at(path)}: needs at least ${opts.min} item${opts.min === 1 ? '' : 's'}`);
    if (opts.max !== undefined && value.length > opts.max) errors.push(`${at(path)}: allows at most ${opts.max} items`);
    const out = value.map((v, i) => item.check(v, `${path}[${i}]`, errors));
    if (opts.unique) {
      const seen = new Set<string>();
      for (const v of out) {
        const key = JSON.stringify(v);
        if (seen.has(key)) errors.push(`${at(path)}: contains ${key} more than once`);
        seen.add(key);
      }
    }
    return out;
  });
}

/** Optional field, optionally with a default value (which then also appears in the JSON Schema). */
export function optional<T>(schema: Schema<T>, defaultValue?: T): Schema<T, true> {
  const json = defaultValue === undefined ? schema.json : { ...schema.json, default: defaultValue };
  return { json, optional: true, defaultValue, check: schema.check };
}

/** Value or `null` (e.g. "remove the due date"). */
export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  const { description, ...rest } = schema.json;
  const json: JsonSchema = { anyOf: [rest, { type: 'null' }] };
  if (description) json.description = description;
  return make(json, (value, path, errors) => (value === null ? null : schema.check(value, path, errors)));
}

/** One of several shapes; the first match wins. */
export function anyOf<T>(schemas: Schema<T>[], opts: { description?: string; hint: string }): Schema<T> {
  const json: JsonSchema = { anyOf: schemas.map((s) => s.json) };
  if (opts.description) json.description = opts.description;
  return make(json, (value, path, errors) => {
    for (const s of schemas) {
      const local: string[] = [];
      const out = s.check(value, path, local);
      if (local.length === 0) return out;
    }
    errors.push(`${at(path)}: ${JSON.stringify(value) ?? describeType(value)} is not ${opts.hint}`);
    return value as T;
  });
}

/** Transforms after a successful check (e.g. priority word → number). */
export function map<A, B>(schema: Schema<A>, fn: (a: A) => B): Schema<B> {
  return make(schema.json, (value, path, errors) => {
    const before = errors.length;
    const out = schema.check(value, path, errors);
    return errors.length === before ? fn(out) : (out as unknown as B);
  });
}

export function object<S extends Shape>(
  shape: S,
  opts: {
    description?: string;
    /** Checks across fields, e.g. "exactly one of a, b". */
    refine?: (value: ObjectOf<S>, path: string, errors: string[]) => void;
  } = {},
): Schema<ObjectOf<S>> {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, s] of Object.entries(shape)) {
    properties[key] = s.json;
    if (!s.optional) required.push(key);
  }
  const json: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length) json.required = required;
  if (opts.description) json.description = opts.description;
  const allowed = Object.keys(shape);
  return make(json, (value, path, errors) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${at(path)}: expected an object, got ${describeType(value)}`);
      return {} as ObjectOf<S>;
    }
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (!(key in shape)) {
        errors.push(
          `${path ? `${path}.` : ''}${key}: unknown field (allowed: ${allowed.length ? allowed.join(', ') : 'none'})`,
        );
      }
    }
    for (const [key, s] of Object.entries(shape)) {
      const child = path ? `${path}.${key}` : key;
      const v = input[key];
      if (v === undefined) {
        if (!s.optional) errors.push(`${child}: required`);
        else if (s.defaultValue !== undefined) out[key] = s.defaultValue;
        continue;
      }
      out[key] = s.check(v, child, errors);
    }
    const before = errors.length;
    if (opts.refine && before === 0) opts.refine(out as ObjectOf<S>, path, errors);
    return out as ObjectOf<S>;
  });
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function validate<T>(schema: Schema<T, boolean>, value: unknown): CheckResult<T> {
  const errors: string[] = [];
  const out = schema.check(value, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

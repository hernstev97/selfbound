// The context of a measured interaction: a function that runs in the page, or a plain value.
// A value travels as data (page.evaluate argument), never spliced into source text.

export type Context = { src: string } | { value: unknown } | null;

/** A context that is just a value (must survive JSON). */
export const constant = (value: unknown) => Object.assign(() => value, { constantValue: value });

export function contextArg(fn?: (() => unknown) & { constantValue?: unknown }): Context {
  if (!fn) return null;
  return 'constantValue' in fn ? { value: fn.constantValue } : { src: fn.toString() };
}

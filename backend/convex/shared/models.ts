// Desired model per issue (XLR8-93): types and rules shared by backend, core and UI.
// This file must not import anything from Convex; it also runs in the browser.

/** What an issue (or a team default) asks for. A missing effort or speed means "the agent decides". */
export type ModelChoice = { provider: string; modelId: string; effort?: string; speed?: string };

/** One model of the catalog as the app sees it (an enabled model in `meta.get`, a row in the settings). */
export type ModelInfo = {
  provider: string;
  providerName: string;
  modelId: string;
  name: string;
  family?: string;
  /** Valid effort values in catalog order; empty = the model has no effort setting. */
  efforts: string[];
  /** Speed modes besides `standard` (e.g. `fast`); empty = standard only. */
  modes: string[];
  context?: number;
  output?: number;
  releaseDate?: string;
  enabled?: boolean;
  /** No longer in the models.dev catalog: existing choices stay, new ones are refused. */
  removed?: boolean;
  /** The provider's logo (our own /logo/<id>, from models.dev); missing = none */
  logo?: string;
};

/** Where an effective model comes from. */
export type ModelSource = 'issue' | 'parent' | 'team';

export type EffectiveModel = { choice: ModelChoice; source: ModelSource };

/** The speed every model has. Not stored: a choice without `speed` runs at standard speed. */
export const STANDARD_SPEED = 'standard';

export const MODEL_LIMITS = {
  provider: 100,
  modelId: 200,
  /** Effort values and speed modes. */
  value: 40,
  /** Enabled models per instance. */
  enabled: 200,
} as const;

/** Stable key of a model, e.g. `anthropic/claude-opus-5-5`. Provider IDs contain no slash; model IDs may. */
export function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Splits a key from `modelKey`; null if it has no slash. */
export function parseModelKey(key: string): { provider: string; modelId: string } | null {
  const at = key.indexOf('/');
  if (at <= 0 || at === key.length - 1) return null;
  return { provider: key.slice(0, at), modelId: key.slice(at + 1) };
}

/**
 * A choice as one string, e.g. `anthropic/claude-opus-5-5?effort=xhigh&speed=fast`: inbox entries keep
 * only strings (`inboxChanges.ts`), and agents can read it.
 */
export function encodeChoice(choice: ModelChoice): string {
  const params = new URLSearchParams();
  if (choice.effort) params.set('effort', choice.effort);
  if (choice.speed) params.set('speed', choice.speed);
  const query = params.toString();
  return modelKey(choice.provider, choice.modelId) + (query ? `?${query}` : '');
}

export function decodeChoice(text: string): ModelChoice | null {
  const at = text.lastIndexOf('?');
  const key = parseModelKey(at < 0 ? text : text.slice(0, at));
  if (!key) return null;
  const params = new URLSearchParams(at < 0 ? '' : text.slice(at + 1));
  const effort = params.get('effort');
  const speed = params.get('speed');
  return { ...key, ...(effort ? { effort } : {}), ...(speed ? { speed } : {}) };
}

/** Canonical form for storing and comparing: trimmed, no empty effort, no `standard` speed. */
export function normalizeChoice(choice: ModelChoice): ModelChoice {
  const out: ModelChoice = { provider: choice.provider.trim(), modelId: choice.modelId.trim() };
  const effort = choice.effort?.trim();
  const speed = choice.speed?.trim();
  if (effort) out.effort = effort;
  if (speed && speed !== STANDARD_SPEED) out.speed = speed;
  return out;
}

export function sameChoice(a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.provider === b.provider && a.modelId === b.modelId && (a.effort ?? '') === (b.effort ?? '') && (a.speed ?? '') === (b.speed ?? '');
}

export function sameModel(a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
}

/** The speeds a model offers, `standard` first. */
export function speedsOf(info: Pick<ModelInfo, 'modes'>): string[] {
  return [STANDARD_SPEED, ...info.modes.filter((m) => m !== STANDARD_SPEED)];
}

/**
 * Why a choice is not valid for this model, or null if it is. `info` undefined = unknown model.
 * The availability rules (enabled, still in the catalog) are the caller's: they differ between a new
 * choice and one an issue already has.
 */
export function choiceProblem(choice: ModelChoice, info: Pick<ModelInfo, 'efforts' | 'modes' | 'name'> | undefined): string | null {
  const label = `${choice.provider}/${choice.modelId}`;
  if (!choice.provider || !choice.modelId) return 'A model needs a provider and a model ID.';
  if (choice.provider.length > MODEL_LIMITS.provider || choice.modelId.length > MODEL_LIMITS.modelId) return `Unknown model "${label}".`;
  if (!info) return `Unknown model "${label}".`;
  if (choice.effort !== undefined) {
    if (info.efforts.length === 0) return `${info.name} has no effort setting; leave effort empty.`;
    if (!info.efforts.includes(choice.effort)) {
      return `Effort "${choice.effort}" is not valid for ${info.name}. Valid: ${info.efforts.join(', ')}.`;
    }
  }
  if (choice.speed !== undefined && choice.speed !== STANDARD_SPEED && !info.modes.includes(choice.speed)) {
    return `Speed "${choice.speed}" is not valid for ${info.name}. Valid: ${speedsOf(info).join(', ')}.`;
  }
  return null;
}

/** Resolution order: the issue's own choice, then its parent's, then the team default, otherwise none. */
export function effectiveModel(
  own: ModelChoice | null | undefined,
  parent: ModelChoice | null | undefined,
  team: ModelChoice | null | undefined,
): EffectiveModel | null {
  if (own) return { choice: own, source: 'issue' };
  if (parent) return { choice: parent, source: 'parent' };
  if (team) return { choice: team, source: 'team' };
  return null;
}

/**
 * Filter by effective model (MCP `model` and the list filter): "none" = no model, otherwise a provider ID,
 * a model ID or "provider/modelId", case-insensitive.
 */
export function modelFilterMatches(filter: string, effective: ModelChoice | null | undefined): boolean {
  const f = filter.trim().toLowerCase();
  if (f === 'none') return !effective;
  if (!effective) return false;
  const provider = effective.provider.toLowerCase();
  const id = effective.modelId.toLowerCase();
  return f === provider || f === id || f === `${provider}/${id}`;
}

/**
 * Compact token count: 1000000 → "1M", 1048576 → "1.05M", 262144 → "262K", 8192 → "8.2K". `num` formats
 * the number (the UI passes one for its language, "1,05M" in German).
 */
export function compactTokens(n: number, num: (value: number) => string = String): string {
  if (n >= 1_000_000) return `${num(Math.round(n / 10_000) / 100)}M`;
  if (n >= 10_000) return `${num(Math.round(n / 1000))}K`;
  if (n >= 1000) return `${num(Math.round(n / 100) / 10)}K`;
  return num(n);
}

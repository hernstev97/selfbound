// Desired model per issue (XLR8-93) in the client: display texts and the effective model. The rules
// (resolution order, valid values) come from the backend's shared/models.ts, so both sides agree.
import {
  compactTokens,
  effectiveModel,
  modelKey,
  type EffectiveModel,
  type ModelChoice,
  type ModelInfo,
  type ModelSource,
} from '@selfbound/backend/shared/models';
import { t } from './i18n.ts';
import type { Issue, Meta } from './types.ts';

export type { EffectiveModel, ModelChoice, ModelInfo, ModelSource };
export { modelKey };

const INDEX = new WeakMap<object, Map<string, ModelInfo>>();

/** The enabled models of a meta revision by `modelKey`, built once per revision. */
export function modelIndex(meta: Meta | null | undefined): Map<string, ModelInfo> {
  const models = meta?.models;
  if (!models) return new Map();
  let index = INDEX.get(models);
  if (!index) {
    index = new Map(models.map((m) => [modelKey(m.provider, m.modelId), m]));
    INDEX.set(models, index);
  }
  return index;
}

export function modelInfo(meta: Meta | null | undefined, choice: Pick<ModelChoice, 'provider' | 'modelId'>): ModelInfo | undefined {
  return modelIndex(meta).get(modelKey(choice.provider, choice.modelId));
}

/** Short text for chips and rows: "Claude Opus 5.5 · xhigh", the speed only when it is not standard. */
export function modelLabel(meta: Meta | null | undefined, choice: ModelChoice): string {
  const name = modelInfo(meta, choice)?.name ?? choice.modelId;
  return [name, choice.effort, choice.speed].filter(Boolean).join(' · ');
}

/** "1M context" (info only, not a choice). */
export function contextLabel(info: Pick<ModelInfo, 'context'> | undefined): string | null {
  return info?.context ? t('{size} context', { size: compactTokens(info.context) }) : null;
}

/** Own model, else the parent's, else the team default; `parent` from the store. */
export function issueModel(meta: Meta | null | undefined, issue: Pick<Issue, 'model' | 'teamId'>, parent: Pick<Issue, 'model'> | undefined): EffectiveModel | null {
  const team = issue.model || parent?.model ? undefined : meta?.teams.find((x) => x._id === issue.teamId)?.defaultModel;
  return effectiveModel(issue.model, parent?.model, team);
}

/** Why a chosen model is shown with a hint: not enabled any more, or gone from the catalog. */
export function modelProblem(meta: Meta | null | undefined, choice: ModelChoice): string | null {
  const info = modelInfo(meta, choice);
  if (!info) return t('Not enabled in the settings');
  if (info.removed) return t('No longer in the catalog');
  return null;
}

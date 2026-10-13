import type { IconName } from '@xlr8/core';
import { translated } from '@xlr8/core/i18n';

/** Section groups of the settings (extension point: an entry here plus a case in SettingsPage). */
const GROUP = translated({ account: 'Account', workspace: 'Workspace', agents: 'Agents and ops' });

/** Section labels, keyed by section id (the id is also the URL path: /settings/{id}). */
export const SECTION_LABEL: Record<string, string> = translated({
  general: 'General',
  appearance: 'Appearance',
  notifications: 'Notifications',
  teams: 'Teams',
  projects: 'Projects',
  labels: 'Labels',
  recurrences: 'Recurrences',
  agents: 'Agents',
  github: 'GitHub',
  ops: 'Ops',
});

type Item = { id: string; icon: IconName };
const group = (key: keyof typeof GROUP, items: Item[]) => ({
  key,
  get label() {
    return GROUP[key];
  },
  items: items.map((item) => ({
    ...item,
    get label() {
      return SECTION_LABEL[item.id];
    },
  })),
});

export const SECTIONS = [
  group('account', [
    { id: 'general', icon: 'settings' },
    { id: 'appearance', icon: 'theme' },
    { id: 'notifications', icon: 'bell' },
  ]),
  group('workspace', [
    { id: 'teams', icon: 'team' },
    { id: 'projects', icon: 'projects' },
    { id: 'labels', icon: 'label' },
    { id: 'recurrences', icon: 'restore' },
  ]),
  group('agents', [
    { id: 'agents', icon: 'agent' },
    { id: 'github', icon: 'github' },
    { id: 'ops', icon: 'gauge' },
  ]),
];

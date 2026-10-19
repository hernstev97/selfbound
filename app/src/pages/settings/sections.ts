import type { IconName } from '@selfbound/core';
import { translated } from '@selfbound/core/i18n';

/** Section groups of the settings (extension point: an entry here plus a case in SettingsPage). */
const GROUP = translated({ account: 'Account', workspace: 'Workspace', agents: 'Agents and ops', selfbound: 'Selfbound' });

/** Section labels, keyed by section id (the id is also the URL path: /settings/{id}). */
export const SECTION_LABEL: Record<string, string> = translated({
  profile: 'Profile',
  general: 'General',
  appearance: 'Appearance',
  notifications: 'Notifications',
  teams: 'Teams',
  projects: 'Projects',
  labels: 'Labels',
  recurrences: 'Recurrences',
  priorities: 'Priorities',
  agents: 'Agents',
  models: 'Models',
  github: 'GitHub',
  ops: 'Ops',
  about: 'About',
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
    { id: 'profile', icon: 'user' },
    { id: 'general', icon: 'settings' },
    { id: 'appearance', icon: 'theme' },
    { id: 'notifications', icon: 'bell' },
  ]),
  group('workspace', [
    { id: 'teams', icon: 'team' },
    { id: 'projects', icon: 'projects' },
    { id: 'labels', icon: 'label' },
    { id: 'recurrences', icon: 'restore' },
    { id: 'priorities', icon: 'priority' },
  ]),
  group('agents', [
    { id: 'agents', icon: 'agent' },
    { id: 'models', icon: 'model' },
    { id: 'github', icon: 'github' },
    { id: 'ops', icon: 'gauge' },
  ]),
  group('selfbound', [{ id: 'about', icon: 'page' }]),
];

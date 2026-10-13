// On a team switch the sidebar follows one frame after the content on the right; everything else applies at once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Slice, type SidebarState, type SidebarTeam } from '@xlr8/core';
import { deferredSidebar } from '../src/lib/sidebarMotion.ts';

const team = (key: string) => ({ id: key, key }) as unknown as SidebarTeam;
const state = (current: string, patch: Partial<SidebarState> = {}) =>
  ({ active: '', inbox: 0, triage: 0, drafts: 0, sprint: null, planning: false, current: team(current), teams: [], dormant: [], teamsCollapsed: false, dormantCollapsed: false, teamSize: 'small', ...patch }) as SidebarState;

// Node has no requestAnimationFrame: one frame = a 16 ms timer.
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16)) as unknown as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

describe('deferredSidebar', () => {
  afterEach(() => vi.useRealTimers());

  it('team switch: only after the next frame; other changes at once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const source = new Slice(state('ORB'));
    const { shown, stop } = deferredSidebar(source);
    source.set(state('ORB', { active: 'team:ORB:backlog' }));
    expect(shown.get().active).toBe('team:ORB:backlog');
    source.set(state('FLUX', { active: 'team:FLUX:active' }));
    expect(shown.get().current?.key).toBe('ORB');
    // Further changes until then come with the switch.
    source.set(state('FLUX', { active: 'team:FLUX:active', inbox: 3 }));
    expect(shown.get().inbox).toBe(0);
    vi.advanceTimersByTime(16);
    expect(shown.get().current?.key).toBe('ORB');
    vi.advanceTimersByTime(1);
    expect(shown.get()).toBe(source.get());
    source.set(state('FLUX', { teamsCollapsed: true }));
    expect(shown.get().teamsCollapsed).toBe(true);
    stop();
  });
});

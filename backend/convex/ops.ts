import { ownerQuery } from './lib/auth';
import { testSwitchesEnabled, rejectWritesActive } from './lib/testSwitches';
import { callsToday, publicAgent } from './ops/agents';
import { storageUsage } from './ops/files';
import { readOpsStatus } from './ops/maintenance';
import { oauthConfig } from './lib/oauth/core';
import { armedUntil } from './ops/oauth';

// Ops page (Settings → Ops). (The shared operations live in ops/*.ts and export no Convex
// functions.)

/** Last backup, last import, agents with today's calls, result of the nightly sprint audit, file storage. */
export const status = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const lastRun = await ctx.db.query('importRuns').order('desc').first();
    const agents = await ctx.db.query('agents').order('desc').take(200);
    const lastDelivery = await ctx.db.query('githubDeliveries').withIndex('by_received').order('desc').first();
    return {
      backup: await readOpsStatus(ctx, 'backup'),
      lastImport: lastRun
        ? {
            run: lastRun.run,
            status: lastRun.status,
            phase: lastRun.phase ?? null, // current step (scan, team … link, cleanup) or done
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt ?? null,
            counts: lastRun.counts,
            deviations: lastRun.deviations.length,
            error: lastRun.error ?? null,
          }
        : null,
      agents: await Promise.all(
        agents.map(async (agent) => ({ ...publicAgent(agent), callsToday: await callsToday(ctx, agent._id, now) })),
      ),
      // Last accepted GitHub delivery (event and time only), null = none yet.
      github: lastDelivery ? { event: lastDelivery.event, receivedAt: lastDelivery.receivedAt } : null,
      sprintAudit: await readOpsStatus(ctx, 'auditSprints'),
      seed: await readOpsStatus(ctx, 'seed'),
      // File storage (images, logos): 1 GB on the free plan.
      storage: await storageUsage(ctx),
      // Connectors (claude.ai, ChatGPT): enabled, URL to enter in the app, armed until.
      connectors: (() => {
        const cfg = oauthConfig();
        return { enabled: cfg !== null, url: cfg?.resource ?? null };
      })(),
      connectorsArmedUntil: await armedUntil(ctx),
      testSwitches: testSwitchesEnabled(),
      rejectWrites: await rejectWritesActive(ctx),
    };
  },
});

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

// Times in UTC. Names ASCII only (a Convex requirement). Every job is idempotent and works in batches.
const crons = cronJobs();

crons.hourly('run-recurrences', { minuteUTC: 5 }, internal.maintenance.runDueRecurrences, {});
crons.daily('audit-sprints', { hourUTC: 1, minuteUTC: 15 }, internal.maintenance.auditSprints, {});
crons.daily('purge-trash', { hourUTC: 2, minuteUTC: 30 }, internal.maintenance.purgeTrash, {});
crons.daily('cleanup-requests', { hourUTC: 2, minuteUTC: 45 }, internal.maintenance.cleanup, {});
crons.daily('sweep-files', { hourUTC: 3, minuteUTC: 0 }, internal.files.sweep, {});
crons.hourly('fail-stale-imports', { minuteUTC: 20 }, internal.importer.failStale, {});
// Morning notifications (due issues, sprint end): hourly; the function checks the Berlin time itself.
crons.hourly('push-morning', { minuteUTC: 0 }, internal.push.morning, {});
crons.hourly('cleanup-oauth', { minuteUTC: 35 }, internal.oauth.cleanup, {});
// GitHub: check the webhooks in all repos of the token and create missing ones (never locally).
crons.daily('github-webhooks', { hourUTC: 3, minuteUTC: 30 }, internal.githubPr.ensureWebhooksDaily, {});

export default crons;

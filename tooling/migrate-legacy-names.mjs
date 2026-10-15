#!/usr/bin/env node
// Moves an instance from the old product name (XLR8) to Selfbound: environment variables of the
// production deployment, the per-user config directory and a checklist for everything that lives outside
// this repository. Dry run by default; nothing changes without --apply.
//
// Usage:  node tooling/migrate-legacy-names.mjs                       dry run: show what would happen
//         node tooling/migrate-legacy-names.mjs --apply               copy; never overwrites, never deletes
//         node tooling/migrate-legacy-names.mjs --apply --remove-old  also remove the old Convex variables
//         --no-convex / --no-files   skip one part
//
// What it does:
//   1. Local files: copies ~/.config/xlr8/* to ~/.config/selfbound/ with the same modes (secrets stay 600).
//      Existing files are left alone. The old directory stays. Data, state and cache folders (~/.local/share/xlr8,
//      ~/xlr8-restore, the perf folders) are only reported: they can be large, move them yourself.
//   2. Convex production (deploy key as in tooling/cloud.mjs): for every XLR8_<X> without a SELFBOUND_<X>,
//      sets SELFBOUND_<X> to the same value. Values go from the Convex CLI to the Convex CLI and are never
//      printed or logged; the report names variables only.
//   3. --remove-old: removes XLR8_<X> where SELFBOUND_<X> has an equal value. Refuses (removes nothing)
//      if an old variable has no twin. Run it after the deployed code has used the new names without
//      a "deprecated" warning in the logs.
//   4. Prints what to change by hand: Vercel project variables, systemd units, dashboards, GitHub secrets.
//
// The order for production is in docs/operations.md ("Moving from XLR8 to Selfbound").
// legacy-xlr8: this whole file exists to migrate the old names, so every old name in it is deliberate.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OLD_PREFIX = 'XLR8_';
const NEW_PREFIX = 'SELFBOUND_';

// ---------- Convex environment ------------------------------------------------------------------------------

/** Name of the new variable for an old one, or undefined if the name is not an old one. */
export const twinOf = (name) => (name.startsWith(OLD_PREFIX) ? NEW_PREFIX + name.slice(OLD_PREFIX.length) : undefined);

/**
 * Pure plan for the variables of a deployment.
 * @param {string[]} names all variable names of the deployment
 * @param {Map<string, string>} values values of the old variables and of the twins that exist
 * @returns {{ entries: { old: string, twin: string, state: 'copy' | 'same' | 'differs' | 'empty' | 'unreadable' }[], toCopy: string[], toRemove: string[], missingTwins: string[], differing: string[] }}
 */
export function planEnv(names, values) {
  const present = new Set(names);
  const entries = names
    .filter((n) => n.startsWith(OLD_PREFIX))
    .sort()
    .map((old) => {
      const twin = twinOf(old);
      const value = values.get(old);
      let state;
      if (present.has(twin)) state = value === undefined || values.get(twin) === undefined ? 'unreadable' : value === values.get(twin) ? 'same' : 'differs';
      else if (value === undefined) state = 'unreadable';
      else state = value === '' ? 'empty' : 'copy';
      return { old, twin, state };
    });
  const by = (state) => entries.filter((e) => e.state === state).map((e) => e.old);
  return {
    entries,
    toCopy: by('copy'),
    toRemove: by('same'),
    // Old variables without a (usable) twin: --remove-old refuses while there is one.
    missingTwins: entries.filter((e) => !names.includes(e.twin)).map((e) => e.old),
    differing: by('differs'),
  };
}

/** Parses `convex env list --names-only` (one name per line; anything else is ignored). */
export const parseNames = (stdout) => stdout.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));

/**
 * Convex CLI against production through an injected runner: run(args) -> { status, stdout }.
 * Errors never contain output of the CLI, because it may contain values.
 */
export function convexEnv(run) {
  const call = async (args, what) => {
    const r = await run(args);
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}). Check: node tooling/cloud.mjs env list --names-only`);
    return r.stdout;
  };
  return {
    names: async () => {
      const stdout = await call(['env', 'list', '--names-only'], 'convex env list');
      const names = parseNames(stdout);
      // Names only, one per line. Anything else would mean "nothing to do" for the wrong reason.
      if (!names.length && stdout.trim()) throw new Error('convex env list --names-only printed something unexpected; not continuing.');
      return names;
    },
    // `env get` prints the value and one newline.
    get: async (name) => (await call(['env', 'get', name], `convex env get ${name}`)).replace(/\n$/, ''),
    // After `--` a value that starts with a dash is not taken for an option.
    set: async (name, value) => void (await call(['env', 'set', name, '--', value], `convex env set ${name}`)),
    remove: async (name) => void (await call(['env', 'remove', name], `convex env remove ${name}`)),
  };
}

/** Real runner: Convex CLI with the production deploy key (tooling/cloud.mjs). */
export async function cloudRunner() {
  const { runCloud } = await import('./cloud.mjs');
  return (args) =>
    new Promise((resolve, reject) => {
      const child = runCloud(args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('error', reject);
      child.on('exit', (status) => resolve({ status: status ?? 1, stdout }));
    });
}

/**
 * Copies and, with removeOld, removes. Logs names and states only.
 * @returns {Promise<{ ok: boolean, copied: string[], removed: string[], refused: string[], kept: string[] }>}
 */
export async function migrateConvexEnv({ convex, apply, removeOld, log }) {
  const result = { ok: true, copied: [], removed: [], refused: [], kept: [] };
  const fetchValues = async (names) => {
    const values = new Map();
    for (const name of names.filter((n) => n.startsWith(OLD_PREFIX))) {
      values.set(name, await convex.get(name));
      const twin = twinOf(name);
      if (names.includes(twin)) values.set(twin, await convex.get(twin));
    }
    return values;
  };

  let names = await convex.names();
  if (!names.some((n) => n.startsWith(OLD_PREFIX))) {
    log(`Convex: no ${OLD_PREFIX}* variables, nothing to do.`);
    return result;
  }
  let values = await fetchValues(names);
  const plan = planEnv(names, values);
  const label = { same: 'already set, same value', differs: 'already set with a different value, kept (the new name wins)', empty: 'empty value, set it by hand', unreadable: 'could not be read' };
  for (const e of plan.entries) {
    log(`Convex: ${e.old} -> ${e.twin}: ${e.state === 'copy' ? (apply ? 'copying' : 'would set') : label[e.state]}`);
    if (e.state === 'differs') result.kept.push(e.old);
  }

  if (apply) {
    for (const old of plan.toCopy) {
      const twin = twinOf(old);
      const value = values.get(old);
      await convex.set(twin, value);
      if ((await convex.get(twin)) !== value) {
        result.ok = false;
        // The backend prefers the new name, so a wrong twin would take effect at once: take it back.
        await convex.remove(twin);
        log(`Convex: ${twin} differed from ${old} after setting it and was removed again. Nothing else was changed.`);
        return result;
      }
      result.copied.push(twin);
      values.set(twin, value);
      names = [...names, twin];
    }
    if (result.copied.length) log(`Convex: set ${result.copied.length} variable(s). Redeploy the backend so every function sees them.`);
  }

  if (!removeOld) {
    if (plan.toCopy.length + plan.toRemove.length) log(`Convex: ${OLD_PREFIX}* variables stay until you run this script with --remove-old (after a redeploy without "deprecated" warnings).`);
    return result;
  }

  // Decide on what is there now (after copying), not on what was planned.
  const after = planEnv(names, values);
  if (after.missingTwins.length) {
    result.ok = false;
    result.refused = after.missingTwins;
    log(`Convex: not removing anything, these have no ${NEW_PREFIX}* twin${apply ? '' : ' yet (run with --apply first)'}: ${after.missingTwins.join(', ')}`);
    return result;
  }
  for (const old of after.toRemove) {
    if (!apply) {
      log(`Convex: would remove ${old}`);
      continue;
    }
    await convex.remove(old);
    result.removed.push(old);
    log(`Convex: removed ${old}`);
  }
  if (apply) {
    const left = (await convex.names()).filter((n) => result.removed.includes(n));
    if (left.length) {
      result.ok = false;
      log(`Convex: still present after removing: ${left.join(', ')}`);
    }
  }
  if (after.differing.length) log(`Convex: kept because the values differ from their twins: ${after.differing.join(', ')}`);
  return result;
}

// ---------- Local files -------------------------------------------------------------------------------------

const xdg = (env, home, variable, fallback) => env[variable] || join(home, fallback);

/** Where the old and new per-user folders are. */
export function localPaths({ env = process.env, home = homedir() } = {}) {
  const config = xdg(env, home, 'XDG_CONFIG_HOME', '.config');
  const data = xdg(env, home, 'XDG_DATA_HOME', join('.local', 'share'));
  const state = xdg(env, home, 'XDG_STATE_HOME', join('.local', 'state'));
  const cache = xdg(env, home, 'XDG_CACHE_HOME', '.cache');
  return {
    configOld: join(config, 'xlr8'),
    configNew: join(config, 'selfbound'),
    units: join(config, 'systemd', 'user'),
    // Only reported, never touched.
    reportOnly: [
      { old: join(data, 'xlr8'), new: join(data, 'selfbound'), what: 'backups, Linear import data' },
      { old: join(home, 'xlr8-restore'), new: join(home, 'selfbound-restore'), what: 'restore test folder' },
      { old: join(state, 'xlr8-perf'), new: join(state, 'selfbound-perf'), what: 'idle performance state' },
      { old: join(cache, 'xlr8-perf'), new: join(cache, 'selfbound-perf'), what: 'performance worktrees (can simply be deleted, they are rebuilt)' },
    ],
  };
}

/**
 * Files of the old config folder and what would happen to each.
 * @returns {{ relative: string, from: string, to: string, mode: number, action: 'copy' | 'exists' | 'skip' }[]}
 */
export function planConfigFiles({ configOld, configNew }) {
  if (!existsSync(configOld)) return [];
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(configOld, rel), { withFileTypes: true })) {
      const relative = join(rel, entry.name);
      const from = join(configOld, relative);
      const to = join(configNew, relative);
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) out.push({ relative, from, to, mode: lstatSync(from).mode & 0o777, action: existsSync(to) ? 'exists' : 'copy' });
      else out.push({ relative, from, to, mode: 0, action: 'skip' });
    }
  };
  walk('');
  return out;
}

/** Copies the planned files. Never overwrites ('wx'), creates files with the final mode right away. */
export function applyConfigFiles(plan, configOld, configNew) {
  const dirMode = lstatSync(configOld).mode & 0o777;
  mkdirSync(configNew, { recursive: true, mode: dirMode });
  for (const f of plan.filter((p) => p.action === 'copy')) {
    mkdirSync(join(f.to, '..'), { recursive: true, mode: dirMode });
    writeFileSync(f.to, readFileSync(f.from), { flag: 'wx', mode: f.mode });
    chmodSync(f.to, f.mode);
  }
}

const modeText = (mode) => mode.toString(8).padStart(3, '0');

export function migrateLocalFiles({ paths, apply, log }) {
  const plan = planConfigFiles(paths);
  if (!existsSync(paths.configOld)) log(`Files: ${paths.configOld} does not exist, nothing to copy.`);
  for (const f of plan) {
    if (f.action === 'copy') log(`Files: ${apply ? 'copying' : 'would copy'} ${f.relative} (mode ${modeText(f.mode)})`);
    else if (f.action === 'exists') log(`Files: ${f.relative} already exists in ${paths.configNew}, left alone`);
    else log(`Files: ${f.relative} is not a regular file, skipped`);
  }
  if (apply && plan.some((p) => p.action === 'copy')) {
    applyConfigFiles(plan, paths.configOld, paths.configNew);
    log(`Files: the old folder ${paths.configOld} stays; delete it when you no longer need it. The tools prefer the new one.`);
  }
  for (const r of paths.reportOnly) {
    if (!existsSync(r.old)) continue;
    const clash = existsSync(r.new) ? ` (${r.new} exists already: merge by hand)` : '';
    log(`Files: ${r.old} exists (${r.what}); not touched. Move it yourself: mv ${r.old} ${r.new}${clash}`);
  }
  return plan;
}

// ---------- Things outside this repository ------------------------------------------------------------------

/** Vercel: nothing is read from the project's environment, so most setups have nothing to rename. */
export function vercelInstructions() {
  const names = ['VITE_XLR8_TEST', 'VITE_XLR8_BRANCH_PREFIX', 'XLR8_PUBLIC_URL', 'XLR8_BUILD_ID'];
  return [
    'Vercel: tooling/deploy-web.mjs builds on this machine and uploads the finished static files. The build',
    'values (SELFBOUND_PUBLIC_URL, VITE_SELFBOUND_BRANCH_PREFIX …) are set in the environment of that local',
    'build, so Vercel reads no build variables and normally nothing has to be renamed there. Check:',
    '  vercel env ls production --scope <your team>   (inside deploy/web/, where the project is linked)',
    `If one of ${names.join(', ')} (or any other XLR8_*) is listed from an older setup, rename it. Vercel cannot`,
    'rename and never prints values, so re-enter the value yourself:',
    ...names.flatMap((old) => [`  vercel env add ${old.replace('XLR8', 'SELFBOUND')} production      # then: vercel env rm ${old} production`]),
    'The Vercel project name (xlr8) stays; it is part of the project, not of the code.',
  ];
}

export function systemdInstructions({ units }) {
  const old = ['xlr8-perf-idle.timer', 'xlr8-perf-idle.service'].filter((u) => existsSync(join(units, u)));
  if (!old.length) return ['Systemd: no old performance units found.'];
  return [`Systemd: old units found (${old.join(', ')}). Run perf/idle/install.sh again: it installs selfbound-perf-idle.* and removes the old ones.`];
}

export const CHECKLIST = [
  'By hand (nothing here can be done from this repository):',
  '  [ ] Clerk dashboard: application name, logo and the texts of the e-mail templates (sign-in code, welcome) say Selfbound.',
  '  [ ] Convex dashboard: display names of team and project (the deployment name itself cannot change).',
  '  [ ] GitHub: no repository or environment secret is called XLR8_*; CONVEX_DEPLOY_KEY and AGE_RECIPIENTS keep their names.',
  '      Backup artifacts from before the change keep their old names (xlr8-backup-*) until they expire.',
  '  [ ] Shell profile, .envrc, systemd units or CI of your own that export XLR8_* variables: rename them to SELFBOUND_*.',
  '      Find them with: grep -ls XLR8_ ~/.profile ~/.bashrc ~/.zshrc ~/.config/fish/config.fish',
  '  [ ] Connectors (claude.ai, Claude Code, Codex): the address xlr8.kiumu.app and mcp.xlr8.kiumu.app stay as they are.',
];

// ---------- Command line ------------------------------------------------------------------------------------

export const HELP = `Usage: node tooling/migrate-legacy-names.mjs [--apply] [--remove-old] [--no-convex] [--no-files]

Moves an instance from the old name (XLR8) to Selfbound. Dry run unless --apply is given.

  --apply        do it: copy ~/.config/xlr8/* to ~/.config/selfbound/ and set SELFBOUND_* twins of
                 the XLR8_* variables in the production Convex deployment (never overwrites, never deletes)
  --remove-old   also remove the XLR8_* Convex variables whose SELFBOUND_* twin has the same value;
                 refuses if an old variable has no twin. Run it once the new code has been deployed
                 and no "deprecated" warning appears in the logs anymore
  --no-convex    skip the Convex part (no deploy key needed)
  --no-files     skip the local files
  --help         this text

Values of variables are never printed. Everything outside this repository (Vercel, dashboards, GitHub)
is listed at the end as a checklist.`;

export function parseArgs(argv) {
  const known = ['--apply', '--remove-old', '--no-convex', '--no-files', '--help', '-h'];
  const unknown = argv.filter((a) => !known.includes(a));
  return {
    apply: argv.includes('--apply'),
    removeOld: argv.includes('--remove-old'),
    convex: !argv.includes('--no-convex'),
    files: !argv.includes('--no-files'),
    help: argv.includes('--help') || argv.includes('-h'),
    unknown,
  };
}

/**
 * @param {string[]} argv
 * @param {{ run?: (args: string[]) => Promise<{ status: number, stdout: string }>, env?: NodeJS.ProcessEnv, home?: string, log?: (line: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { run, env = process.env, home = homedir(), log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return 0;
  }
  if (args.unknown.length) {
    log(`Unknown argument: ${args.unknown.join(' ')}\n\n${HELP}`);
    return 2;
  }
  let code = 0;
  log(args.apply ? 'Applying.' : 'Dry run, nothing changes. Add --apply to do it.');
  const paths = localPaths({ env, home });

  if (args.files) migrateLocalFiles({ paths, apply: args.apply, log });

  if (args.convex) {
    let runner = run;
    // Imported late: tooling/cloud.mjs reads the instance settings, which --help does not need.
    const keyFile = runner ? undefined : (await import('./cloud.mjs')).deployKeyFile(env);
    if (keyFile && !existsSync(keyFile)) log(`Convex: skipped, no deploy key at ${keyFile} (see docs/operations.md).`);
    else {
      try {
        runner ??= await cloudRunner();
        const result = await migrateConvexEnv({ convex: convexEnv(runner), apply: args.apply, removeOld: args.removeOld, log });
        if (!result.ok) code = 1;
      } catch (error) {
        log(`Convex: ${error instanceof Error ? error.message : 'failed'}`);
        code = 1;
      }
    }
  }

  log('');
  for (const line of [...vercelInstructions(), ...systemdInstructions(paths), '', ...CHECKLIST]) log(line);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

# Performance regression tests (`@selfbound/perf`)

Measures the real app (`app/` + `core/`) in a browser against its own local Convex backend and checks a fixed latency budget. Selfbound is meant to answer every key press within the next frame or two, even with 10,000 issues; this harness keeps it that way.

## Quick reference

```bash
node perf/run.ts --quick     # about 2–3 minutes: only P1 · 10,000 issues, few repetitions (also in CI)
node perf/run.ts --full      # about 22 minutes: P1/P2 × 10,000/440 issues, idle machine only
node perf/ab.ts --a=main --b=. -- --full --cells=P1-large --only=starts,interactions   # A/B in alternation
node perf/mobile.ts          # phone: 412 px, touch, CPU 4× and 6×, network like P2 (about 16 minutes)
node perf/idle.ts status     # state of the optional idle runs
node perf/record.ts          # walkthrough video (~40 s) with captions
```

Results go to `perf/results/` (gitignored). Which run to use when is described under [When to measure](#when-to-measure). In short: a normal change needs no local performance run; CI measures every push.

## When to measure

A performance run is only meaningful on an idle machine, and an idle machine is rare. So measuring "before and after" during every change does not work. Measuring is split into tiers instead, and no tier makes anyone wait.

| Tier | When | What | Who triggers it | Duration, load |
|---|---|---|---|---|
| 1. Change | every change | no performance run. Run builds and tests through `tooling/quiet.sh` so they stay off the cores you work on. In the PR, note which hot paths are touched (list and rows, store and sync, startup and initial bundle, keyboard, sidebar) and look at the CI values | the author | minutes |
| 2. CI | every push to a PR and to main | quick run `--quick`: p95 < 250 ms per core action, scrolling, initial bundle and DOM nodes of the list at most 5 % above the baseline (load-independent, catches small regressions too) | GitHub Actions | about 3 minutes on the runner |
| 3. Idle (optional) | when the maintainer's machine is idle | full run of main after each new commit, compared with the baseline and the previous main run; PRs labelled `tempo` in alternation with main, result as a PR comment | `perf/idle.ts` (manually or as a timer) | 22 minutes per main run, about 30 minutes per PR (two pairs) |
| 4. Occasionally | about monthly, before large refactors, for a new baseline | full run, phone measurement (`mobile.ts`), deliberately renew the baseline | the maintainer | about an hour, idle machine |

**How a regression shows up without anyone waiting:** coarse regressions, a grown initial bundle or more DOM nodes make CI fail on the PR. Finer ones show up in idle runs: if main is worse than the baseline or the previous run after a merge, `idle.ts` first measures again in alternation (before vs. after, two pairs). Only if that confirms the regression does it open a GitHub issue with the label `tempo` and send a desktop notification.

**Targeted measurements**, when a change is itself about performance: use `perf/ab.ts` instead of your own loops (see below), and only on an idle machine.

### Idle runs (`perf/idle.ts`, optional)

`idle.ts` is a helper for maintainers who want regular full runs on their own Linux machine without babysitting them. A pass only starts when the machine looks free (`node perf/idle.ts check`): inside the time window (default 01:00–08:00), no game running (Steam/Proton, Gamescope, Lutris, Heroic), GPU utilization below 40 % (`nvidia-smi`, skipped without it), load below 4, no other performance run. A watchdog keeps checking every 30 seconds and aborts the run (values discarded) when the machine gets busy. Every run has a hard time limit (full 60, A/B 120 minutes), a pass at most 150 minutes. Thresholds come from `XLR8_PERF_WINDOW`, `XLR8_PERF_MAX_LOAD`, `XLR8_PERF_MAX_GPU`, `XLR8_PERF_MINUTES`; state and log live in `~/.local/state/xlr8-perf/` (`XLR8_PERF_STATE`).

`perf/idle/install.sh` installs it as a systemd user timer (every 30 minutes) with a separate worktree of main under `~/.cache/xlr8-perf/main`; `perf/idle/install.sh --remove` removes it. Without the timer, `node perf/idle.ts run --now` runs one pass right away. PR comments and issues use the GitHub CLI (`gh`).

### Keeping load in check

- Only one performance run at a time (machine-wide lock in `$XDG_RUNTIME_DIR/xlr8-perf.lock`); a second one exits immediately with a hint.
- On machines with at least 16 threads, the browser runs on cores 0–7, backend and preview on 8–15 (`taskset`; `--no-pin` turns this off).
- Builds and tests outside of performance runs: `tooling/quiet.sh <command>` (see the script for the CPU set and limits).

## Setup

Everything starts and stops by itself: its own local Convex (anonymous, no account, data in `perf/.backend/`), two builds of the app (`perf/.dist/p1`, `perf/.dist/p2`), `vite preview` and the latency proxy. `app/.env.local` and your development backend stay untouched.

| Port | Purpose |
|---|---|
| 13520 / 13521 | Convex of the run (queries, mutations / HTTP actions, MCP) |
| 5522 | `vite preview` (one build at a time) |
| 13590 → 13520 | proxy for the Convex WebSocket in profile P2 |
| 5592 → 5522 | proxy for the page in profile P2 |

Other ports (e.g. for a second worktree) via the environment; the defaults stay as above: `XLR8_PERF_CONVEX_PORT` (HTTP actions one higher), `XLR8_PERF_PREVIEW_PORT`, `XLR8_PERF_PROXY_CONVEX_PORT`, `XLR8_PERF_PROXY_PAGE_PORT`, e.g. `XLR8_PERF_CONVEX_PORT=13550 XLR8_PERF_PREVIEW_PORT=5552 XLR8_PERF_PROXY_CONVEX_PORT=13595 XLR8_PERF_PROXY_PAGE_PORT=5595 node perf/run.ts --quick`.

## What is measured

**Profiles:** **P1 local** (direct, CPU 1×) and **P2 remote** (own TCP proxy, +50 ms per direction for page and WebSocket, CPU throttled 4×). The Convex address is baked into the build, hence two builds; the run switches `vite preview` between them.

**Data:** the seeder from `backend/data/generate.ts` via `tooling/local.mjs --seed`: `large` (10,000 issues) and `small` (440). By default every data set gets a fresh, empty backend (deleting and re-seeding 10,000 issues occasionally hits Convex limits). Whatever the run changes (status, priority, triage, created issues) is reset or moved to the trash afterwards.

**Method** (`perf/probe.ts`): from the timestamp of the input event (`keydown`/`pointerdown`) until after the next frame in which a check sees the result in the DOM. A random offset of 0–17 ms before every measurement. "DOM done" is the same measurement without waiting for the frame. A fresh browser per round; full: 2 rounds × (5 warm-up + 15 measurements) = 30 values per action, quick: 1 × (1 + 3). Median, p95, optionally a bootstrap 95 % interval of the median (`--bootstrap`).

**Actions** (P1 and P2 with 10,000 issues; with 440 only filter and search):

| Metric | Steps | Done when |
|---|---|---|
| `focus.next (J)`, `focus.prev (K)` | key | another row focused |
| `peek.open (Space)` (`:content`) | Space | peek title (and description) there |
| `peek.next (↓)` | ↓ in peek | different title |
| `inbox.next (J)`, `inbox.prev (K)` (`:content`) | inbox (G I), Space opens the split view, J/K | identifier of the shown issue changed (and description there) |
| `detail.open (Enter)` (`:content`), `detail.close (Esc)` | Enter / Esc | detail title (and description) / list with focus |
| `picker.open (S)`, `status.set (Enter)`, `priority.set (Enter)` | S, "prog", Enter etc. | row has the new value |
| `save.confirmed (key → server confirmed)`, `save.painted (key → confirmed visible)` | as `status.set` | server confirmed (`__selfbound.saves`) |
| `bulk50.status (Enter)` | X, 49× ⇧↓, Ctrl K "status: …" | all selected rows changed |
| `palette.open (Ctrl+K)`, `palette.key` | Ctrl K, "status" per key | entries in the DOM = state |
| `search.key`, `search.id (identifier)` | `/` + search word per key; `/` + identifier | hits in the DOM = state; the issue on top |
| `quicksearch.key`, `quicksearch.clear` | Ctrl F + search word; Esc | every visible row matches, count correct |
| `filter.apply`, `filter.remove (click)` | F "high" Enter; click on × | chip there and count changed; chip gone |
| `nav.backlog (G B)`, `nav.all (G A)`, `nav.triage (G T)`, `nav.sprint (G S)` | G sequences | view title and rows there |
| `click.row (opens issue)`, `click.status (picker)` | mouse click | detail / status picker |
| `nav.team (click)` | click on a team card in the sidebar, alternating between two teams | view "Active" with the team's rows |
| `layout.board (Ctrl+B)`, `board.column (→)`, `board.move (Shift →)`, `layout.list (Ctrl+B)` | board and back | focused card / card in another column / focused row |
| `wiki.page (click in tree)` | click on a page in the knowledge tree | page title and text there |
| `create.submit (Ctrl+Enter)` (`:confirmed`) | C, title, Ctrl Enter | row with the title visible (and with an identifier from the server) |
| `comment.send (Ctrl+Enter)` (`:confirmed`) | detail, comment, Ctrl Enter | comment visible (and no longer pending) |
| `triage.accept (1, Enter)` | triage, 1, "todo", Enter | row gone from triage |
| `agent.change (server → row)` | mutation from Node | row shows the new priority |
| `agent.mcp (MCP call → row)` | real agent over MCP `set_status` | row shows the new status |

**Start:** cold (fresh browser context, empty cache and IndexedDB) and warm (reload): shell (sidebar), first paint, list, all buckets synced (`selfbound-synced`), list from the mirror (`selfbound-cache`), transferred bytes. Full 20×, quick 3×.
**Scrolling:** 3 s at an even 4,800 px/s through `/all` (grouped), CPU 1× and 4×: share of frames over 25 ms, p95 frame interval, long animation frames.
**Memory:** JS heap and DOM nodes after loading and after opening/closing the detail 20×.
**Initial bundle:** brotli size of everything `index.html` loads at start (`perf/bundle.ts`, same rule as `tooling/bundle-size.mjs`).

## Budget and exit code

| Rule | full | `--quick` |
|---|---|---|
| p95 of every core action, P1 · 10,000 issues, no timeout | < 100 ms | < 250 ms |
| Scrolling (CPU 1× and 4×): frames over 25 ms, worst repetition | 0 % | ≤ 5 % at CPU 1×; CPU 4× only a note (CI runners without a GPU cannot do it throttled) |
| Cold start P2 · 10,000 issues: list visible, p95 | < 2 s | not measured |
| Initial bundle (brotli) and DOM nodes of the loaded list, P1 · 10,000 issues, vs. the baseline | ≤ +5 % | ≤ +5 % |

Core actions are all main metrics in the table above except `save.*`, `agent.*` and the sub-metrics (`:content`, `:confirmed`). Exit code 0 = met, 1 = violated, 2 = run aborted. `--no-budget` always returns 0. If a run does not check every rule (e.g. `--cells=P1-large` without the P2 cold start, or the quick run), the report says "met as far as checked (n rules skipped)" instead of "met"; `summary.json` has `budget.complete` for this.

Initial bundle and DOM nodes do not depend on load: a CI runner and a desktop PC get the same values (DOM nodes 1,869 vs. 1,868). That is why the quick run uses the same tight limit for them as the full run. The bytes transferred on cold start (`cold.bytes`) are no good for this: in CI they varied between about 200 and 300 kB depending on which lazily loaded chunks were already fetched.

The generous threshold in the quick run is meant for shared CI runners: it catches coarse regressions (such as an action that suddenly rebuilds the whole list), not a few milliseconds.

**Cold start failure:** if the list or "all buckets synced" does not arrive within 30 s, the run counts `cold.failed` and violates the budget. It also prints which buckets are missing in the store, which errors the page reported, whether the rest still arrives within 60 s, and the last lines of the backend log (in CI also as the artifact `perf-quick`). The store re-subscribes a failed bucket query, which fixed the first such failure (a bucket query hitting the server's 1 s limit on a slow runner).

## Baseline

`perf/baseline.json` holds the medians of a full run on the maintainer's machine. Every report compares against it and **warns** (no failure) when a median is more than 25 % and at least 2 ms (or 0.5 MB, 1 kB, 0.5 percentage points) worse. A note appears when the CPU differs.

Set or renew the baseline after a full run on an idle machine:

```bash
node perf/run.ts --full
node perf/report.ts perf/results/<run> --update-baseline
git add perf/baseline.json
```

Renew the baseline only deliberately, e.g. when a slowdown is explained and accepted (give the reason in the commit). A baseline from a quick run or from a busy machine is worthless.

The load-independent sizes are the exception. If the initial bundle or the list grows on purpose (a new feature), a PR may update them from any run, including the CI quick run (artifact `perf-quick`) or a local `--quick`:

```bash
node perf/report.ts perf/results/<run> --update-sizes   # only bundle.*, *.bytes and memory.domNodes
```

## Results

`perf/results/<timestamp>/` (UTC): `environment.json`, `samples.json` (raw values), `summary.md` (budget, baseline comparison, tables per area and all metrics per cell) and `summary.json`. The folder is gitignored; CI uploads it as the artifact `perf-quick`. Rebuild a report: `node perf/report.ts perf/results/<run> [--bootstrap]`.

More switches of `run.ts`: `--only=starts,interactions,scroll,memory`, `--cells=P1-large,P2-large,P1-small`, `--reuse-data` (reuse backend and data), `--skip-build`, `--keep` (keep the backend running; stop it with `node perf/run.ts --stop`), `--no-pin`, `--visible`, `--out=<folder>`.

## Comparing two revisions (`ab.ts`)

```bash
node perf/ab.ts --a=main --b=. -- --full --cells=P1-large --only=starts,interactions
node perf/ab.ts --a=58d7f07 --b=f6c765b --pairs=3 -- --full --cells=P1-large --only=starts
node perf/ab.ts --report=perf/results/ab-<timestamp>     # only recompute the evaluation
```

- Every revision runs in its own worktree with its own `perf/run.ts` and backend. `ab.ts` creates worktrees of other revisions under `~/.cache/xlr8-perf/refs/<commit>` (`XLR8_PERF_REFS`). Not under `/tmp`: that is often tmpfs, where the measurement backend writes about 10 ms faster. `--b=.` is this worktree including local changes.
- Order A B B A A B …, so a disturbance hits both sides equally. After the first run per side, no new build.
- If a run aborts (exit 2 or no `summary.md`), `ab.ts` repeats it once. The reason is in the run's `aborted.md` and `run.log`. If it aborts again, `ab.ts` ends with exit 2.
- Result `perf/results/<name>/ab.md`: per metric the medians of A and B, the difference with a bootstrap 95 % interval (resampled within each run) and the medians of the individual runs. **slower** or **faster** only counts if the interval excludes 0, the gap is at least 1 ms and every run of one side lies above every run of the other. Without the last condition it says "likely slower": that is variation between runs, not a finding.
- `--max-load=N` waits before each run until the load is below N (at most 15 minutes).
- Both sides must use the same metric names; revisions from before the metric names were translated to English cannot be compared with newer ones.

Duration per run (desktop PC, 2026): `--cells=P1-large --only=starts` about 3 minutes, `--only=interactions` about 4, both about 7, full 22. An A/B with two pairs takes four times as long. If you run it from a tool with command timeouts (CI step, coding agent), set the timeout to at least twice the expected duration.

## Phone (`mobile.ts`)

Pixel 7 viewport (412 × 915 px, touch, device pixel ratio 2.625), build and network like P2 (+50 ms per direction), CPU throttled 4× and 6×. A mid-range Android lies roughly in between. Measured as in `run.ts` from the input event until after the frame with the result, tapped with real touch events:

| Metric | Steps | Done when |
|---|---|---|
| `cold.*`, `warm.*` | cold and warm start, 8× each | first paint, list, all buckets synced |
| `tap.row (open issue)` | tap a row | issue title there |
| `tap.status (picker in issue)` | tap the status chip in the issue | picker with entries |
| `tap.back (back to list)` | back | list there, issue gone |
| `tap.menu (open drawer)`, `tap.scrim (close drawer)` | tap "More", tap beside the drawer | drawer open / closed |
| `tap.team (switch team in drawer)` | tap a team in the drawer | drawer closed, the team's list |
| `scroll.*` | 3 s at 2,400 px/s | frames over 25 ms, p95 frame interval |
| `memory.*` | after the walkthrough | JS heap, DOM nodes |

No budget, no exit code for limits: this measurement belongs to tier 4.

## Avoiding aborted runs

- **Shared ports:** `tooling/local.mjs` accepts any backend that answers on its port. So the run refuses foreign processes on its ports with a clear message (PID and folder) instead of using them or waiting for a timeout, and finds and stops its own stale backend via the port even without a PID file.
- **First upload into a fresh backend** occasionally fails ("BadAdminKey", environment changed meanwhile): `stack.ts` retries the start once with an empty backend.
- **Shell loops:** use `ab.ts` instead of your own loops. Avoid `pkill -f`/`pgrep -f` with a pattern from your own command line (it kills or waits on your own shell); stop runs with `node perf/run.ts --stop`.
- **Silent failures:** on abort, `run.ts` writes `aborted.md` with the reason; `ab.ts` treats a missing report as an abort.

## Walkthrough video

`node perf/record.ts` seeds `small` into a fresh backend, records P1 at 1440×900 (list, J/K, peek, status, filter, command menu, create, detail with comment, triage, sprint, briefly the phone view), adds a caption per step (ffmpeg `drawtext`, font via `fc-match`) and writes `/tmp/selfbound-media/walkthrough.mp4`; `--out=<file.mp4>` copies it elsewhere. `--encode-only` only redoes captions and encoding.

## Limits

- **Measurement build:** what is measured is `vite build` with `VITE_XLR8_TEST=1`, otherwise like production. Only that build has the measurement hooks (`globalThis.__selfbound`: save confirmations, state for the search checks). Cost: one more entry in the command menu and one array per save, not measurable.
- **A fast desktop PC, headless Chromium.** P2 imitates a weak laptop via CPU throttling. Absolute times in a regular desktop Chrome can differ by a few milliseconds.
- **Convex runs locally**, not in the cloud. The proxy delay roughly matches a transatlantic connection. "Agent" mutations go from Node directly to the backend (without the proxy); only the path to the browser is delayed.
- **Sprint:** `G S` on `/sprint` measures the current sprint as a list. If the sprint page changes, adjust the check in `viewShown`.
- **The video is for watching, not measuring.** Recording costs time itself.
- A long-running test over hours (memory leaks) is still missing.

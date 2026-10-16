# Design decisions

Decisions that shape Selfbound and look like gaps if you do not know the reason. Each entry says what was
decided, why, and where it shows up. To change one, change the entry in the same pull request.

## One user, no assignees

**Decided:** Selfbound is built exclusively for solo developers and their AI agents. An instance has one
owner. There are no assignees, no roles, no invitations and no per-user permissions.

**Why:** Every feature that exists for groups (assignment, workload, notifications about other people,
permissions) costs speed and screen space for the one person who never needs it. Leaving them out is
what keeps the interface small and fast.

**Shows up as:** no assignee field in the data model, MCP and Linear import (`import.md` drops it); the
MCP filter `assigned` means "all open issues outside triage" (`mcp.md`); self-hosting configures one owner
(`self-hosting.md`). AI agents act next to the owner with their own named keys, not as extra users.

## Teams are areas, not groups of people

**Decided:** A *team* in Selfbound is a workspace or area of work, like a team in Linear: it has its own key
(`KIU-106`), statuses, labels, projects and knowledge pages. It is not a group of people.

**Why:** One person works in several areas (products, clients, private projects) and wants separate
identifiers and workflows for them. The word comes from Linear so that imports and habits carry over.

**Shows up as:** team keys in identifiers, statuses per team, a team's dormant and knowledge-only modes
(`backend.md`).

## One sprint for all teams

**Decided:** At most one sprint is active at a time, and it spans all teams. There is no sprint per
team. (Steven, 2026-10-13)

**Why:** A solo developer has one week and one capacity. Per-team sprints would split a single
person's time into separate plans that can only be compared by hand, and would ask for a capacity per
team that does not exist.

**Shows up as:** `sprintId` on every issue regardless of team; at most one `active` sprint as a backend
rule; capacity suggested from the points done in the last closed sprints across all teams; team cards in
the sidebar that show how much of the one sprint a team contributes (`backend.md`, `frontend.md`).

**Not a bug:** a team without issues in the sprint is normal, and "sprint per team" is a deliberate
non-goal. Revisit only if Selfbound ever supports more than one person.

## Contributions are issue-first

**Decided:** Outside contributors open an issue first, the maintainer approves it with the label
`accepted`, and only then comes a pull request. Pull requests from non-collaborators without such an issue
are closed automatically with a friendly note.

**Why:** Selfbound is maintained by one person, and a design that stays small is more important than the
number of features. Agreeing on the idea before the code saves contributors from writing something that
cannot be merged.

**Shows up as:** `CONTRIBUTING.md`, the issue forms and the pull request template, and the workflow
`.github/workflows/pr-policy.yml`.

## The product is called Selfbound; stored names stay XLR8

**Decided:** The product was renamed from XLR8 to Selfbound on 2026-10-14. Packages are `@selfbound/*`,
the landing page is `selfbound.kiumu.app` and the docs are `docs.selfbound.kiumu.app` (Vercel projects
`selfbound-landing` and `selfbound-docs`; the old `getxlr8.app` addresses redirect permanently). Names
that are stored or cross deploy versions keep their XLR8 spelling until they are migrated.

**Why:** XLR8 collides with existing trademarks, and the name should not become part of more public
material. Renaming stored names would need data migrations and would break connected MCP clients, signed-in
browsers and the running instance, so it is done separately and only where it pays off.

**Shows up as:** unchanged: `XLR8_*` environment variables, Convex tables, fields, function names and HTTP
routes, MCP tool names and parameters, token prefixes (`xlr8_rt_`, `xlr8_ac_`, `xlr8_`), browser storage
keys and the cookie `xlr8_signed_in`, the team key `XLR8` with identifiers like `XLR8-48` and branch names
built from them, the instance `xlr8.kiumu.app`, the MCP address `mcp.xlr8.kiumu.app`, the Vercel project
`xlr8` of the app. The repository was renamed to `hernstev97/selfbound` the same day (GitHub redirects the old
address). Historical reports under `docs/reports/` and
`docs/brand.md` describe the past and stay as they are.

Superseded in part on 2026-10-15: see the next entry.

## The remaining XLR8 names move to Selfbound, with fallbacks

**Decided (2026-10-15):** Everything an operator or user can see that still said XLR8 gets the Selfbound name:
the environment variables (`XLR8_*` to `SELFBOUND_*`, `VITE_XLR8_*` to `VITE_SELFBOUND_*`), the per-user directories
(`~/.config/xlr8` and the data, state and cache directories), the systemd units and backup artifacts, the browser storage
(`xlr8:*` keys, IndexedDB name, the cookie `xlr8_signed_in`, service worker messages, drag type, `history.state` key), the
token and key prefixes (`xlr8_`, `xlr8_at_`, `xlr8_rt_`, `xlr8_ac_`, `xlr8_cs_`), the OAuth client id prefix and scope, the stored
actor kind `steven` (now `owner`), the sprint source `xlr8` (now `selfbound`) and the MCP field `reviewedBySteven` (now
`reviewedByOwner`). Table names, field names, function names, HTTP routes, MCP tool names and parameters stay as they are.
Intentional exceptions: the team key `XLR8` with its issue identifiers, the maintainer's instance address and MCP address, and the
Vercel project name `xlr8`.

**Why:** The first rename (above) left names behind that new operators meet on day one: every setup guide told them to set
`XLR8_OWNER_IDS`. Waiting longer would make the public documentation and the running instances drift further apart.

**What is accepted as fallback (marked `legacy-xlr8` in the code):** old environment variable names (one warning per variable
and process, never the value), the old directories (used while only they exist, with a warning), old key, token and client id
prefixes and the old scope, the stored values `steven` and `xlr8` and the field `reviewedBySteven`, the old browser names (storage
keys are copied once at startup, the cookie, message types, drag type and `history.state` key are accepted), and old backup names.
Existing agent keys, connectors, signed-in browsers and the running instance keep working without any change. New writes use only
the new names. Why not rewrite keys and tokens: only their hash is stored, and a changed prefix would lock every connected agent out.

**How an instance moves:** deploy the code, run `tooling/migrate-legacy-names.mjs` (settings and files) and
`tooling/migrate-legacy-data.mjs` (stored values), then do the manual steps outside the repository. Steps and tables:
[Moving from the XLR8 names](operations.md#moving-from-the-xlr8-names).

**Removal plan:** a follow-up issue removes the fallbacks after the data check reports zero legacy rows and the Convex log has
shown no deprecation warning for two weeks. Key and token prefixes go last, after old keys were replaced. Until then every
fallback carries the word `legacy-xlr8` in the code, so `grep -ri legacy-xlr8` finds all of them.

**Shows up as:** `backend/convex/lib/legacyEnv.ts`, `tooling/lib/env.mjs`, `core/src/legacyStorage.ts`,
`backend/convex/legacyNames.ts`, the two migration scripts, and the upgrade guide in the docs site
(`start/self-hosting/upgrade-from-xlr8`).

## Team keys can be renamed; old keys stay with the team

**Decided (2026-10-16, XLR8-72):** The key of a team with issues can be renamed in the team settings, after a confirmation. A team that has ever had issues
(team counter above zero, so also after all of them moved out) keeps its old key; a team that never had any frees it.
The old key goes into `teams.previousKeys` and stays reserved for that team: no other team can take it, and identifiers
with it (`OLD-12`) resolve to the issue with the same number everywhere: links and bookmarks (redirected to the current
identifier), mentions in texts with their status chips, search and the command menu, MCP (identifiers and `team`
arguments), the GitHub webhook (branch names, titles, descriptions), knowledge page links, the Linear import (adopting
a team by its old key). The team may take an old key back. Texts are not rewritten; mentions are shown with the current
key (SELF-102): a typed `XLR8-72` reads `SELF-72` with its status chip, the tooltip names the typed form, renaming back
restores it. Display only: stored text, versions, MCP output and search keep the typed form. Not done: moved issues
(`BOX-3` showing `BEAR-32`), a one-off rewrite of existing texts (after the backup, SELF-13), normalizing on save.

**Why:** Keys outlive their names (the team key `XLR8` of the Selfbound team). Blocking renames forever made a stale key
permanent; rewriting identifiers in texts would change what people and agents wrote. One reserved key per rename costs
one document write instead of one alias row per issue (`identifierAliases`), so a team with 10,000 issues renames in one
transaction. `OLD-12` means whatever `NEW-12` means, exactly as if the key had always been `NEW` (numbers are handed out
once per team; only the Linear import can give a number to another issue, and then the current key follows it too).

**Not covered:** identifiers outside Selfbound (commit messages, other tools) keep the old key; they still resolve when
they reach Selfbound. Push notifications already delivered keep their old links (they redirect).

**Shows up as:** `teams.previousKeys`, `lib/identifiers.ts` (`resolveIssue`, `teamByKey`), `ops/teams.ts`
(`assertKeyFree`), `core/src/store.ts` (`renamedKeys`), `core/src/route.ts` (`withCurrentTeamKeys`), and "Rename the key"
in the docs site (`docs-site/src/content/docs/concepts/teams.mdx`).

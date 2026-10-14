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
`xlr8` of the app and the repository `hernstev97/xlr8`. Historical reports under `docs/reports/` and
`docs/brand.md` describe the past and stay as they are.

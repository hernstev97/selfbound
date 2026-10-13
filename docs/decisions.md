# Design decisions

Decisions that shape XLR8 and look like gaps if you do not know the reason. Each entry says what was
decided, why, and where it shows up. To change one, change the entry in the same pull request.

## One user, no assignees

**Decided:** XLR8 is built exclusively for solo developers and their AI agents. An instance has one
owner. There are no assignees, no roles, no invitations and no per-user permissions.

**Why:** Every feature that exists for groups (assignment, workload, notifications about other people,
permissions) costs speed and screen space for the one person who never needs it. Leaving them out is
what keeps the interface small and fast.

**Shows up as:** no assignee field in the data model, MCP and Linear import (`import.md` drops it); the
MCP filter `assigned` means "all open issues outside triage" (`mcp.md`); self-hosting configures one owner
(`self-hosting.md`). AI agents act next to the owner with their own named keys, not as extra users.

## Teams are areas, not groups of people

**Decided:** A *team* in XLR8 is a workspace or area of work, like a team in Linear: it has its own key
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
non-goal. Revisit only if XLR8 ever supports more than one person.

## Contributions are issue-first

**Decided:** Outside contributors open an issue first, the maintainer approves it with the label
`accepted`, and only then comes a pull request. Pull requests from non-collaborators without such an issue
are closed automatically with a friendly note.

**Why:** XLR8 is maintained by one person, and a design that stays small is more important than the
number of features. Agreeing on the idea before the code saves contributors from writing something that
cannot be merged.

**Shows up as:** `CONTRIBUTING.md`, the issue forms and the pull request template, and the workflow
`.github/workflows/pr-policy.yml`.

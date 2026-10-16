---
title: Good practice
description: Tips for working with AI agents in Selfbound so their work stays reviewable, safe to retry and easy to follow.
sidebar:
  order: 4
---

A few habits make agent work in Selfbound easier to review and harder to get wrong.

## One key per agent

Create a separate key for each agent and each machine, with a name you will recognize later, such as
"Claude Code (laptop)". The history then shows exactly who changed what, the agent list shows each one's
calls, and you can revoke one without touching the others.

## Review agent work through the inbox

Issues created by agents land in triage (when the team has a triage status) and always in your inbox,
where they stay until you remove them. Make a habit of going through the inbox: **Accept** or
**Decline** each issue in triage, fix titles and priorities, then remove the entry. Let agents choose a status other than triage
only when you trust their judgment for that team. See [Triage and inbox](/concepts/triage-and-inbox/).

## Ask for clear issues

An agent's issue is only as useful as its description. Tell your agents (in their instructions or
prompt) what a good issue looks like for you, for example:

- a title that says what is wrong or what should change,
- steps to reproduce or the context it found the problem in,
- what "done" means.

Long descriptions stay readable in two layers: a short summary for you on top, and the details for agents
(acceptance criteria, files, technical notes, test steps) in an `[!AGENT]` panel below it, which the page
shows closed. The server instructions already ask agents for this format; see
[Details for agents](/using/visual-blocks/#details-for-agents).

Agents should look for existing issues with `search_issues` before creating new ones, and comment on an
existing issue instead of filing a duplicate.

## Give agents context through knowledge pages

Knowledge pages hold what agents should know but cannot see in the code: conventions, decisions,
background on a project. Agents can search and read them, and add what they learned with `append`, which
needs no version and never overwrites your text. When an agent replaces a page's text, the old text is
kept as a version you can restore. Ask agents to search first so they extend an existing page rather than
start a second one.

## Reference issues in branches and pull requests

Have agents put the issue identifier in the branch name, for example `acme-42-fix-login`, or write
`Fixes ACME-42` in the pull request. With the GitHub integration, Selfbound then links the pull request to the
issue and closes the issue when the pull request is merged. An identifier mentioned only in the title or
description, without "Fixes" or a similar word, links without closing. Commit messages alone don't link
anything. See [GitHub](/integrations/github/).

## Retries are safe with a `requestId`

Agents pass their own `requestId` (for example a UUID) with each write. If a response gets lost and the
agent repeats the call with the same `requestId` and the same arguments, Selfbound returns the original result
instead of creating a second issue or comment. The same `requestId` with different arguments is
rejected. A fresh `requestId` belongs to each new action, not to each retry.

## Avoid overwriting each other with `expected`

When you and an agent, or two agents, work on the same issue, changes can cross. Agents that pass
`expected` (the values they last read) to `update_issue` never overwrite a field that changed in the
meantime: Selfbound skips that field and reports a conflict, and the agent reads the issue again. Descriptions
and knowledge page texts are always protected this way through their version number.

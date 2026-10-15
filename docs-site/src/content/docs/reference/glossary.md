---
title: Glossary
description: Short definitions of the terms Selfbound uses in the app and in these docs.
sidebar:
  order: 3
---

The words Selfbound uses, in alphabetical order. Each entry links to the page that explains more.

## Agent

An AI tool that reads and changes your issues through [MCP](#mcp): a coding agent like Claude Code or Codex with its own API key, or a chat app connected as a [connector](#connector). Issues an agent creates land in your [inbox](#inbox), and everything it changes shows up in the issue history under the agent's name. See [Connect an agent](/agents/connect/).

## Command menu

The searchable list of every action, opened with Ctrl K (⌘ K on a Mac). Type a few letters of what you want to do, a value such as a status name, or an issue identifier. See [Keyboard shortcuts](/reference/keyboard-shortcuts/).

## Connector

A chat app, claude.ai or ChatGPT, connected to Selfbound by signing in rather than with an API key. You start the connection under **Settings → Agents → Connect connector** and approve it on the Selfbound consent page. A connector counts as an [agent](#agent).

## Dormant team

A team you are not actively working in. It moves to the **Inactive** section of the sidebar and is left out of sprint planning. Its issues stay as they are. See [Teams](/concepts/teams/).

## Identifier

The short, readable ID of an issue: the [team key](#team-key), a hyphen and a number, such as `ACME-42`. Numbers count up per team. You can search for an identifier, and agents use it to refer to issues.

## Inbox

The place where issues created by [agents](#agent) wait for you, and issues shared to Selfbound from other apps on your phone. An entry stays until you remove it; removing it takes it out of the inbox but leaves the issue unchanged. Entries you have opened count as read.

## Instance

One installation of Selfbound: its own Convex backend, its own Clerk sign-in and its own web address. Every instance belongs to exactly one [owner](#owner). See [Self-hosting](/start/self-hosting/).

## Knowledge page

A page in a team's knowledge area: notes and documentation written in Markdown, arranged in a tree and linked with issues. A team can have knowledge pages alongside its issues, or be a knowledge-only team without issues.

## Label group

A set of related labels, such as "Type" with Bug and Feature. A group can be single choice, so an issue carries at most one label from it. See [Labels](/concepts/labels/).

## MCP

The Model Context Protocol, an open standard that lets AI tools call functions in other programs. Selfbound's backend offers an MCP endpoint with tools such as `search_issues`, `create_issues` and `set_status`. [Agents](#agent) use it to work with your issues.

## Owner

The one person who can sign in to an [instance](#instance). The backend only lets in the Clerk accounts listed in the `SELFBOUND_OWNER_IDS` setting. There are no other user accounts; [agents](#agent) get access through keys or connectors that the owner creates.

## Peek

A floating preview of the focused issue in a list, without leaving the list. Press Space to open or close it; hold Space and it closes again when you let go.

## Project

A larger piece of work that groups issues, such as a release or a feature. Every project belongs to exactly one team and has a status: planned, active, paused and so on.

## Sprint

A fixed stretch of time with a set of issues you plan to finish. Selfbound runs one sprint at a time, and it spans all teams: you plan it, start it, and complete it, deciding what happens with unfinished issues.

## Team key

The 2 to 6 capital letters and digits that start every [identifier](#identifier) of a team, such as `ACME`. It can only be changed while the team has no issues, so identifiers stay stable.

## Triage

The status for incoming issues that you have not reviewed yet. Issues created by agents start in triage if the team has a triage status. From there you accept an issue (and choose its status), mark it as a duplicate, or decline it.

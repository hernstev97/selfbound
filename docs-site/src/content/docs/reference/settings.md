---
title: Settings
description: A map of the Settings pages in XLR8 and what each one controls.
sidebar:
  order: 2
---

Settings has its own navigation on the left, in three groups, followed by one entry per team. Open it with **Settings** at the bottom of the sidebar, or search for "Settings" in the command menu (Ctrl K). **Back to app** at the top returns to where you were.

Some settings apply only to the device you are on, others to every device you sign in on. Each page says which.

## Account

### General

Settings for this device:

- **Language**: English, Deutsch (German), or **Automatic (browser language)**. The page reloads after a change. See [Language](/using/language/).
- **Teams in the sidebar**: **Small** shows logo and name, **Large** adds the counts.
- **Sounds**: soft sounds for clicks, keys, menus, success and errors, with a volume slider.
- **Local cache**: XLR8 keeps a copy of your issues in the browser for a fast start. **Clear** empties it.
- **Sign out** (not shown with the local test sign-in).

### Appearance

- **This device**: **Color scheme** (Light, Dark or System) and **Font size**.
- **Themes**: one theme for light and one for dark, from a list of well-known VS Code themes. These apply on all devices.
- **Custom themes**: add your own by pasting or uploading the JSON of a VS Code theme.
- **Fonts**: one font for **Text and interface** and one for **Code**.

Details: [Appearance](/using/appearance/).

### Notifications

- **This device**: turn push notifications on or off for this browser and send a **Test notification**.
- **Events**: which events notify you, such as a new issue or comment from an agent, due and overdue issues, merged pull requests, or a sprint that is ending. These apply to all devices.
- **Devices**: every device that receives notifications, with a button to remove it.

Details: [Notifications](/using/notifications/).

## Workspace

### Teams

All teams in sidebar order, with a button to move each one up or down, and **New team** to add one. Each team has its own page, listed at the bottom of the settings navigation:

- **General**: name, key, color, **Dormant**, and **Knowledge** (Off, Alongside issues, or Knowledge only). The key can only change while the team has no issues, so identifiers stay stable.
- **Workflow**: the team's statuses, grouped by type, the default status for new issues, and **Fixed order** if issues should move through the statuses in order.
- **Logo**: a logo for light and, optionally, one for dark backgrounds.

Details: [Teams](/concepts/teams/).

### Projects

Create projects and set their status. Every project belongs to exactly one team.

### Labels

Create labels and label groups, set their colors, and make a group **Single choice** so an issue can carry only one of its labels. Archived labels stay on their issues but can no longer be assigned.

Details: [Labels](/concepts/labels/).

### Recurrences

Issues that come back every week or every month. On the due day, XLR8 creates the issue for you. You can also set up a recurrence from an issue with **Repeat …** in its context menu.

## Agents and ops

### Agents

API keys for coding agents such as Claude Code or Codex, and connectors for claude.ai and ChatGPT. The list shows when each one was created and last used, and how many calls it made today. You can revoke any of them here.

Details: [Connect an agent](/agents/connect/).

### GitHub

Shows whether the backend is connected to GitHub, which repositories its token can see, and whether the webhook is in place in each of them. The token itself is set on the server, not here.

Details: [GitHub](/integrations/github/).

### Ops

A status page read directly from the backend: whether sign-in is set up, whether the last backup and the last import worked, whether GitHub is delivering, how much file storage is used, and which agents were active today. Use it to check that your instance is healthy.

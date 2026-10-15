---
title: Settings
description: A map of the Settings pages in Selfbound and what each one controls.
sidebar:
  order: 2
---

Settings has its own navigation on the left, in three groups, followed by one entry per team. Open it with **Settings** at the bottom of the sidebar, or search for "Settings" in the command menu (Ctrl K). **Back to app** at the top returns to where you were.

Some settings apply only to the device you are on, others to every device you sign in on. Each page says which.

## Account

### Profile

- **Picture**: upload a PNG, JPEG or WebP and choose the part that shows inside the circle (drag to move, slider or mouse wheel to zoom; arrow keys and plus/minus work too). The picture is stored at 256 × 256 pixels, and camera metadata is dropped. **Remove** goes back to initials.
- **Name**: shown in the activity of issues, in comments and in the inbox instead of "You", and to agents through MCP (for example as the author of a comment). Without a name, Selfbound shows initials and "You". Agents keep their own names.

Name and picture are stored in Selfbound, not taken from your sign-in account, and apply on all devices.

### General

Settings for this device:

- **Language**: English, Deutsch (German), or **Automatic (browser language)**. The page reloads after a change. See [Language](/using/language/).
- **Time zone**: see below; this one applies to the whole instance, not only this device.
- **Teams in the sidebar**: **Small** shows logo and name, **Large** adds the counts.
- **Sounds**: soft sounds for clicks, keys, menus, success and errors, with a volume slider.
- **Local cache**: Selfbound keeps a copy of your issues in the browser for a fast start. **Clear** empties it.
- **Sign out** (not shown with the local test sign-in).

#### Time zone

The time zone decides where a calendar day begins. It is used for due dates and "overdue", the day a snoozed
issue comes back, the default dates and the start and end of sprints, recurring issues, the morning
notifications, and what agents see as "today" (`due`, `overdue` and `done_today` in `list_issues`). Timestamps
such as "3 hours ago" are shown in your device's time zone either way.

- At your **first sign-in**, Selfbound saves the time zone of your browser. Until then (and on an instance
  that was set up before this setting existed) it counts in Europe/Berlin.
- Change it under **Settings → General → Time zone**, or with **Settings: Time zone** in the command menu. If
  this browser is in another zone than the instance, a button offers to switch to the browser's.
- It is stored on the server, so the nightly jobs, the morning notifications and MCP use it without a browser.
- Only the owner can change it.

Changing the zone converts nothing. Due dates, snooze days and sprint dates are plain calendar days
(`2026-10-23`) and stay as they are; only the moment a day starts moves. If you move from Berlin to New York,
an issue due on the 23rd is still due on the 23rd, now until midnight in New York. Recurring issues that were
due "today" in the old zone are created once; the next date is calculated in the new zone.

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

Issues that come back every week or every month. On the due day, Selfbound creates the issue for you. You can also set up a recurrence from an issue with **Repeat …** in its context menu.

## Agents and ops

### Agents

API keys for coding agents such as Claude Code or Codex, and connectors for claude.ai and ChatGPT. The list shows when each one was created and last used, and how many calls it made today. You can revoke any of them here.

Details: [Connect an agent](/agents/connect/).

### GitHub

Shows whether the backend is connected to GitHub, which repositories its token can see, and whether the webhook is in place in each of them. The token itself is set on the server, not here.

Details: [GitHub](/integrations/github/).

### Ops

A status page read directly from the backend: whether sign-in is set up, whether the last backup and the last import worked, whether GitHub is delivering, how much file storage is used, and which agents were active today. Use it to check that your instance is healthy.

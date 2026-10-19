---
title: License
description: Selfbound is open source under the AGPL-3.0. What that means in plain words for using, changing and hosting it.
sidebar:
  order: 2
---

Selfbound is free and open source under the [GNU Affero General Public License v3.0](https://github.com/hernstev97/selfbound/blob/main/LICENSE) (AGPL-3.0). Copyright © 2026 Steven Hernandez and contributors.

This page explains the license in plain words. It is not legal advice; the [license text](https://github.com/hernstev97/selfbound/blob/main/LICENSE) is what counts.

## What you may do

- **Use it** for any purpose, personal or commercial, at no cost.
- **Read and study** the source code.
- **Change it** to fit your needs.
- **Share it**, as it is or with your changes, as long as you pass it on under the same license with its source code.

## The network clause

The AGPL adds one rule to the better-known GPL. **If you run a modified version of Selfbound as a service that other people use over a network, you must offer those people the source code of your modified version**, under the same license.

In practice:

| What you do | What you have to do |
|---|---|
| Run Selfbound unmodified for yourself | Nothing beyond keeping the license notices |
| Change Selfbound and run it only for yourself | Nothing: nobody else uses it, so there is nobody to offer the source to |
| Change Selfbound and run it as a service for other people | Offer them the source code of the version you run, including your changes |
| Pass on copies of Selfbound, changed or not | Keep the license and make the source code available to the recipients |

Selfbound links its source code under Settings › About and in the footer of the sign-in page. By default the link points to this repository. If you run a changed version, publish your changes (a public fork works) and set `sourceUrl` in your instance settings, or `SELFBOUND_SOURCE_URL` at build time, to that repository. The link then points to your code. See [Self-hosting](/start/self-hosting/).

## Your contributions

When you contribute to Selfbound, your contribution is licensed under the AGPL-3.0 as well. See [Contributing](/project/contributing/).

## Third-party parts

Some parts of Selfbound come from other projects and keep their own licenses:

- **Color themes:** the built-in VS Code themes (Catppuccin, Dracula, Nord, Tokyo Night, Gruvbox, Solarized, GitHub and others) are unmodified originals under the MIT License. Each theme folder contains its license, and [SOURCES.md](https://github.com/hernstev97/selfbound/blob/main/app/src/themes/SOURCES.md) lists where each one comes from.
- **Fonts:** the selectable fonts (Inter, Geist, JetBrains Mono, Fira Code and others) come from Fontsource packages under the SIL Open Font License 1.1.
- **Syntax grammars:** the grammars for code highlighting come through Shiki from VS Code and other editor extensions, under the MIT License.
- **Libraries:** the npm packages Selfbound depends on keep their own licenses.

Every build lists all third-party material it ships, with the license texts, at `/third-party-notices.txt` (linked from Settings › About and the sign-in page). The build stops if something it would ship has no license or one that does not fit the AGPL-3.0. See [THIRD_PARTY_NOTICES.md](https://github.com/hernstev97/selfbound/blob/main/THIRD_PARTY_NOTICES.md).

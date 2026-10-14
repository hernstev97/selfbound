<!--
Thank you for contributing! Selfbound works issue-first (see CONTRIBUTING.md): the issue below needs the
label "accepted" from the maintainer. Pull requests from non-collaborators without such an issue are
closed automatically; once the issue is accepted you can reopen this one.
Branch names look like feat/123-short-description or fix/short-description.
-->

Closes #

## What and why

<!-- What does this change, and why is it needed? -->

## How it was checked

<!-- Tests, manual checks, screenshots for visible changes. -->

## Checklist

- [ ] The linked issue carries the label `accepted`, and the branch name follows `<type>/<issue>-<slug>`
- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] New UI text goes through `t()` and has a German entry (`node tooling/i18n-check.mjs`)
- [ ] No secrets, personal data or real production values in code, tests or screenshots
- [ ] Start bundle and interaction speed are not noticeably worse (CI job `check`, step "Performance (quick run)")

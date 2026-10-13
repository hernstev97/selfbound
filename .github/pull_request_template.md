## What and why

<!-- What does this change, and why is it needed? Link the issue if there is one. -->

## How it was checked

<!-- Tests, manual checks, screenshots for visible changes. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] New UI text goes through `t()` and has a German entry (`node tooling/i18n-check.mjs`)
- [ ] No secrets, personal data or real production values in code, tests or screenshots
- [ ] Start bundle and interaction speed are not noticeably worse (CI job `check`, step "Performance (quick run)")

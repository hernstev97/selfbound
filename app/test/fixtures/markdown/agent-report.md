## Summary

The bug only happens when `issues.setDescription` is called with an **outdated version**.
After that the status line stays on "Saving …".

### Steps

1. Open an issue
2. Change the description
   - while an agent is writing
   - _without_ waiting
3. Save

### Cause

```ts
const result = await this.app.store.setDescription(id, text, d.base);
if (result.version !== d.base + 1) throw new Error('conflict');
```

> Note: this only affects descriptions, not comments.

### Open points

- [x] Write a test
- [ ] Ship the fix
- [ ] Update the docs (`docs/architecture/frontend.md`)

| Case | Expected | Actual |
|------|:--------:|------------:|
| A    | Notice   | nothing     |
| B \| C | Choice | Lost text |

See https://tracker.example.com/acme/issue/ACME-15 and [the docs](https://docs.convex.dev/database/writing-data "Convex").

---

Created by Claude Code · 2026-10-09

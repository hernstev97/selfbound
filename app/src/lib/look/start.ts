// Entry for main.ts (idle after startup). A separate file because the settings import index.ts
// statically: a dynamic import of the same file would need a namespace object plus a Rolldown
// helper from an unrelated chunk (highlight.js), which would then load at startup.
import type { App } from '@xlr8/core';
import { look } from './index.ts';

export function startLook(app: App) {
  look.start(app);
}

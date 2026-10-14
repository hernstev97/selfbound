import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Default 13470/5472; for parallel runs (several worktrees) set E2E_BACKEND_PORT / E2E_APP_PORT.
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 13470);
export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 5472);
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
/** Sample public URL baked into the e2e build (XLR8_PUBLIC_URL), so link-preview tags are absolute. */
export const PUBLIC_URL = 'https://selfbound.example.com';

/** Location for state shared between setup, tests and teardown (gitignored). */
export function state(name: string) {
  const dir = join(root, 'e2e/.backend');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

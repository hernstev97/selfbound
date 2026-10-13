// Stops vite preview and the e2e backend (process groups). E2E_KEEP=1 leaves both running.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, state } from './env.ts';

function killGroup(file: string) {
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, 'utf8'));
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(file, { force: true });
}

export default async function globalTeardown() {
  if (process.env.E2E_KEEP === '1') return;
  killGroup(state('preview.pid'));
  killGroup(join(root, 'e2e/.backend/pid'));
}

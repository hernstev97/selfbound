type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;
interface DirOptions {
  /** Extends the app name: `-perf` gives selfbound-perf */
  suffix?: string;
  env?: Env;
  home?: string;
  exists?: (path: string) => boolean;
  warn?: Warn;
}
export function envVarPair(name: string, legacyName: string, env?: Env, warn?: Warn): string | undefined;
export function envVar(name: string, env?: Env, warn?: Warn): string | undefined;
export function resetEnvWarnings(): void;
export function resolveDir(kind: 'config' | 'data' | 'state' | 'cache', options?: DirOptions): string;
export function configDir(options?: DirOptions): string;
export function dataDir(options?: DirOptions): string;
export function stateDir(options?: DirOptions): string;
export function cacheDir(options?: DirOptions): string;
export function configFile(name: string, options?: Omit<DirOptions, 'suffix'>): string;

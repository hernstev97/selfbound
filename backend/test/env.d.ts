// Vite provides import.meta.glob; vite itself is not a direct dependency here.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}

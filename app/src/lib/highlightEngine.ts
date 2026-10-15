// The regex engine of the highlighter: Oniguruma as WebAssembly, the engine VS Code uses, so
// grammars behave exactly as in the editor. The .wasm file is its own asset (not in any script
// chunk) and is fetched once, when the first code block is colored. The bytes are fetched here,
// not by the engine: it remembers a failed load for good, a failed fetch must stay retryable.
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/onig.wasm?url';

export async function createEngine() {
  const response = await fetch(wasm);
  if (!response.ok) throw new Error(`Could not load ${wasm} (${response.status})`);
  return createOnigurumaEngine(await response.arrayBuffer());
}

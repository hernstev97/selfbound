// The regex engine of the highlighter: Oniguruma as WebAssembly, the engine VS Code uses, so
// grammars behave exactly as in the editor. The .wasm file is its own asset (not in any script
// chunk) and is fetched once, when the first code block is colored.
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import wasm from 'shiki/onig.wasm?url';

export const createEngine = () => createOnigurumaEngine(fetch(wasm));

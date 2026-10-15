// The regex engine of the highlighter: Shiki's JavaScript engine (no WebAssembly, no extra file).
// It runs the TextMate grammars with the browser's own regular expressions. Tested against Oniguruma
// (the engine VS Code uses) on about 1,200 real files: identical except a few characters in Python
// and SQL. It is about 90 kB brotli smaller on the first colored block.
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

export const createEngine = () => createJavaScriptRegexEngine();

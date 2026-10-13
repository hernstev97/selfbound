// German dictionary: one chunk, loaded only when German is active (app/src/lib/i18n.ts).
import type { Dictionary } from '@xlr8/core/i18n';
import core from '@xlr8/core/locales/de';
import components from './components.ts';
import lib from './lib.ts';
import pages from './pages.ts';
import shared from './shared.ts';

export default { ...core, ...shared, ...lib, ...components, ...pages } satisfies Dictionary;

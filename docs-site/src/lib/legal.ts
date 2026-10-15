// Operator details of the imprint and privacy pages: from a file outside the repository
// (tooling/site-legal.mjs). A build that goes live (indexable site or SELFBOUND_SITE_REQUIRE_LEGAL=1, which
// scripts/deploy.mjs sets for --prod) fails without them.
import { legalHtml, legalRequired, loadLegal } from '../../../tooling/site-legal.mjs';
import { INDEXABLE } from '../../launch.mjs';

export const legal = legalHtml(loadLegal({ required: legalRequired(process.env, INDEXABLE) }));

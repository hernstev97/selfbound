// Validates the import queries against Linear's public GraphQL schema.
// The schema (1.3 MB) is not in the repository. Run:
//   curl -sSfLo /tmp/linear-schema.graphql https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
//   LINEAR_SCHEMA=/tmp/linear-schema.graphql pnpm --filter @selfbound/backend test:lib

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { graphql } from '../../../../tooling/linear-import/graphql.ts';
import { QUERIES } from '../../../../tooling/linear-import/queries.ts';

const schemaPath = process.env.LINEAR_SCHEMA;

describe.skipIf(!schemaPath)('queries against the Linear schema', () => {
  const schema = schemaPath ? graphql.buildSchema(readFileSync(schemaPath, 'utf8'), { assumeValidSDL: true }) : undefined;
  test.each(Object.entries(QUERIES))('%s is valid', (_name, document) => {
    const errors = graphql.validate(schema!, graphql.parse(document));
    expect(errors.map((e: { message: string }) => e.message)).toEqual([]);
  });
});

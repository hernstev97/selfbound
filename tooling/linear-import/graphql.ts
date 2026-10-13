// Loads the `graphql` package from backend/node_modules.
//
// tooling/ is not a workspace package; `graphql` is a devDependency of the backend.
// Node resolves packages relative to the importing file, hence createRequire with the
// backend as the starting point. The type only describes the subset in use, so no
// tsconfig needs path mappings.

import { createRequire } from 'node:module';

export interface GraphQLDefinition {
  kind: string;
  operation?: string;
  name?: { value: string };
}

export interface GraphQLSubset {
  parse(source: string): { definitions: readonly GraphQLDefinition[] };
  Kind: { OPERATION_DEFINITION: string };
  OperationTypeNode: { QUERY: string };
  buildSchema(sdl: string, options?: { assumeValidSDL?: boolean }): unknown;
  validate(schema: unknown, document: unknown): readonly { message: string }[];
}

const requireFromBackend = createRequire(new URL('../../backend/package.json', import.meta.url));

export const graphql: GraphQLSubset = requireFromBackend('graphql');

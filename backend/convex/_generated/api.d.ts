/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agents from "../agents.js";
import type * as appearance from "../appearance.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as dataExport from "../dataExport.js";
import type * as embeds from "../embeds.js";
import type * as files from "../files.js";
import type * as github from "../github.js";
import type * as githubImport from "../githubImport.js";
import type * as githubPr from "../githubPr.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as importer from "../importer.js";
import type * as inbox from "../inbox.js";
import type * as instance from "../instance.js";
import type * as issues from "../issues.js";
import type * as labelGroups from "../labelGroups.js";
import type * as labels from "../labels.js";
import type * as legacyNames from "../legacyNames.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_counters from "../lib/counters.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_embeds from "../lib/embeds.js";
import type * as lib_equal from "../lib/equal.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_githubApi from "../lib/githubApi.js";
import type * as lib_githubIssues from "../lib/githubIssues.js";
import type * as lib_githubMedia from "../lib/githubMedia.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_identifiers from "../lib/identifiers.js";
import type * as lib_image from "../lib/image.js";
import type * as lib_keys from "../lib/keys.js";
import type * as lib_legacyEnv from "../lib/legacyEnv.js";
import type * as lib_logo from "../lib/logo.js";
import type * as lib_mcp_endpoint from "../lib/mcp/endpoint.js";
import type * as lib_mcp_protocol from "../lib/mcp/protocol.js";
import type * as lib_mcp_tools from "../lib/mcp/tools.js";
import type * as lib_mcp_validate from "../lib/mcp/validate.js";
import type * as lib_modelsCatalog from "../lib/modelsCatalog.js";
import type * as lib_oauth_core from "../lib/oauth/core.js";
import type * as lib_oauth_http from "../lib/oauth/http.js";
import type * as lib_pushText from "../lib/pushText.js";
import type * as lib_rank from "../lib/rank.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_testSwitches from "../lib/testSwitches.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_webpush from "../lib/webpush.js";
import type * as lib_wikiText from "../lib/wikiText.js";
import type * as lib_workflow from "../lib/workflow.js";
import type * as linearFiles from "../linearFiles.js";
import type * as maintenance from "../maintenance.js";
import type * as mcp from "../mcp.js";
import type * as meta from "../meta.js";
import type * as migrations from "../migrations.js";
import type * as models from "../models.js";
import type * as oauth from "../oauth.js";
import type * as ops from "../ops.js";
import type * as ops_agents from "../ops/agents.js";
import type * as ops_bodies from "../ops/bodies.js";
import type * as ops_comments from "../ops/comments.js";
import type * as ops_embeds from "../ops/embeds.js";
import type * as ops_files from "../ops/files.js";
import type * as ops_github from "../ops/github.js";
import type * as ops_githubImport from "../ops/githubImport.js";
import type * as ops_githubPr from "../ops/githubPr.js";
import type * as ops_history from "../ops/history.js";
import type * as ops_import from "../ops/import.js";
import type * as ops_inbox from "../ops/inbox.js";
import type * as ops_inboxChanges from "../ops/inboxChanges.js";
import type * as ops_instance from "../ops/instance.js";
import type * as ops_issues from "../ops/issues.js";
import type * as ops_links from "../ops/links.js";
import type * as ops_maintenance from "../ops/maintenance.js";
import type * as ops_mcp from "../ops/mcp.js";
import type * as ops_models from "../ops/models.js";
import type * as ops_move from "../ops/move.js";
import type * as ops_notify from "../ops/notify.js";
import type * as ops_oauth from "../ops/oauth.js";
import type * as ops_priorityLimits from "../ops/priorityLimits.js";
import type * as ops_profile from "../ops/profile.js";
import type * as ops_recurrences from "../ops/recurrences.js";
import type * as ops_relations from "../ops/relations.js";
import type * as ops_sprints from "../ops/sprints.js";
import type * as ops_teams from "../ops/teams.js";
import type * as ops_testData from "../ops/testData.js";
import type * as ops_validate from "../ops/validate.js";
import type * as ops_wiki from "../ops/wiki.js";
import type * as ops_workflow from "../ops/workflow.js";
import type * as opsStatus from "../opsStatus.js";
import type * as profile from "../profile.js";
import type * as projects from "../projects.js";
import type * as push from "../push.js";
import type * as recurrences from "../recurrences.js";
import type * as relations from "../relations.js";
import type * as repoRename from "../repoRename.js";
import type * as seed from "../seed.js";
import type * as shared_constants from "../shared/constants.js";
import type * as shared_embeds from "../shared/embeds.js";
import type * as shared_export from "../shared/export.js";
import type * as shared_importTypes from "../shared/importTypes.js";
import type * as shared_linearFiles from "../shared/linearFiles.js";
import type * as shared_links from "../shared/links.js";
import type * as shared_models from "../shared/models.js";
import type * as shared_notifyEvents from "../shared/notifyEvents.js";
import type * as shared_priorityLimits from "../shared/priorityLimits.js";
import type * as shared_pullRequests from "../shared/pullRequests.js";
import type * as shared_workflow from "../shared/workflow.js";
import type * as sprints from "../sprints.js";
import type * as teams from "../teams.js";
import type * as wiki from "../wiki.js";
import type * as workflowStates from "../workflowStates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agents: typeof agents;
  appearance: typeof appearance;
  comments: typeof comments;
  crons: typeof crons;
  dataExport: typeof dataExport;
  embeds: typeof embeds;
  files: typeof files;
  github: typeof github;
  githubImport: typeof githubImport;
  githubPr: typeof githubPr;
  health: typeof health;
  http: typeof http;
  importer: typeof importer;
  inbox: typeof inbox;
  instance: typeof instance;
  issues: typeof issues;
  labelGroups: typeof labelGroups;
  labels: typeof labels;
  legacyNames: typeof legacyNames;
  "lib/actor": typeof lib_actor;
  "lib/auth": typeof lib_auth;
  "lib/counters": typeof lib_counters;
  "lib/dates": typeof lib_dates;
  "lib/embeds": typeof lib_embeds;
  "lib/equal": typeof lib_equal;
  "lib/errors": typeof lib_errors;
  "lib/github": typeof lib_github;
  "lib/githubApi": typeof lib_githubApi;
  "lib/githubIssues": typeof lib_githubIssues;
  "lib/githubMedia": typeof lib_githubMedia;
  "lib/idempotency": typeof lib_idempotency;
  "lib/identifiers": typeof lib_identifiers;
  "lib/image": typeof lib_image;
  "lib/keys": typeof lib_keys;
  "lib/legacyEnv": typeof lib_legacyEnv;
  "lib/logo": typeof lib_logo;
  "lib/mcp/endpoint": typeof lib_mcp_endpoint;
  "lib/mcp/protocol": typeof lib_mcp_protocol;
  "lib/mcp/tools": typeof lib_mcp_tools;
  "lib/mcp/validate": typeof lib_mcp_validate;
  "lib/modelsCatalog": typeof lib_modelsCatalog;
  "lib/oauth/core": typeof lib_oauth_core;
  "lib/oauth/http": typeof lib_oauth_http;
  "lib/pushText": typeof lib_pushText;
  "lib/rank": typeof lib_rank;
  "lib/search": typeof lib_search;
  "lib/testSwitches": typeof lib_testSwitches;
  "lib/validators": typeof lib_validators;
  "lib/webpush": typeof lib_webpush;
  "lib/wikiText": typeof lib_wikiText;
  "lib/workflow": typeof lib_workflow;
  linearFiles: typeof linearFiles;
  maintenance: typeof maintenance;
  mcp: typeof mcp;
  meta: typeof meta;
  migrations: typeof migrations;
  models: typeof models;
  oauth: typeof oauth;
  ops: typeof ops;
  "ops/agents": typeof ops_agents;
  "ops/bodies": typeof ops_bodies;
  "ops/comments": typeof ops_comments;
  "ops/embeds": typeof ops_embeds;
  "ops/files": typeof ops_files;
  "ops/github": typeof ops_github;
  "ops/githubImport": typeof ops_githubImport;
  "ops/githubPr": typeof ops_githubPr;
  "ops/history": typeof ops_history;
  "ops/import": typeof ops_import;
  "ops/inbox": typeof ops_inbox;
  "ops/inboxChanges": typeof ops_inboxChanges;
  "ops/instance": typeof ops_instance;
  "ops/issues": typeof ops_issues;
  "ops/links": typeof ops_links;
  "ops/maintenance": typeof ops_maintenance;
  "ops/mcp": typeof ops_mcp;
  "ops/models": typeof ops_models;
  "ops/move": typeof ops_move;
  "ops/notify": typeof ops_notify;
  "ops/oauth": typeof ops_oauth;
  "ops/priorityLimits": typeof ops_priorityLimits;
  "ops/profile": typeof ops_profile;
  "ops/recurrences": typeof ops_recurrences;
  "ops/relations": typeof ops_relations;
  "ops/sprints": typeof ops_sprints;
  "ops/teams": typeof ops_teams;
  "ops/testData": typeof ops_testData;
  "ops/validate": typeof ops_validate;
  "ops/wiki": typeof ops_wiki;
  "ops/workflow": typeof ops_workflow;
  opsStatus: typeof opsStatus;
  profile: typeof profile;
  projects: typeof projects;
  push: typeof push;
  recurrences: typeof recurrences;
  relations: typeof relations;
  repoRename: typeof repoRename;
  seed: typeof seed;
  "shared/constants": typeof shared_constants;
  "shared/embeds": typeof shared_embeds;
  "shared/export": typeof shared_export;
  "shared/importTypes": typeof shared_importTypes;
  "shared/linearFiles": typeof shared_linearFiles;
  "shared/links": typeof shared_links;
  "shared/models": typeof shared_models;
  "shared/notifyEvents": typeof shared_notifyEvents;
  "shared/priorityLimits": typeof shared_priorityLimits;
  "shared/pullRequests": typeof shared_pullRequests;
  "shared/workflow": typeof shared_workflow;
  sprints: typeof sprints;
  teams: typeof teams;
  wiki: typeof wiki;
  workflowStates: typeof workflowStates;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

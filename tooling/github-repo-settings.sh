#!/bin/sh
# Applies the repository settings XLR8 relies on, idempotently, with the GitHub CLI (`gh`, admin rights).
#
# Usage: tooling/github-repo-settings.sh OWNER/REPO
#
# Rulesets, secret scanning, fork-PR approval, private vulnerability reporting and CodeQL need a public
# repository (or a paid plan). While the repository is private those steps report "skipped" and
# the script carries on; run it again after the repository is public.
#
# What it sets:
# - merges: squash or rebase only (linear history), delete branches after merge
# - Actions: GITHUB_TOKEN read-only by default (workflows grant more per job), Actions must be pinned
#   to a full commit SHA, only GitHub-owned actions and pnpm/action-setup, workflows from fork pull
#   requests need approval (all outside contributors), no secrets or write tokens for fork PRs
# - Dependabot alerts and security updates (version updates: .github/dependabot.yml)
# - secret scanning with push protection, private vulnerability reporting
# - ruleset "main" on the default branch: changes only through pull requests, required status check
#   `check` (CI) and CodeQL results, no force pushes, no deletion, linear history; repository admins
#   may bypass, but only when merging a pull request, never with a direct push; also required: the
#   check `branch-name` (.github/workflows/pr-policy.yml)
# - ruleset "branch names": new branches must be `<type>/<slug>` (CONTRIBUTING.md) or Dependabot's.
#   GitHub's documentation does not say whether branch-name rules exist for repositories of a personal
#   account on the Free plan. If GitHub refuses, the step reports "skipped"; the CI check `branch-name`
#   enforces the same rule on every pull request either way.
# - label `accepted` (the maintainer's approval of an issue; the PR policy workflow looks for it)
set -u
repo=${1:?usage: tooling/github-repo-settings.sh OWNER/REPO}

step() { printf '%-44s' "$1"; }
ok() { echo "ok"; }
skip() { echo "skipped ($1)"; }
try() { # try <label> <gh api args…>; stdin is passed on
  label=$1; shift
  step "$label"
  if out=$(gh api "$@" 2>&1); then ok; else skip "$(printf '%s' "$out" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)"; fi
}

try "merge options" -X PATCH "repos/$repo" \
  -F has_wiki=false -F has_projects=false -F delete_branch_on_merge=true \
  -F allow_merge_commit=false -F allow_squash_merge=true -F allow_rebase_merge=true -F allow_auto_merge=false \
  -F allow_update_branch=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY

try "GITHUB_TOKEN read-only by default" -X PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

try "Actions: selected, SHA pinning required" -X PUT "repos/$repo/actions/permissions" \
  -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true

try "Actions: allowed list" -X PUT "repos/$repo/actions/permissions/selected-actions" --input - <<'EOF'
{"github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": ["pnpm/action-setup@*"]}
EOF

try "fork PRs (private repo settings)" -X PUT "repos/$repo/actions/permissions/fork-pr-workflows-private-repos" \
  -F run_workflows_from_fork_pull_requests=false -F send_write_tokens_to_workflows=false \
  -F send_secrets_and_variables=false -F require_approval_for_fork_pr_workflows=true

try "fork PRs need approval (public)" -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors

try "Dependabot alerts" -X PUT "repos/$repo/vulnerability-alerts"
try "Dependabot security updates" -X PUT "repos/$repo/automated-security-fixes"

try "secret scanning + push protection" -X PATCH "repos/$repo" --input - <<'EOF'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}, "secret_scanning_non_provider_patterns": {"status": "enabled"}, "secret_scanning_validity_checks": {"status": "enabled"}}}
EOF

try "private vulnerability reporting" -X PUT "repos/$repo/private-vulnerability-reporting"

# Ruleset: create or update the one named "main".
ruleset=$(cat <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "check", "integration_id": 15368 }, { "context": "branch-name", "integration_id": 15368 }]
      }
    },
    {
      "type": "code_scanning",
      "parameters": {
        "code_scanning_tools": [{ "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" }]
      }
    }
  ]
}
EOF
)
# upsert_ruleset <name> <json>: create or update the ruleset with that name.
upsert_ruleset() {
  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$1\") | .id" 2>/dev/null) || id=
  if [ -n "$id" ]; then
    printf '%s' "$2" | try "ruleset $1 (update)" -X PUT "repos/$repo/rulesets/$id" --input -
  else
    printf '%s' "$2" | try "ruleset $1 (create)" -X POST "repos/$repo/rulesets" --input -
  fi
}

upsert_ruleset main "$ruleset"

# Branch names: <type>/<issue>-<slug> or <type>/<slug>, lower case, digits and hyphens (CONTRIBUTING.md);
# Dependabot branches and the default branch itself are allowed.
branch_rule=$(cat <<'EOF'
{
  "name": "branch names",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [
    {
      "type": "branch_name_pattern",
      "parameters": {
        "name": "<type>/<issue>-<slug>",
        "negate": false,
        "operator": "regex",
        "pattern": "^((feat|fix|docs|refactor|perf|test|chore|ci)/[a-z0-9]+(-[a-z0-9]+)*|dependabot/[A-Za-z0-9._/-]+|main)$"
      }
    }
  ]
}
EOF
)
upsert_ruleset "branch names" "$branch_rule"

# Label for approved issues (--force updates colour and description if it exists).
step "label accepted"
if out=$(gh label create accepted -R "$repo" --color 0e8a16 --description "Approved by the maintainer: a pull request is welcome" --force 2>&1); then ok; else skip "$out"; fi

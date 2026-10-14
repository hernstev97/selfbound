# Backup and restore

The workflow `.github/workflows/backup.yml` backs up the production Convex deployment every night,
proves the backup can be restored, encrypts it with [age](https://age-encryption.org) and stores it as a
GitHub Actions artifact. Scripts: `tooling/backup/`.

## Summary

- **Every night at 03:30** (Europe/Berlin, set in the workflow's `schedule`) GitHub exports the whole database.
- **Every backup is restored right away** into an empty local backend inside the runner. Only if all
  tables and files match is it encrypted and stored.
- **Encrypted with age.** Only the holder of the owner's private age key can open it; not GitHub, not Convex.
- **Retention:** every day 30 days, every Sunday additionally 90 days.
- **Once a quarter** the owner should test decrypting a backup (below, about 10 minutes).

The unencrypted ZIP never leaves the runner.

## What is backed up

| Backed up | Not backed up (and why) |
|---|---|
| all issues with descriptions, comments, history, relations | the code: it lives in Git |
| teams, labels, projects, sprints, knowledge pages | environment variables (Clerk settings, webhook secret, …): keep them in a password manager ([operations.md](operations.md#backend-environment-variables)) |
| team logos and images from descriptions and comments (files with checksums) | scheduled background jobs that have not run yet: they are recreated after the import |
| agents (only the hashes of their keys), import data, pull request links | videos: they are links to Google Drive, not stored in Selfbound |

A backup is a ZIP with one JSONL file per table and a folder with the files (`convex export
--include-file-storage`). The restore test compares every table (row count and checksum over the sorted
documents) and every file (checksum). Next to the ZIP lies a small `manifest.json` with the number of
documents per table and the SHA-256 of the ZIP. It holds no content and is therefore not encrypted.

## Setup

1. **age key pair** (on the owner's machine):
   ```sh
   mkdir -p ~/.config/xlr8 && age-keygen -o ~/.config/xlr8/backup-age.key
   ```
   The output shows a line `Public key: age1…`: that is the **public** key.
2. Store the **private** key (the file) in two safe places, for example as a note in a password manager
   and on paper. Without it no backup can be opened.
3. **Convex deploy key:** in the Convex dashboard create a separate production deploy key just for the
   backup (not the one used for deploying from your machine). Convex has no read-only keys, which is why
   the key lives only in a protected GitHub environment.
4. **GitHub environment:** in the repository, Settings → Environments → create `production` (restrict it
   to the default branch) and add the secrets:
   - `CONVEX_DEPLOY_KEY`: the deploy key from step 3
   - `AGE_RECIPIENTS`: one or more public age keys (`age1…`), separated by commas or newlines

Until both secrets exist, the workflow ends with a notice instead of an error and backs up nothing.
Run it once by hand (Actions → Backup → Run workflow) to check the setup.

After every successful run the workflow reports to the backend through the internal function
`opsStatus:recordBackup`; the ops page in the app (Settings → Ops) then shows time, size and document count
of the last backup. If that report fails, the backup still counts.

## Where the backups are

In the GitHub repository under **Actions → Backup → (a run) → Artifacts**:

- `xlr8-backup-YYYY-MM-DD`: daily backup, 30 days
- `xlr8-backup-weekly-YYYY-MM-DD`: Sunday backup, 90 days

Each run shows a summary with the comparison table of the restore test. GitHub emails the repository
owner when a run fails.

## Restore, step by step

For the emergency: production data is broken or gone.

1. **Stop changing things.** Ideally don't use the app for a moment.
2. **Back up the current state anyway** (in case something useful is left): Actions → Backup → Run workflow.
3. **Pick and download a backup:** Actions → Backup → run of the desired day → Artifacts →
   `xlr8-backup-…`. Or in the terminal:
   ```sh
   gh run list --workflow backup.yml
   gh run download <run-id> --dir ~/xlr8-restore
   ```
4. **Decrypt:**
   ```sh
   cd ~/xlr8-restore/xlr8-backup-*/
   age -d -i ~/.config/xlr8/backup-age.key -o backup.zip xlr8-*.zip.age
   ```
5. **Check locally that the backup is complete** (starts an empty local backend, imports the backup and
   compares):
   ```sh
   node tooling/backup/verify-restore.mjs ~/xlr8-restore/xlr8-backup-*/backup.zip
   ```
   It ends with a line saying that all tables and files are equal.
6. **Import into production.** This replaces all production data with the backup. Everything written
   after the backup was taken is lost.
   ```sh
   cd backend
   read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY   # paste the production deploy key, Enter
   pnpm exec convex import --replace-all ~/xlr8-restore/xlr8-backup-*/backup.zip
   unset CONVEX_DEPLOY_KEY
   ```
   The Convex CLI shows how many documents will be replaced and asks for confirmation. Environment
   variables and code stay untouched. (`node tooling/convex.mjs` deliberately does not work here: that
   wrapper only allows local deployments.)
7. **Check:** open the app and look at a few issues, comments and team logos. Identifiers and timestamps
   are the same as when the backup was taken.
8. **Clean up:** delete `~/xlr8-restore` (it contains the decrypted data).

## Quarterly decryption test

Purpose: make sure the private key still exists and works. About 10 minutes.

1. Download the newest backup (step 3 above).
2. Decrypt it (step 4). If that fails, the key is wrong or gone: create a new key pair right away and
   replace `AGE_RECIPIENTS`. New backups are readable again from then on; old backups stay lost without
   the old key.
3. Check it locally (step 5).
4. Delete `~/xlr8-restore`.

## Trying it locally

With the local backend (no real data):

```sh
node tooling/local.mjs --port 13430 --no-wait                                # start a local backend
node tooling/backup/export.mjs --out /tmp/xlr8-backups                       # backup as ZIP
node tooling/backup/verify-restore.mjs /tmp/xlr8-backups/xlr8-local-*.zip    # restore test on port 13440
```

`export.mjs` encrypts with `--encrypt --recipient age1…` if age is installed. Without age the ZIP stays
unencrypted and the script says so. `--source deploy-key` (export the deployment behind
`CONVEX_DEPLOY_KEY`) only runs in CI.

## When a backup run fails

The run summary shows which step failed:

- **Export:** usually an expired or wrong deploy key, or a Convex outage. The next night tries again.
- **Restore test:** the backup does not match the current schema, or something is missing. The table
  shows where. Take this seriously.
- **Encryption:** the secret `AGE_RECIPIENTS` is missing or contains no `age1…` key.

In every case **no unencrypted file** was stored, and older backups stay as they are.

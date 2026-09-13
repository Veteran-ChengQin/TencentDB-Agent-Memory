# Task development assets

This extension makes implementation evidence produced by coding agents reusable at the team level. A completed Task can retain its sessions, changed files, verification results, Wiki knowledge, code graph and extracted Skills. Reviewers decide which assets are deposited, and a later Task can discover and selectively enable assets from related Tasks.

## Lifecycle

1. A harness session is associated with a Task. On completion, the Task stores normalized session evidence, a unified patch and test results.
2. The workbench presents Wiki, code-graph and Skill candidates for review. Nothing is deposited before explicit approval.
3. Approved Wiki content is written to the selected team Wiki. Code changes are recorded as a traceable Task delta or published as an immutable repository snapshot and indexed as a normal code graph. Extracted Skills retain their owning Agent and can be exposed to a Task through task-scoped authorization.
4. A bug Task searches completed feature Tasks in the same project. Retrieval combines exact code identifiers, changed-file evidence and BM25 text relevance; the user confirms the relationship and the assets to enable.
5. MemoryProxy reads `asset_usage` from Task metadata, applies the existing ACL checks, and exposes only the approved asset catalog to the harness. The harness decides whether and when to query or read an asset.

The principal trace is:

```text
Task -> session / patch / verification
Task -> changed file -> code entity -> relation
Bug Task -> related feature Task -> enabled Wiki / code graph / Skill
```

## Components

| Component | Responsibility |
| --- | --- |
| MemoryPanel | Task configuration, evidence display, review, relationship confirmation and snapshot publication |
| MemoryCore | Task/team metadata, ACL, deposition records and Skill extraction |
| MemoryKnowledge | Wiki and code-graph storage, Task code-delta analysis and reconciliation |
| MemoryProxy | Task context resolution, ACL filtering and on-demand asset discovery for harnesses |

## Optional repository snapshots

Some code-graph backends index a Git URL and branch rather than an unmerged local patch. The optional snapshot publisher reconstructs `base commit + Task patch`, publishes an immutable branch, and registers that branch through the existing code-graph path.

Set the following variables in `deploy/global-images/.env` to enable it:

```dotenv
TDAI_SNAPSHOT_GITHUB_OWNER=
TDAI_SNAPSHOT_GITHUB_TOKEN=
TDAI_SNAPSHOT_REPO_PREFIX=tdai-snapshot
TDAI_SNAPSHOT_EXCLUDED_PATHS=.github/workflows
TDAI_SNAPSHOT_GIT_USER_NAME=TDAI Snapshot Bot
TDAI_SNAPSHOT_GIT_USER_EMAIL=tdai-snapshot@localhost
```

Snapshot publication is disabled when owner or token is absent. The current publisher supports public GitHub HTTPS repositories and creates public snapshot repositories; do not enable it for confidential source code. The token is read only from the server environment and must not be committed.


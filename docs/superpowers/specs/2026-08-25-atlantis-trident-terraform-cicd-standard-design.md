# Atlantis Trident — Terraform GitOps CICD Standard (v1)

**Status:** Approved design
**Date:** 2026-08-25
**Scope:** v1 — Terraform plan-on-PR + apply-on-main, delivered as centrally-maintained
reusable GitHub Actions workflows.

## Problem

The repo fleet duplicates its CICD. The Terraform plan-on-PR-with-sticky-comment logic
is copy-pasted **verbatim** across `misty-mountain`, `the-great-hall`, and `ravenclaw`,
and near-verbatim in others. There is no single place to fix a bug, tighten security, or
evolve the convention — every repo drifts independently. Onboarding a new repo means
copying a full workflow from a neighbor and hoping it is current.

Atlantis Trident becomes the **standard CICD process**: one place that owns the logic, so
a single change propagates to every consumer, security is enforced centrally, and a new
repo adopts the standard by copying a ~15-line caller.

## Goals

1. **Kill duplication/drift** — logic lives once; consumers reference it.
2. **Fast onboarding** — a new repo adopts the standard by copying a small caller snippet.
3. **Enforce security & standards** — OIDC, least-privilege tokens, SHA-pinned third-party
   actions, protected-environment approvals — hard to regress.
4. **Consistent DX** — one predictable shape for PR plans, comments, environments, naming.

## Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Distribution mechanism | **Reusable workflows** (`workflow_call`) + copy-paste caller snippets | Reusable workflows are referenced live, so fixes propagate; kills drift. |
| Org `.github` UI starter templates | **Not in v1** | Everything stays in `atlantis-trident`; no dependency on an org `.github` repo. Onboarding is a README snippet copy, still fast. |
| v1 workflow scope | **Terraform plan-on-PR + apply-on-main** | The most-duplicated pattern; the one the design was anchored to (misty-mountain). |
| Terraform convention | **Convention 1 (misty-mountain)** | Dynamic state bucket `<project>-tfstate-<account>`, ordered stack loop, `terraform -chdir=stacks/<stack>`. Smallest input surface, cleanest DX. Outliers migrate to it. |
| Consumer pinning | **Moving `@v1`**; third-party actions **SHA-pinned internally** (Dependabot bumps) | First-party source → lower supply-chain risk, so auto-propagation via `@v1` is acceptable; SHA-pin the third-party surface for safety. |
| Self-CI & release | **actionlint + shellcheck + plan-only smoke**; release by manually moving `@v1` | Catches breakage before it reaches the fleet without a sandbox AWS account. |

Rejected alternatives: **starter-templates-only** (full copied workflows → drift returns,
the current problem); **reusable-workflows pinned to immutable SHA everywhere** (defeats
auto-propagation; every fix needs a bump PR in each consumer); **flexible workflow
supporting both TF conventions** (wider input surface, two code paths).

## Repository layout

```
atlantis-trident/
  .github/
    workflows/
      terraform-plan.yml        # reusable (workflow_call): PR fmt/validate/plan + sticky comment
      terraform-apply.yml       # reusable (workflow_call): apply stacks in order, protected env
      ci.yml                    # self-CI: actionlint + shellcheck + example smoke
    actions/
      tf-plan-comment/          # composite: build & upsert the sticky PR comment
        action.yml
      setup-terraform-aws/      # composite: OIDC + setup-terraform + resolve state bucket
        action.yml
    dependabot.yml              # bump internal third-party action SHAs
  examples/
    terraform-plan.yml          # copy-paste caller snippet
    terraform-apply.yml         # copy-paste caller snippet
    fixture/                    # tiny TF stack used by the plan-only smoke test
  docs/
    superpowers/specs/          # this design doc
  README.md                     # onboarding, inputs reference, migration guide
  RELEASING.md                  # how to cut a version and move @v1
  LICENSE
```

## Components

### `terraform-plan.yml` (reusable)

- **Trigger:** `on: workflow_call`.
- **Inputs:**
  - `stacks` (required, string) — space-separated, dependency-ordered stack names under
    `<working_directory>/stacks/`.
  - `terraform_version` (string, default `1.11.4`).
  - `aws_region` (string, default `us-west-2`).
  - `project` (string, default `${{ github.event.repository.name }}`) — name prefix;
    derives the state bucket `<project>-tfstate-<account>`.
  - `working_directory` (string, default `terraform`).
- **Secrets:** consumed via `secrets: inherit`; requires `AWS_GITHUB_ACTIONS_ROLE_ARN`.
- **Permissions:** `id-token: write`, `contents: read`, `pull-requests: write`.
- **Concurrency:** `terraform-plan-${{ github.ref }}`, `cancel-in-progress: true`.
- **Steps:**
  1. Verify `AWS_GITHUB_ACTIONS_ROLE_ARN` is set (explicit early failure with a pointer).
  2. `setup-terraform-aws` composite: OIDC `configure-aws-credentials`, `setup-terraform`,
     resolve `STATE_BUCKET=<project>-tfstate-<account>` from `sts get-caller-identity`.
  3. `terraform fmt -check -recursive`.
  4. Loop `stacks` in order: `init -backend-config=bucket=$STATE_BUCKET`, `validate`,
     `plan -out`, `show` → per-stack plan text.
  5. `tf-plan-comment` composite upserts the sticky PR comment.
  6. Exit non-zero only if a stack errored or failed validation (a plan **diff** is not a
     failure).

### `terraform-apply.yml` (reusable)

- **Trigger:** `on: workflow_call`.
- **Inputs:** same as plan, plus `environment` (string, default `production`).
- **Secrets:** `secrets: inherit`; requires `AWS_GITHUB_ACTIONS_ROLE_ARN`.
- **Permissions:** `id-token: write`, `contents: read`.
- **Concurrency:** `terraform-apply-${{ inputs.project }}`, `cancel-in-progress: false`.
- **Environment gate:** `environment: ${{ inputs.environment }}` (protected env with
  required reviewers) — no apply runs until approved.
- **Steps:** verify role secret → `setup-terraform-aws` composite → loop `stacks` in order
  `init` + `apply -auto-approve` with `set -e` (fail stops the chain).

### `tf-plan-comment` (composite action)

Encapsulates the misty-mountain `actions/github-script` sticky-comment logic:
hidden HTML marker to find-and-update one comment in place, per-stack `<details>`
collapsibles, status emoji (green = no changes, book = changes, warning = errored),
50k-char truncation, and a footer with the PR head SHA + UTC timestamp + run link.
Reused by the plan workflow and available to future workflows.

### `setup-terraform-aws` (composite action)

DRYs the shared prologue of both workflows: OIDC credential configuration,
`hashicorp/setup-terraform` at the requested version, and state-bucket resolution.
Keeps the two workflows thin and the auth/setup logic in one place.

## Consumer usage

Plan caller (copied from `examples/terraform-plan.yml`):

```yaml
name: terraform-plan
on:
  pull_request:
    paths: ["terraform/**", ".github/workflows/terraform-plan.yml"]
permissions:            # declared here too — permissions can only shrink down the chain
  id-token: write
  contents: read
  pull-requests: write
jobs:
  plan:
    uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-plan.yml@v1
    with:
      stacks: "storage catalog messaging secrets datadog mwaa"
    secrets: inherit
```

Apply caller (`examples/terraform-apply.yml`) is the twin: `on: push: branches: [main]`,
calls `terraform-apply.yml@v1`, declares `id-token: write` + `contents: read`.

## Error handling / data flow

- **Plan:** the comment step runs on `always()`; a plan diff produces a comment and a
  green check, an errored/invalid stack produces a comment and a red check naming the
  stack. The sticky comment updates in place across pushes.
- **Apply:** the protected environment gate blocks all apply steps until a reviewer
  approves; stacks apply in dependency order and stop on first failure.
- **Missing role secret:** both workflows fail fast with a message pointing at
  *Settings → Secrets and variables → Actions*.

## Testing (self-CI) and release

- **`ci.yml` on PR:**
  - `actionlint` (SHA-pinned) over all workflows and composite actions.
  - `shellcheck` (SHA-pinned) over inline/`run:` shell and composite scripts.
  - **Example smoke:** a job that calls `terraform-plan.yml` against `examples/fixture/`
    in plan-only mode with `-backend=false` (no AWS credentials) to prove the workflow
    wiring end-to-end on every PR.
- **Release:** after review, tag `@vX.Y.Z` and move the `@v1` tag to it (documented in
  `RELEASING.md`). Consumers on `@v1` pick up the change on their next run.
- **Dependabot** (`.github/dependabot.yml`) keeps the internal third-party action SHAs
  current.

## Rollout / migration

- **Phase 0** — build the workflows + composites + self-CI; tag `v1`.
- **Phase 1** — migrate **misty-mountain** to consume the reusable workflows first: its
  logic is the reference, so it is the parity check that the extraction is faithful.
- **Phase 2** — migrate **the-great-hall** and **ravenclaw** (same convention, verbatim
  copies today).
- **Phase 3** — migrate **isengard** and **Minas-Tirith** onto Convention 1 (larger, since
  they use an explicit-bucket + env-matrix layout today); tracked as separate work.

## Out of scope for v1

- Python/app-test gating and the repo-specific "populate secrets" step.
- Lambda zip / ECR container build-and-deploy workflows.
- Multi-account matrix fan-out (the-beacons pattern).
- Org `.github` UI starter templates (may be revisited once the reusable workflows are
  proven).

## Assumptions

- Consumer repos live in the same org (`Hacker0x01`) so `secrets: inherit` works.
- Each consumer already has (or will bootstrap) the OIDC deploy role stored as
  `AWS_GITHUB_ACTIONS_ROLE_ARN`, and a protected `production` environment for applies —
  matching the misty-mountain bootstrap pattern.
- Consumers follow Convention 1's on-disk layout: `<working_directory>/stacks/<stack>/`
  with a partial S3 backend (`bucket` supplied at init).

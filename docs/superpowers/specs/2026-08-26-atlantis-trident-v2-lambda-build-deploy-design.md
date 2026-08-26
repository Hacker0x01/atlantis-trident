# Atlantis Trident v2 — Lambda build + deploy (Terraform-managed)

**Status:** Approved design
**Date:** 2026-08-26
**Builds on:** the v1 Terraform CICD standard (reusable `terraform-plan.yml` /
`terraform-apply.yml` + the `setup-terraform-aws` and `tf-plan-comment`
composite actions), released as `@v1`.

## Problem

v1 standardizes plain Terraform plan/apply, but several fleet repos deploy a
**Lambda**: they build a zip and ship it. Today they do this four different
ways — `update-function-code` after apply (dobby, security-slack-bot), or
build-then-`terraform apply` (gandalf, Minas-Tirith) — with per-repo build
scripts, secret handling, and even a different role-secret name. None can adopt
v1, because v1 has no build step. v2 adds a **Lambda build + deploy** capability
so these repos can consume the standard.

## Goals

Same four as v1: kill duplication/drift, fast onboarding, enforce security &
standards, consistent DX — extended to Lambda repos.

## Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deploy model | **Terraform-managed code (Model B)** | Build the zip, then `terraform apply` deploys code + infra atomically. No infra/code drift; the plan shows code changes (`source_code_hash`); matches v1's "Terraform owns everything" ethos. dobby/security-slack-bot migrate off `update-function-code`. |
| Build step | **Pluggable `build_command`** | Packaging genuinely differs per repo (uv-export, custom bundler, `package-lambda.sh`). The repo owns *how* to build; the standard owns setup + plan/apply/comment. |
| App scope | **Single-app per invocation; caller drives any matrix** | Keeps the workflow small and composable. Multi-app repos (Minas-Tirith) call it from a `matrix` and keep per-app change-detection in their own caller. |
| App secrets | **`tf_var_secrets` passthrough → `TF_VAR_*`** | The caller assembles a `KEY=value` blob from its own named secrets; the workflow exports each as `TF_VAR_<key>` (masked). The repo's Terraform wires them wherever (Lambda env, Secrets Manager value, SSM). Flexible without hardcoding a secret list; the container+runtime pattern still works but isn't forced. |
| Workflow shape | **New dedicated Lambda workflows reusing v1 composites** | `terraform-lambda-plan.yml` + `terraform-lambda-deploy.yml`. v1's pure-TF workflows stay untouched (zero blast radius for the-great-hall/ravenclaw/misty-mountain already on `@v1`). |
| Role secret | **`AWS_GITHUB_ACTIONS_ROLE_ARN`** | Fleet-standard name (v1). gandalf migrates off `AWS_DEPLOY_ROLE_ARN`. |
| Backend / layout | **Single Terraform root at `working_directory`, v1 dynamic bucket** | `<project>-tfstate-<account>` via partial S3 backend, resolved by `setup-terraform-aws`. Adopting repos align to that backend. |
| Release | **Additive → v1.1.0, move `@v1`** | v1 workflows are unchanged; new workflows are additive, so existing `@v1` consumers are unaffected. No `@v2` tag needed. |

Rejected: Model A (`update-function-code`) — code drifts from TF state; a
standardized single builder — can't fit custom bundlers / monorepo layouts; a
multi-app-aware workflow — couples the standard to the monorepo shape; a
hardcoded fixed set of TF_VAR secrets — grows forever and bakes repo specifics
into the standard.

## New components

### `terraform-lambda-plan.yml` (reusable, PR)

- **Trigger:** `on: workflow_call`.
- **Inputs:**
  - `build_command` (required, string) — shell command that produces the zip.
  - `artifact_path` (required, string) — path to the built zip, relative to the
    workspace. Exported as `TF_VAR_lambda_zip` (absolute) before plan.
  - `working_directory` (string, default `terraform`) — the single Terraform root.
  - `python_version` (string, default `3.13`).
  - `use_uv` (boolean, default `true`) — install `uv` and run `uv sync` before build.
  - `tf_vars` (string, optional) — multiline `KEY=value` of non-secret TF vars,
    exported as `TF_VAR_<key>`.
  - `terraform_version` (string, default `1.11.4`), `aws_region` (default
    `us-west-2`), `project` (default `${{ github.event.repository.name }}`).
- **Secrets:** `tf_var_secrets` (optional) — multiline `KEY=value` blob; each
  line exported as `TF_VAR_<key>` (masked). Plus `AWS_GITHUB_ACTIONS_ROLE_ARN`
  via `secrets: inherit`.
- **Permissions:** `id-token: write`, `contents: read`, `pull-requests: write`.
- **Steps:** checkout → setup Python (+ `uv sync` if `use_uv`) → run
  `build_command` → assert `artifact_path` exists → `setup-terraform-aws`
  composite → export `TF_VAR_lambda_zip` + parsed `tf_vars`/`tf_var_secrets` →
  `terraform -chdir=<working_directory>` `fmt -check` / `validate` / `plan` →
  `tf-plan-comment` composite posts the sticky PR comment. Fmt is
  non-blocking-but-enforced (v1's pattern); a plan/validate failure fails the check.

### `terraform-lambda-deploy.yml` (reusable, main)

- Same inputs + `environment` (default `production`). **Secrets** identical.
- **Permissions:** `id-token: write`, `contents: read`.
- **Gate:** `environment: ${{ inputs.environment }}` (required reviewers).
  **Concurrency:** `terraform-lambda-deploy-${{ github.repository }}`, no cancel.
- **Steps:** checkout → setup Python (+uv) → `build_command` → assert artifact →
  `setup-terraform-aws` → export vars → `terraform -chdir=<working_directory>`
  `init` + `apply -auto-approve`.

### The build → Terraform contract

`build_command` writes a zip to `artifact_path`. The workflow exports
`TF_VAR_lambda_zip=<abs path>`. The consumer's Terraform declares
`variable "lambda_zip"` and uses it as the function's `filename` +
`source_code_hash = filebase64sha256(var.lambda_zip)`. That is the entire
coupling; the repo owns build details, the standard owns orchestration.

### Secret leak guard

Any secret passed via `tf_var_secrets` and surfaced into a resource the plan
prints (e.g. `aws_lambda_function.environment.variables`) **must be declared
`sensitive = true`** on its Terraform variable, so its value is redacted in the
`terraform plan` output posted to the PR comment. This is documented in the
README and demonstrated in the test fixture (its secret var is `sensitive`).

## Consumer usage

Plan caller (`examples/terraform-lambda-plan.yml`):

```yaml
name: terraform-lambda-plan
on:
  pull_request:
    paths: ["terraform/**", "src/**", ".github/workflows/terraform-lambda-plan.yml"]
permissions:
  id-token: write
  contents: read
  pull-requests: write
jobs:
  plan:
    uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-lambda-plan.yml@v1
    with:
      build_command: "uv run mypkg build"
      artifact_path: "dist/lambda.zip"
    secrets:
      tf_var_secrets: |
        some_api_key=${{ secrets.SOME_API_KEY }}
```

Deploy caller (`examples/terraform-lambda-deploy.yml`) is the twin on
`push: [main]`, calling `terraform-lambda-deploy.yml@v1`.

Multi-app repos add a `matrix` over apps in the caller, one call per app, with
per-app `build_command`/`artifact_path`/`working_directory`.

## Error handling / data flow

- **Plan:** build failure fails the job before plan; the comment step runs on
  `always()` and reflects real plans (or the missing-artifact/plan error).
- **Deploy:** protected-environment gate before build/apply; `terraform apply`
  is atomic (code + infra).
- **Missing artifact:** explicit failure ("`build_command` did not produce
  `artifact_path`").
- Missing role secret → fails fast (via `setup-terraform-aws`).

## Testing (self-CI) and release

- **Fixture:** `examples/lambda-fixture/` — a trivial handler, a `build_command`
  that zips it, and minimal Terraform using `var.lambda_zip` (+ a `sensitive`
  secret var wired to a Lambda env). A plan-only smoke (`aws_auth: none`,
  `-backend=false`) in atlantis-trident CI proves build → plan → comment wiring.
- **Cross-repo acceptance gate:** before moving the tag, a real call from a
  consumer repo must pass (same gate that caught the v1 composite bug) — the
  same-repo smoke cannot validate cross-repo composite resolution.
- **Release:** additive; tag `v1.1.0` and move `@v1` per `RELEASING.md`
  (composite refs already `@v1`; the new workflows reference the same).

## Per-repo adoption impact

- **dobby, security-slack-bot:** Model A → B (TF deploys the zip); build stays
  `uv`-based via `build_command`; secrets move from `put-secret-value`-into-env
  to `tf_var_secrets` (or the container pattern); partial S3 backend. Moderate.
- **gandalf:** already Model B; swap `AWS_DEPLOY_ROLE_ARN` →
  `AWS_GITHUB_ACTIONS_ROLE_ARN`; pass `TF_VAR` secrets via `tf_var_secrets`
  (mark them `sensitive`); `build_command: uv run gandalf build all`. Light-moderate.
- **Minas-Tirith:** needs its Convention-2 → Convention-1 restructure first
  (separate workstream); then adopts via a caller matrix over its apps.

## Out of scope for v2

- ECR image build + ECS deploy (Weathertop, pipeline-monitoring).
- Multi-account matrix fan-out (the-beacons).
- Detection-as-code: Datadog TF provider variant + SentinelOne script (runes).
- Non-`uv` build toolchains beyond what `build_command` already allows.

Each is a later brainstorm → spec → build cycle.

## Assumptions

- Consumers are in `Hacker0x01` (so `secrets: inherit` works) and have the OIDC
  role secret `AWS_GITHUB_ACTIONS_ROLE_ARN` + a protected `production` environment.
- The consumer's Terraform is a single root at `working_directory`, uses a
  partial S3 backend, and declares `variable "lambda_zip"` (and `sensitive` vars
  for any secret surfaced into plan output).
- `build_command` is deterministic and writes exactly `artifact_path`.

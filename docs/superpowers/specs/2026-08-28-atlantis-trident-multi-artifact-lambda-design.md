# Atlantis Trident — multi-artifact Lambda (N Lambdas in one Terraform root)

**Status:** Approved design
**Date:** 2026-08-28
**Builds on:** the v2 Lambda workflows (`terraform-lambda-plan.yml` /
`terraform-lambda-deploy.yml` + the `build-deploy-lambda` composite), `@v1`.
**Ships as:** v1.4.0 — additive; the single-artifact path is unchanged.

## Problem

The v2 Lambda deploy assumes **one artifact per Terraform root** (`artifact_path`
→ `TF_VAR_lambda_zip`). Some repos (e.g. gandalf) deploy **several Lambdas from a
single Terraform root** with **several zips** produced by one build, plus shared
resources (DynamoDB/SNS/SQS/Secrets) in that same root. Those can't adopt the
standard without splitting into multiple roots + a state migration. This adds a
way to pass **multiple** artifacts to one root.

## Key decisions

| Decision | Choice |
|----------|--------|
| Interface | New optional input **`lambda_zips`** — a JSON object `{name: relative_path}`. When set, it takes precedence over `artifact_path`. |
| Build | Unchanged: `build_command` runs **once** and produces all the zips. |
| Export | The workflow resolves each `lambda_zips` value to an absolute path, asserts it exists, and exports one **`TF_VAR_lambda_zips`** (JSON map name→abs path). The single-artifact path still exports `TF_VAR_lambda_zip`. |
| TF contract | Consumer declares `variable "lambda_zips" { type = map(string) }`; each function uses `filename = var.lambda_zips["<name>"]` + `source_code_hash = filebase64sha256(var.lambda_zips["<name>"])`. Shared resources stay in the same root — no split. |
| Matrix apps | Each app object may carry **either** `artifact_path` **or** `lambda_zips`, so a monorepo with a mix works. |
| Rejected | Splitting gandalf into 4 roots + state migration (bigger, repo-local); a repeatable `{tf_var, path}` list (looser contract than a typed map). |

## Components changed (additive)

- **`.github/workflows/terraform-lambda-plan.yml`**: add input `lambda_zips`
  (string JSON, default `""`). In the Build step, when `lambda_zips` is set,
  assert every path exists (in addition to / instead of `artifact_path`). In the
  Export step, when set, build `TF_VAR_lambda_zips` = JSON map of name→abs path
  and write it to `$GITHUB_ENV`; else keep the current `TF_VAR_lambda_zip`
  single-path behavior. `artifact_path` becomes optional (required only when
  `lambda_zips` is empty).
- **`.github/actions/build-deploy-lambda/action.yml`**: same `lambda_zips` input
  + the same build-assert and export logic (this is where the deploy path builds
  and exports).
- **`.github/workflows/terraform-lambda-deploy.yml`**: thread `lambda_zips`
  through the single-app path and allow each `ordered_apps`/`parallel_apps`
  object to include `lambda_zips` (passed to the composite).
- **Docs** (README): document `lambda_zips`, the `map(string)` TF var, the
  `var.lambda_zips["<name>"]` usage, and that shared resources stay in one root.
  RELEASING: v1.4.0 additive note.

### Export logic (both plan workflow and the composite)

```bash
# LAMBDA_ZIPS is the JSON object input; ARTIFACT_PATH the single-artifact input.
if [ -n "${LAMBDA_ZIPS:-}" ] && [ "$LAMBDA_ZIPS" != "{}" ]; then
  # resolve each value to an absolute path, assert it exists, rebuild the map
  abs_map="$(echo "$LAMBDA_ZIPS" | jq -c '
    to_entries
    | map({key, value: (.value)})   # (paths made absolute in the shell loop below)
  ')"
  # (loop: for each name/path -> [ -f path ] || error ; path=$(abspath); accumulate)
  echo "TF_VAR_lambda_zips=$resolved_json" >> "$GITHUB_ENV"
else
  abs="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)/$(basename "$ARTIFACT_PATH")"
  echo "TF_VAR_lambda_zip=$abs" >> "$GITHUB_ENV"
fi
```
(Implementation resolves absolute paths safely in bash — values via env, no
`${{ }}` in the script; Terraform reads the JSON map from `TF_VAR_lambda_zips`.)

## Build assertion

When `lambda_zips` is set, the build step asserts **every** path exists after
`build_command` (mirrors the single-artifact assert); a missing one errors with
the offending name/path.

## Test fixture

`examples/lambda-multi-fixture/`: a `build.sh` that writes **two** zips
(`dist/a.zip`, `dist/b.zip`) from two trivial handlers, and a `terraform/` root
declaring `variable "lambda_zips" { type = map(string) }` with two
provider-less-plannable `aws_lambda_function` resources using
`var.lambda_zips["a"]` / `["b"]`. A `lambda-multi-smoke` CI job calls
`terraform-lambda-plan.yml` against it with `aws_auth: none`, `lambda_zips`
`{"a":"dist/a.zip","b":"dist/b.zip"}` → offline plan proves the map wiring.

## gandalf adoption (follow-on, separate PR)

One caller: `build_command: "uv run gandalf build all"`,
`lambda_zips: {"collector":"build/collector.zip","issue_processor":"build/issue_processor.zip","create":"build/create.zip"}`,
`working_directory: terraform`; TF adds `variable "lambda_zips"` and points its 3
functions at it; `AWS_DEPLOY_ROLE_ARN`→`AWS_GITHUB_ACTIONS_ROLE_ARN`; `TF_VAR`
secrets → `tf_var_secrets`; partial S3 backend. No root split, no state migration.

## Out of scope

Per-app different build toolchains beyond `build_command`; ECR/container images;
anything already deferred in prior specs.

## Assumptions

- One `build_command` produces all zips named in `lambda_zips`.
- Consumer TF declares `variable "lambda_zips" { type = map(string) }` and uses
  the map keys as function identifiers.

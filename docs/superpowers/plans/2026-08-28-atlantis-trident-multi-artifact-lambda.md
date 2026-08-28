# Multi-artifact Lambda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let one Terraform root deploy N Lambdas via an optional `lambda_zips` JSON-map input (→ `TF_VAR_lambda_zips` map), additive to the single-artifact path. Ships as v1.4.0.

**Architecture:** Add `lambda_zips` input to `terraform-lambda-plan.yml`, `build-deploy-lambda` composite, and `terraform-lambda-deploy.yml`; when set, resolve each path to absolute, assert it exists, and export a single `TF_VAR_lambda_zips` JSON map. A 2-zip fixture + smoke proves it.

## Global Constraints

- Additive: single-artifact `artifact_path`/`TF_VAR_lambda_zip` behavior unchanged. `artifact_path` becomes required only when `lambda_zips` is empty.
- `lambda_zips` is a JSON object `{name: relative_path}`; export `TF_VAR_lambda_zips` as JSON map `{name: absolute_path}`.
- Injection-safe: all values via `env:`, never `${{ }}` in `run:` bodies. shellcheck-clean; actionlint exit 0.
- Composite refs stay `@v1`. Third-party actions stay SHA-pinned.
- TF contract: consumer declares `variable "lambda_zips" { type = map(string) }`.

---

### Task 1: Multi-zip fixture + offline plan

**Files:**
- Create: `examples/lambda-multi-fixture/handler_a.py`, `handler_b.py`
- Create: `examples/lambda-multi-fixture/build.sh` (writes `dist/a.zip`, `dist/b.zip`)
- Create: `examples/lambda-multi-fixture/terraform/main.tf`
- Modify: `.gitignore` (add `examples/lambda-multi-fixture/dist/`)

- [ ] **Step 1: handlers** — two trivial handlers:
```python
# handler_a.py
def handler(event, context):
    return {"statusCode": 200, "body": "a"}
```
(handler_b.py identical, body "b")

- [ ] **Step 2: build.sh**
```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/dist"
( cd "$here" && zip -q -j dist/a.zip handler_a.py && zip -q -j dist/b.zip handler_b.py )
echo "built a.zip + b.zip"
```

- [ ] **Step 3: terraform/main.tf** (offline-plannable; map var)
```hcl
terraform {
  required_version = ">= 1.5"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
provider "aws" {
  region                      = "us-west-2"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "test"
  secret_key                  = "test"
}
variable "lambda_zips" {
  type        = map(string)
  description = "Map of lambda name -> built zip path (exported by the workflow)."
}
resource "aws_lambda_function" "a" {
  function_name    = "atlantis-multi-fixture-a"
  filename         = var.lambda_zips["a"]
  source_code_hash = filebase64sha256(var.lambda_zips["a"])
  runtime          = "python3.13"
  handler          = "handler_a.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"
}
resource "aws_lambda_function" "b" {
  function_name    = "atlantis-multi-fixture-b"
  filename         = var.lambda_zips["b"]
  source_code_hash = filebase64sha256(var.lambda_zips["b"])
  runtime          = "python3.13"
  handler          = "handler_b.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"
}
```

- [ ] **Step 4: verify offline**
```bash
bash examples/lambda-multi-fixture/build.sh
terraform -chdir=examples/lambda-multi-fixture/terraform fmt -check
TF_VAR_lambda_zips="{\"a\":\"$PWD/examples/lambda-multi-fixture/dist/a.zip\",\"b\":\"$PWD/examples/lambda-multi-fixture/dist/b.zip\"}" \
  terraform -chdir=examples/lambda-multi-fixture/terraform init -backend=false
TF_VAR_lambda_zips="{\"a\":\"$PWD/examples/lambda-multi-fixture/dist/a.zip\",\"b\":\"$PWD/examples/lambda-multi-fixture/dist/b.zip\"}" \
  terraform -chdir=examples/lambda-multi-fixture/terraform validate
TF_VAR_lambda_zips="{\"a\":\"$PWD/examples/lambda-multi-fixture/dist/a.zip\",\"b\":\"$PWD/examples/lambda-multi-fixture/dist/b.zip\"}" \
  terraform -chdir=examples/lambda-multi-fixture/terraform plan
```
Expected: fmt exits 0; plan offline shows 2 functions to create. Fix fmt if needed.

- [ ] **Step 5: gitignore + commit**
```bash
printf '%s\n' 'examples/lambda-multi-fixture/dist/' >> .gitignore
git add examples/lambda-multi-fixture .gitignore
git commit -m "test: multi-zip lambda fixture (map var, offline-plannable)"
```

---

### Task 2: `lambda_zips` in the plan workflow + the composite

Both `terraform-lambda-plan.yml` and `build-deploy-lambda/action.yml` share the same build-assert + export logic. Apply the SAME change to both.

**Files:** Modify `.github/workflows/terraform-lambda-plan.yml`, `.github/actions/build-deploy-lambda/action.yml`

- [ ] **Step 1: add the input** — in each, add `lambda_zips` (string, default `""`). In the plan workflow make `artifact_path` no longer strictly required by keeping its default `""` (it already is in the composite; for the plan workflow, change `artifact_path: { required: true }` to `required: false, default: ""`).

- [ ] **Step 2: build-step assertion** — in the Build step, gate the single-artifact assert on `lambda_zips` being empty (the Export step asserts the map entries):
```bash
set -euo pipefail
bash -euo pipefail -c "$BUILD_COMMAND"
if [ -z "${LAMBDA_ZIPS:-}" ] || [ "$LAMBDA_ZIPS" = "{}" ]; then
  if [ ! -f "$ARTIFACT_PATH" ]; then
    echo "::error::build_command did not produce artifact_path: $ARTIFACT_PATH"; exit 1
  fi
fi
```
Add `LAMBDA_ZIPS: ${{ inputs.lambda_zips }}` to the Build step's `env:`.

- [ ] **Step 3: export step** — replace the single-artifact export with a branch on `lambda_zips`. Add `LAMBDA_ZIPS: ${{ inputs.lambda_zips }}` to the Export step `env:`:
```bash
set -euo pipefail
if [ -n "${LAMBDA_ZIPS:-}" ] && [ "$LAMBDA_ZIPS" != "{}" ]; then
  out='{}'
  n="$(jq 'length' <<< "$LAMBDA_ZIPS")"
  i=0
  while [ "$i" -lt "$n" ]; do
    key="$(jq -r "keys_unsorted[$i]" <<< "$LAMBDA_ZIPS")"
    rel="$(jq -r --arg k "$key" '.[$k]' <<< "$LAMBDA_ZIPS")"
    if [ ! -f "$rel" ]; then echo "::error::lambda_zips[$key] not found: $rel"; exit 1; fi
    abs="$(cd "$(dirname "$rel")" && pwd)/$(basename "$rel")"
    out="$(jq -c --arg k "$key" --arg v "$abs" '. + {($k): $v}' <<< "$out")"
    i=$((i + 1))
  done
  echo "TF_VAR_lambda_zips=$out" >> "$GITHUB_ENV"
else
  abs="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)/$(basename "$ARTIFACT_PATH")"
  echo "TF_VAR_lambda_zip=$abs" >> "$GITHUB_ENV"
fi
# ... (the existing emit() for tf_vars/tf_var_secrets stays, unchanged, below)
```
Keep the existing `emit()` tf_vars/tf_var_secrets logic intact after this block.

- [ ] **Step 4: validate** — `actionlint` on the plan workflow (exit 0); extract the Build + Export scripts and `shellcheck -e SC2154` them; functionally test the export loop: input `{"a":"/tmp/x","b":"/tmp/y"}` (touch those files) → `TF_VAR_lambda_zips` = `{"a":"/tmp/x","b":"/tmp/y"}` (abs); empty input → falls back to `TF_VAR_lambda_zip`.

- [ ] **Step 5: commit**
```bash
git add .github/workflows/terraform-lambda-plan.yml .github/actions/build-deploy-lambda/action.yml
git commit -m "feat: lambda_zips multi-artifact export in plan workflow + composite"
```

---

### Task 3: thread `lambda_zips` through the deploy workflow + smoke + docs

**Files:** Modify `.github/workflows/terraform-lambda-deploy.yml`, `.github/workflows/ci.yml`, `.github/workflows/terraform-lambda-plan.yml` (already has input from Task 2 — no), `README.md`, `RELEASING.md`

- [ ] **Step 1: deploy workflow** — add `lambda_zips` (string, default `""`) input; pass `lambda_zips: ${{ inputs.lambda_zips }}` to the `build-deploy-lambda` composite in BOTH deploy-ordered and deploy-parallel jobs. Also allow app-matrix objects to carry `lambda_zips`: pass `lambda_zips: ${{ matrix.app.lambda_zips }}` to the composite (a `null`/absent value renders empty → single-artifact path). Keep `artifact_path: ${{ matrix.app.artifact_path }}` too.

- [ ] **Step 2: lambda-multi-smoke job** — add to `ci.yml` (sibling of the other smokes), `needs: [lint, unit]`, permissions id-token/contents/pull-requests:
```yaml
  lambda-multi-smoke:
    needs: [lint, unit]
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    uses: ./.github/workflows/terraform-lambda-plan.yml
    with:
      build_command: "bash examples/lambda-multi-fixture/build.sh"
      lambda_zips: '{"a":"examples/lambda-multi-fixture/dist/a.zip","b":"examples/lambda-multi-fixture/dist/b.zip"}'
      working_directory: examples/lambda-multi-fixture/terraform
      use_uv: false
      aws_auth: none
```

- [ ] **Step 3: docs** — README: document `lambda_zips` (JSON map input), the `variable "lambda_zips" { type = map(string) }` contract with `var.lambda_zips["<name>"]` usage, that `build_command` runs once and must produce all listed zips, and that shared resources stay in one root. RELEASING: v1.4.0 additive note.

- [ ] **Step 4: validate** — `actionlint` (all workflows, exit 0). The `lambda-multi-smoke` runs on this branch's PR: confirm it builds both zips, plans offline against the fixture, and posts the plan comment.

- [ ] **Step 5: commit**
```bash
git add .github/workflows/terraform-lambda-deploy.yml .github/workflows/ci.yml README.md RELEASING.md
git commit -m "feat: lambda_zips in deploy workflow + multi-smoke + docs (v1.4.0)"
```

---

### Task 4: Release v1.4.0

- [ ] After CI green on `main` + a real cross-repo check (the gandalf adoption PR is the acceptance test): tag `v1.4.0`, move `@v1` (per RELEASING.md; composite refs already `@v1`).

## Self-review
- `lambda_zips` interface + export → Tasks 2, 3, matches spec. ✓
- Fixture + smoke (2 zips, offline) → Tasks 1, 3. ✓
- Additive (single-artifact unchanged; artifact_path optional) → Task 2 Step 1. ✓
- Injection-safe (env vars) + shellcheck/actionlint → Task 2/3 validate steps. ✓
- Docs + release → Task 3, 4. ✓
- Placeholder scan: none. Names consistent: `lambda_zips`, `TF_VAR_lambda_zips`, `map(string)`.

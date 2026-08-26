# Atlantis Trident v2 — Lambda build + deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable `terraform-lambda-plan.yml` / `terraform-lambda-deploy.yml` workflows that build a Lambda zip (pluggable `build_command`) and let Terraform deploy it (Model B), so Lambda repos can adopt the standard.

**Architecture:** Two new reusable workflows that reuse the existing v1 composites (`setup-terraform-aws`, `tf-plan-comment`) referenced by full path `@v1`, insert a build step, and export the artifact + optional `tf_vars`/`tf_var_secrets` as `TF_VAR_*`. Ships additively as `v1.1.0` (v1 workflows untouched).

**Tech Stack:** GitHub Actions reusable workflows, Terraform ≥1.11.4, AWS OIDC, Python 3.13 + `uv`, the v1 composite actions.

## Global Constraints

- Consumer org `Hacker0x01`; consumers pin `@v1`; `secrets: inherit`.
- The composites MUST be referenced by full path `Hacker0x01/atlantis-trident/.github/actions/<name>@v1` (a reusable workflow's `./` paths resolve against the caller — proven in v1). `@v1` already contains both composites, so this resolves during development too.
- Third-party actions pinned to full commit SHAs with a `# vN` comment. Reuse the SHAs already pinned in the repo where possible; resolve any new ones.
- Deploy model B: `build_command` writes a zip to `artifact_path`; workflow exports `TF_VAR_lambda_zip=<abs path>`; consumer TF declares `variable "lambda_zip"` used as `filename` + `source_code_hash`.
- Secrets: optional `tf_var_secrets` (workflow_call secret, multiline `KEY=value`) → each exported as masked `TF_VAR_<key>`. Optional non-secret `tf_vars` (input, same format). Any secret surfaced into plan output must be a `sensitive` TF var.
- Defaults: `terraform_version` `1.11.4`, `aws_region` `us-west-2`, `python_version` `3.13`, `use_uv` `true`, `working_directory` `terraform`, `project` = repo name, `aws_auth` `oidc` (`none` = offline plan). Deploy adds `environment` default `production`.
- Least privilege: plan job `id-token: write`+`contents: read`+`pull-requests: write`; deploy job `id-token: write`+`contents: read`. Untrusted/dynamic values passed via `env:`, never interpolated into `run:` bodies.
- Single Terraform root at `working_directory` (not a stacks loop).

---

## File structure

| File | Responsibility |
|------|----------------|
| `.github/workflows/terraform-lambda-plan.yml` | Reusable: build → plan → sticky PR comment. |
| `.github/workflows/terraform-lambda-deploy.yml` | Reusable: build → apply behind protected environment. |
| `examples/lambda-fixture/build.sh` | Zips the fixture handler into `dist/lambda.zip`. |
| `examples/lambda-fixture/handler.py` | Trivial Lambda handler (payload for the zip). |
| `examples/lambda-fixture/terraform/main.tf` | Offline-plannable TF: `aws_lambda_function` using `var.lambda_zip`, a `sensitive` secret var → Lambda env. |
| `examples/terraform-lambda-plan.yml`, `examples/terraform-lambda-deploy.yml` | Copy-paste caller snippets. |
| `.github/workflows/ci.yml` | Add a `lambda-smoke` job (plan-only, `aws_auth: none`) calling the plan workflow against the fixture. |
| `README.md`, `RELEASING.md` | Document the Lambda workflows; note the additive `v1.1.0` release. |

---

### Task 1: Lambda fixture that plans offline

Proves the whole approach (build → `var.lambda_zip` → offline `terraform plan`) before the workflows exist.

**Files:**
- Create: `examples/lambda-fixture/handler.py`
- Create: `examples/lambda-fixture/build.sh`
- Create: `examples/lambda-fixture/terraform/main.tf`

**Interfaces:**
- Produces: a `build.sh` that writes `examples/lambda-fixture/dist/lambda.zip`; a TF root at `examples/lambda-fixture/terraform` with `variable "lambda_zip"` and a `sensitive` `variable "some_secret"`.

- [ ] **Step 1: Write `handler.py`**

```python
def handler(event, context):
    return {"statusCode": 200, "body": "ok"}
```

- [ ] **Step 2: Write `build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/dist"
( cd "$here" && zip -q -j dist/lambda.zip handler.py )
echo "built $here/dist/lambda.zip"
```

- [ ] **Step 3: Write `terraform/main.tf`** (offline-plannable: skip_* flags, dummy role, artifact via var, sensitive secret into env)

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "us-west-2"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "test"
  secret_key                  = "test"
}

variable "lambda_zip" {
  type        = string
  description = "Path to the built Lambda zip (exported by the reusable workflow)."
}

variable "some_secret" {
  type        = string
  description = "Example secret injected as a Lambda env var."
  sensitive   = true
  default     = "placeholder"
}

resource "aws_lambda_function" "fixture" {
  function_name    = "atlantis-trident-lambda-fixture"
  filename         = var.lambda_zip
  source_code_hash = filebase64sha256(var.lambda_zip)
  runtime          = "python3.13"
  handler          = "handler.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"

  environment {
    variables = {
      SOME_SECRET = var.some_secret
    }
  }
}
```

- [ ] **Step 4: Verify build + offline plan locally**

Run:
```bash
bash examples/lambda-fixture/build.sh
terraform -chdir=examples/lambda-fixture/terraform fmt -check
TF_VAR_lambda_zip="$PWD/examples/lambda-fixture/dist/lambda.zip" \
  terraform -chdir=examples/lambda-fixture/terraform init -backend=false
TF_VAR_lambda_zip="$PWD/examples/lambda-fixture/dist/lambda.zip" \
  terraform -chdir=examples/lambda-fixture/terraform validate
TF_VAR_lambda_zip="$PWD/examples/lambda-fixture/dist/lambda.zip" \
  terraform -chdir=examples/lambda-fixture/terraform plan
```
Expected: build writes the zip; fmt exits 0; init/validate/plan succeed with **no AWS credentials** (the `skip_*` flags + dummy keys make plan offline) and the plan shows the function to **create**. If fmt fails, run `terraform fmt` and re-check. If plan tries to reach AWS, add any missing `skip_*`/dummy-cred settings until it plans offline; note what was needed.

- [ ] **Step 5: Add `examples/lambda-fixture/dist/` to `.gitignore`** (don't commit the built zip)

Append to `.gitignore` (create if absent): `examples/lambda-fixture/dist/`

- [ ] **Step 6: Commit**

```bash
git add examples/lambda-fixture/handler.py examples/lambda-fixture/build.sh examples/lambda-fixture/terraform/main.tf .gitignore
git commit -m "test: offline-plannable Lambda fixture for v2"
```

---

### Task 2: `terraform-lambda-plan.yml` reusable workflow

**Files:**
- Create: `.github/workflows/terraform-lambda-plan.yml`

**Interfaces:**
- Consumes: `setup-terraform-aws@v1`, `tf-plan-comment@v1` composites; `actions/checkout` (reuse the SHA already in `ci.yml` — `3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1`); `actions/setup-python` + `astral-sh/setup-uv` (resolve SHAs in Step 1).
- Produces: reusable workflow with inputs `build_command`(req), `artifact_path`(req), `working_directory`, `python_version`, `use_uv`, `tf_vars`, `terraform_version`, `aws_region`, `project`, `aws_auth`; secret `tf_var_secrets`.

- [ ] **Step 1: Resolve the two new action SHAs**

```bash
gh api repos/actions/setup-python/commits/v5 --jq .sha
gh api repos/astral-sh/setup-uv/commits/v5 --jq .sha
```
Use these exact values as `<setup-python-sha>` / `<setup-uv-sha>` below.

- [ ] **Step 2: Write `terraform-lambda-plan.yml`**

```yaml
name: terraform-lambda-plan
on:
  workflow_call:
    inputs:
      build_command: { required: true, type: string }
      artifact_path: { required: true, type: string }
      working_directory: { required: false, type: string, default: "terraform" }
      python_version: { required: false, type: string, default: "3.13" }
      use_uv: { required: false, type: boolean, default: true }
      tf_vars: { required: false, type: string, default: "" }
      terraform_version: { required: false, type: string, default: "1.11.4" }
      aws_region: { required: false, type: string, default: "us-west-2" }
      project: { required: false, type: string, default: "" }
      aws_auth: { required: false, type: string, default: "oidc" }
    secrets:
      tf_var_secrets: { required: false }

permissions:
  id-token: write
  contents: read
  pull-requests: write

concurrency:
  group: terraform-lambda-plan-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
      - name: Resolve project
        id: proj
        shell: bash
        env:
          IN_PROJECT: ${{ inputs.project }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          set -euo pipefail
          project="$IN_PROJECT"
          [ -n "$project" ] || project="$REPO_NAME"
          echo "project=$project" >> "$GITHUB_OUTPUT"
      - name: Set up Python
        uses: actions/setup-python@<setup-python-sha>  # v5
        with:
          python-version: ${{ inputs.python_version }}
      - name: Set up uv
        if: ${{ inputs.use_uv }}
        uses: astral-sh/setup-uv@<setup-uv-sha>  # v5
      - name: uv sync
        if: ${{ inputs.use_uv }}
        shell: bash
        run: uv sync --frozen || uv sync
      - name: Build Lambda artifact
        shell: bash
        env:
          BUILD_COMMAND: ${{ inputs.build_command }}
          ARTIFACT_PATH: ${{ inputs.artifact_path }}
        run: |
          set -euo pipefail
          bash -c "$BUILD_COMMAND"
          if [ ! -f "$ARTIFACT_PATH" ]; then
            echo "::error::build_command did not produce artifact_path: $ARTIFACT_PATH"
            exit 1
          fi
      - name: Setup Terraform + AWS
        id: setup
        uses: Hacker0x01/atlantis-trident/.github/actions/setup-terraform-aws@v1
        with:
          terraform_version: ${{ inputs.terraform_version }}
          aws_region: ${{ inputs.aws_region }}
          project: ${{ steps.proj.outputs.project }}
          role_arn: ${{ secrets.AWS_GITHUB_ACTIONS_ROLE_ARN }}
          aws_auth: ${{ inputs.aws_auth }}
      - name: Export TF vars
        shell: bash
        env:
          ARTIFACT_PATH: ${{ inputs.artifact_path }}
          TF_VARS: ${{ inputs.tf_vars }}
          TF_VAR_SECRETS: ${{ secrets.tf_var_secrets }}
        run: |
          set -euo pipefail
          abs="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)/$(basename "$ARTIFACT_PATH")"
          echo "TF_VAR_lambda_zip=$abs" >> "$GITHUB_ENV"
          emit() { # $1=mask|nomask  $2=KEY=value text
            local mask="$1" text="$2" line key val
            while IFS= read -r line || [ -n "$line" ]; do
              [ -z "$line" ] && continue
              key="${line%%=*}"; val="${line#*=}"
              [ -z "$key" ] && continue
              [ "$mask" = "mask" ] && echo "::add-mask::$val"
              printf 'TF_VAR_%s=%s\n' "$key" "$val" >> "$GITHUB_ENV"
            done <<< "$text"
          }
          [ -n "${TF_VARS:-}" ] && emit nomask "$TF_VARS" || true
          [ -n "${TF_VAR_SECRETS:-}" ] && emit mask "$TF_VAR_SECRETS" || true
      - name: Format check
        id: fmt
        continue-on-error: true
        shell: bash
        working-directory: ${{ inputs.working_directory }}
        run: terraform fmt -check -recursive
      - name: Plan
        id: plan
        shell: bash
        working-directory: ${{ inputs.working_directory }}
        env:
          AWS_AUTH: ${{ inputs.aws_auth }}
          STATE_BUCKET: ${{ steps.setup.outputs.state_bucket }}
        run: |
          set +e
          plans_dir="$RUNNER_TEMP/plans"
          mkdir -p "$plans_dir"
          status=0
          if [ "$AWS_AUTH" = "none" ]; then
            terraform init -input=false -backend=false || status=1
          else
            terraform init -input=false -backend-config="bucket=$STATE_BUCKET" || status=1
          fi
          terraform validate -no-color || status=1
          if ! terraform plan -input=false -no-color -out=tfplan; then status=1; fi
          terraform show -no-color tfplan > "$plans_dir/lambda.txt" 2>&1 || true
          echo "plans_dir=$plans_dir" >> "$GITHUB_OUTPUT"
          echo "status=$status" >> "$GITHUB_OUTPUT"
      - name: Comment plan on PR
        if: ${{ always() && github.event_name == 'pull_request' }}
        uses: Hacker0x01/atlantis-trident/.github/actions/tf-plan-comment@v1
        with:
          plans_dir: ${{ steps.plan.outputs.plans_dir }}
          stacks: "lambda"
      - name: Enforce results
        if: always()
        shell: bash
        env:
          FMT_OUTCOME: ${{ steps.fmt.outcome }}
          PLAN_STATUS: ${{ steps.plan.outputs.status }}
        run: |
          set -euo pipefail
          failed=0
          if [ "$FMT_OUTCOME" != "success" ]; then
            echo "::error::Format check failed. Run 'terraform fmt -recursive' to fix."
            failed=1
          fi
          if [ "$PLAN_STATUS" != "0" ]; then
            echo "::error::Lambda plan/validate failed."
            failed=1
          fi
          exit $failed
```

- [ ] **Step 3: Validate**

Run: `actionlint .github/workflows/terraform-lambda-plan.yml` (install via `brew install actionlint` if absent). Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/terraform-lambda-plan.yml
git commit -m "feat: terraform-lambda-plan reusable workflow (build + plan)"
```

---

### Task 3: `terraform-lambda-deploy.yml` reusable workflow

**Files:**
- Create: `.github/workflows/terraform-lambda-deploy.yml`

**Interfaces:**
- Consumes: same as Task 2 (SHAs already resolved), plus `environment` input.
- Produces: reusable deploy workflow (build → apply behind protected env).

- [ ] **Step 1: Write `terraform-lambda-deploy.yml`** (same build/setup/export as plan; no comment; adds environment + apply)

```yaml
name: terraform-lambda-deploy
on:
  workflow_call:
    inputs:
      build_command: { required: true, type: string }
      artifact_path: { required: true, type: string }
      working_directory: { required: false, type: string, default: "terraform" }
      python_version: { required: false, type: string, default: "3.13" }
      use_uv: { required: false, type: boolean, default: true }
      tf_vars: { required: false, type: string, default: "" }
      terraform_version: { required: false, type: string, default: "1.11.4" }
      aws_region: { required: false, type: string, default: "us-west-2" }
      project: { required: false, type: string, default: "" }
      environment: { required: false, type: string, default: "production" }
    secrets:
      tf_var_secrets: { required: false }

permissions:
  id-token: write
  contents: read

concurrency:
  group: terraform-lambda-deploy-${{ github.repository }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
      - name: Resolve project
        id: proj
        shell: bash
        env:
          IN_PROJECT: ${{ inputs.project }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          set -euo pipefail
          project="$IN_PROJECT"
          [ -n "$project" ] || project="$REPO_NAME"
          echo "project=$project" >> "$GITHUB_OUTPUT"
      - name: Set up Python
        uses: actions/setup-python@<setup-python-sha>  # v5
        with:
          python-version: ${{ inputs.python_version }}
      - name: Set up uv
        if: ${{ inputs.use_uv }}
        uses: astral-sh/setup-uv@<setup-uv-sha>  # v5
      - name: uv sync
        if: ${{ inputs.use_uv }}
        shell: bash
        run: uv sync --frozen || uv sync
      - name: Build Lambda artifact
        shell: bash
        env:
          BUILD_COMMAND: ${{ inputs.build_command }}
          ARTIFACT_PATH: ${{ inputs.artifact_path }}
        run: |
          set -euo pipefail
          bash -c "$BUILD_COMMAND"
          if [ ! -f "$ARTIFACT_PATH" ]; then
            echo "::error::build_command did not produce artifact_path: $ARTIFACT_PATH"
            exit 1
          fi
      - name: Setup Terraform + AWS
        id: setup
        uses: Hacker0x01/atlantis-trident/.github/actions/setup-terraform-aws@v1
        with:
          terraform_version: ${{ inputs.terraform_version }}
          aws_region: ${{ inputs.aws_region }}
          project: ${{ steps.proj.outputs.project }}
          role_arn: ${{ secrets.AWS_GITHUB_ACTIONS_ROLE_ARN }}
          aws_auth: oidc
      - name: Export TF vars
        shell: bash
        env:
          ARTIFACT_PATH: ${{ inputs.artifact_path }}
          TF_VARS: ${{ inputs.tf_vars }}
          TF_VAR_SECRETS: ${{ secrets.tf_var_secrets }}
        run: |
          set -euo pipefail
          abs="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)/$(basename "$ARTIFACT_PATH")"
          echo "TF_VAR_lambda_zip=$abs" >> "$GITHUB_ENV"
          emit() {
            local mask="$1" text="$2" line key val
            while IFS= read -r line || [ -n "$line" ]; do
              [ -z "$line" ] && continue
              key="${line%%=*}"; val="${line#*=}"
              [ -z "$key" ] && continue
              [ "$mask" = "mask" ] && echo "::add-mask::$val"
              printf 'TF_VAR_%s=%s\n' "$key" "$val" >> "$GITHUB_ENV"
            done <<< "$text"
          }
          [ -n "${TF_VARS:-}" ] && emit nomask "$TF_VARS" || true
          [ -n "${TF_VAR_SECRETS:-}" ] && emit mask "$TF_VAR_SECRETS" || true
      - name: Apply
        shell: bash
        working-directory: ${{ inputs.working_directory }}
        env:
          STATE_BUCKET: ${{ steps.setup.outputs.state_bucket }}
        run: |
          set -e
          terraform init -input=false -backend-config="bucket=$STATE_BUCKET"
          terraform apply -input=false -auto-approve
```

- [ ] **Step 2: Validate**

Run: `actionlint .github/workflows/terraform-lambda-deploy.yml`. Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/terraform-lambda-deploy.yml
git commit -m "feat: terraform-lambda-deploy reusable workflow (build + apply)"
```

---

### Task 4: Lambda smoke job + example callers

**Files:**
- Modify: `.github/workflows/ci.yml` (add `lambda-smoke` job)
- Create: `examples/terraform-lambda-plan.yml`, `examples/terraform-lambda-deploy.yml`

**Interfaces:**
- Consumes: `terraform-lambda-plan.yml` (Task 2), the fixture (Task 1).
- Produces: a green end-to-end plan-only smoke calling the lambda plan workflow cross-locally.

- [ ] **Step 1: Add the `lambda-smoke` job to `.github/workflows/ci.yml`** (sibling of `lint`/`unit`/`smoke`)

```yaml
  lambda-smoke:
    needs: [lint, unit]
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    uses: ./.github/workflows/terraform-lambda-plan.yml
    with:
      build_command: "bash examples/lambda-fixture/build.sh"
      artifact_path: "examples/lambda-fixture/dist/lambda.zip"
      working_directory: examples/lambda-fixture/terraform
      use_uv: false
      aws_auth: none
    secrets:
      tf_var_secrets: |
        some_secret=smoke-value
```

- [ ] **Step 2: Write `examples/terraform-lambda-plan.yml`**

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
      build_command: "uv run mypkg build"   # your build; must write artifact_path
      artifact_path: "dist/lambda.zip"
    secrets:
      # optional — assemble from your OWN secrets; each becomes TF_VAR_<key>.
      # Mark the matching TF variable `sensitive = true` if it lands in plan output.
      tf_var_secrets: |
        some_api_key=${{ secrets.SOME_API_KEY }}
```

- [ ] **Step 3: Write `examples/terraform-lambda-deploy.yml`**

```yaml
name: terraform-lambda-deploy
on:
  push:
    branches: [main]
    paths: ["terraform/**", "src/**", ".github/workflows/terraform-lambda-deploy.yml"]
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-lambda-deploy.yml@v1
    with:
      build_command: "uv run mypkg build"
      artifact_path: "dist/lambda.zip"
    secrets:
      tf_var_secrets: |
        some_api_key=${{ secrets.SOME_API_KEY }}
```

- [ ] **Step 4: Validate**

Run: `actionlint` (whole repo). Expected: exit 0. (The example callers reference `@v1`, which actionlint doesn't resolve — fine. Real end-to-end validation is the `lambda-smoke` job on this branch's PR: confirm it goes green and posts a "Terraform Plan" comment with a `lambda` section.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml examples/terraform-lambda-plan.yml examples/terraform-lambda-deploy.yml
git commit -m "feat: lambda-smoke self-test + caller examples"
```

---

### Task 5: Docs + additive release

**Files:**
- Modify: `README.md` (Lambda section), `RELEASING.md` (v1.1.0 note)

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Add a "Lambda build + deploy" section to `README.md`**

Cover: the two workflows and when to use them (Lambda repos, Model B); the inputs table (from Tasks 2/3); the **build contract** (`build_command` writes `artifact_path`; TF declares `variable "lambda_zip"` used as `filename` + `source_code_hash`); the **secrets** mechanism (`tf_var_secrets` multiline `KEY=value` → `TF_VAR_<key>`, assembled from the caller's own secrets; `tf_vars` for non-secret) and the **`sensitive = true` requirement** for any secret surfaced into plan output; pointer to `examples/terraform-lambda-{plan,deploy}.yml`; note single-app + caller matrix for monorepos.

- [ ] **Step 2: Add a `v1.1.0` note to `RELEASING.md`**

State that the Lambda workflows are additive (v1 workflows unchanged), so they ship by tagging `v1.1.0` and moving `@v1` per the existing procedure; the new workflows reference the composites at `@v1`, consistent with the release.

- [ ] **Step 3: Commit**

```bash
git add README.md RELEASING.md
git commit -m "docs: v2 Lambda workflows + v1.1.0 release note"
```

- [ ] **Step 4: Release (after CI green on main + a real cross-repo acceptance test)**

Gated exactly like v1: merge to `main`, confirm CI green, run a real cross-repo call from a consumer (e.g. a gandalf branch) before moving the tag. Then:
```bash
git tag -a v1.1.0 -m "v1.1.0 — Lambda build+deploy" && git push origin v1.1.0
git tag -f v1 v1.1.0 && git push -f origin v1
```

---

## Self-review

**Spec coverage:**
- Model B build→apply → Tasks 2, 3. ✓
- Pluggable `build_command` + `artifact_path` → Tasks 2, 3 (build step + assertion). ✓
- Single-app; caller matrix → examples note + single-root design. ✓
- `tf_var_secrets`/`tf_vars` → `TF_VAR_*`, masked → Tasks 2, 3 (Export step). ✓
- `sensitive` requirement + leak guard → fixture (`some_secret` sensitive), README. ✓
- New workflows reusing composites via full-path `@v1` → Tasks 2, 3 + Global Constraints. ✓
- Fixture + smoke + cross-repo gate → Tasks 1, 4, 5. ✓
- Additive `v1.1.0` release → Task 5. ✓
- Out-of-scope (ECR/ECS, multi-account, detection-as-code) → not planned, per spec. ✓

**Placeholder scan:** only `<setup-python-sha>`/`<setup-uv-sha>`, resolved by concrete commands in Task 2 Step 1 and substituted verbatim. No open-ended TODOs.

**Type/name consistency:** `TF_VAR_lambda_zip`, `variable "lambda_zip"`, `tf_var_secrets`/`tf_vars`, `artifact_path`/`build_command`/`working_directory`/`aws_auth`, the `emit()` helper, and `AWS_GITHUB_ACTIONS_ROLE_ARN` are used identically across Tasks 1–4. The smoke passes `use_uv: false` (the fixture build is plain `zip`, no `uv`), consistent with the `use_uv` input default of `true` for real repos.

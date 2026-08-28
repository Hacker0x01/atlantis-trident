# Atlantis Trident

Standard Terraform CICD for the fleet: centrally-maintained GitHub Actions reusable workflows for **plan-on-PR** (with a sticky PR comment) and **apply-on-main**.

One place to own the logic; every consumer references it at `@v1`. Fixes and security improvements propagate automatically.

## What it is

Atlantis Trident provides two reusable workflows:

- **`terraform-plan.yml`** — runs on pull requests: format check, validate, plan, and post a sticky PR comment with collapsible per-stack plan sections.
- **`terraform-apply.yml`** — runs on main branch pushes: applies stacks in dependency order after a protected environment approval gate.

These replace the copy-pasted inline workflows that drifted across `misty-mountain`, `the-great-hall`, `ravenclaw`, and others. Now the logic lives in one place, consumers pin `@v1`, and changes propagate on the next run.

## Onboard a repo

### 1. Copy the caller workflows

Copy `examples/terraform-plan.yml` and `examples/terraform-apply.yml` into `.github/workflows/` in your repo.

**For the plan workflow**, edit the `stacks` input to list your stacks in **dependency order** (space-separated):

```yaml
# terraform-plan.yml
with:
  stacks: "storage catalog messaging secrets datadog mwaa"
```

**For the apply workflow**, use `ordered_stacks` (applied serially) and/or `parallel_stacks` (applied in parallel after the ordered group):

```yaml
# terraform-apply.yml
with:
  ordered_stacks: "storage catalog"           # applied serially, in order
  parallel_stacks: "messaging secrets datadog mwaa"  # applied in parallel, after ordered
```

**Why the difference?** The plan workflow aggregates all stacks into a single sticky PR comment (one comment per workflow run), so it takes a single `stacks` input. The apply workflow creates one matrix job per stack, with each stack deployed to the protected environment independently (one approval per stack), so it uses the two-group inputs (`ordered_stacks`/`parallel_stacks`) to express dependencies and concurrency explicitly. The legacy `stacks` input is still supported in the apply workflow as a back-compat alias for `ordered_stacks`.

### 2. Ensure the repository has the required secret and environment

- **Secret:** `AWS_GITHUB_ACTIONS_ROLE_ARN` (repository or organization secret)  
  Set at *Settings → Secrets and variables → Actions*.  
  Value: the ARN of your OIDC-enabled GitHub Actions deploy role.

- **Protected environment:** `production` (or override with the `environment` input)  
  Set at *Settings → Environments*.  
  Configure required reviewers to gate applies.

### 3. Ensure your Terraform layout follows Convention 1

Your Terraform code must live under `<working_directory>/stacks/<stack>/` (default `working_directory` is `terraform`):

```
terraform/
  stacks/
    storage/
      main.tf
      backend.tf    # partial S3 backend: only "key" and "region"
    catalog/
      main.tf
      backend.tf
```

The state bucket name is computed as `<project>-tfstate-<account>` (where `<project>` defaults to the repository name and `<account>` is resolved from `aws sts get-caller-identity`). Do not hardcode `bucket` in your backend config — the workflow supplies it at init.

### 4. Push and open a PR

The plan workflow runs on PRs that touch `terraform/**` or `.github/workflows/terraform-plan.yml`. The apply workflow runs on merges to `main` after a reviewer approves the protected environment.

---

## Inputs reference

### `terraform-plan.yml`

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `stacks` | **Yes** | — | Space-separated, dependency-ordered stack names under `<working_directory>/stacks/`. |
| `terraform_version` | No | `1.11.4` | Terraform version to install. |
| `aws_region` | No | `us-west-2` | AWS region for OIDC and Terraform operations. |
| `project` | No | Repository name | Name prefix for the state bucket; bucket is `<project>-tfstate-<account>`. |
| `working_directory` | No | `terraform` | Directory containing the `stacks/` subdirectory. |
| `aws_auth` | No | `oidc` | Authentication mode: `oidc` (default, uses OIDC role) or `none` (offline validate/plan with `-backend=false`). |
| `state_bucket` | No | `""` | Override the derived `<project>-tfstate-<account>` bucket name. Use for repos with pre-existing/non-matching state buckets (e.g., `isengard-tfstate-<account>-us-west-2`). Your `backend.tf` still supplies the `key`. |

**Secrets:** Pass `secrets: inherit` to make `AWS_GITHUB_ACTIONS_ROLE_ARN` available (required when `aws_auth: oidc`).

**Permissions:** Declare in the caller workflow:
```yaml
permissions:
  id-token: write       # for OIDC
  contents: read
  pull-requests: write  # for the sticky comment
```

---

### `terraform-apply.yml`

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `ordered_stacks` | No | `""` | Space-separated stack names applied **serially** in the given order (one flow per stack, max-parallel 1). Use for stacks with dependencies (e.g., one reads another's `remote_state`). |
| `parallel_stacks` | No | `""` | Space-separated stack names applied **in parallel** (one flow per stack), only **after** the ordered group succeeds. Use for independent stacks. |
| `stacks` | No | `""` | **DEPRECATED** back-compat alias for `ordered_stacks`. If `ordered_stacks` is empty, this is used as the ordered group. |
| `terraform_version` | No | `1.11.4` | Terraform version to install. |
| `aws_region` | No | `us-west-2` | AWS region for OIDC and Terraform operations. |
| `project` | No | Repository name | Name prefix for the state bucket; bucket is `<project>-tfstate-<account>`. |
| `working_directory` | No | `terraform` | Directory containing the `stacks/` subdirectory. |
| `environment` | No | `production` | Protected environment name (gates apply with required reviewers). **NOTE:** Each stack is a separate deployment to this environment and needs its own approval. |
| `state_bucket` | No | `""` | Override the derived `<project>-tfstate-<account>` bucket name. Use for repos with pre-existing/non-matching state buckets (e.g., `isengard-tfstate-<account>-us-west-2`). Your `backend.tf` still supplies the `key`. |

**At least one of** `ordered_stacks` **or** `parallel_stacks` **must be provided.** The workflow will error if both are empty.

**Ordered-then-parallel model:** The workflow applies the `ordered_stacks` group first (serially, in order), then applies the `parallel_stacks` group (all in parallel) only after the ordered group succeeds. This lets you express dependencies (ordered) and independence (parallel) explicitly.

**One approval per stack:** Each stack is a separate matrix job deployed to the protected environment, so each stack triggers its own approval gate. For a workflow with 2 ordered stacks and 3 parallel stacks, you will approve 5 times total (2 serial, then 3 concurrent).

**Example:** For a repo with foundational stacks (`storage`, `catalog`) that must apply first, and independent stacks (`messaging`, `secrets`, `datadog`, `mwaa`) that can apply in parallel afterward:

```yaml
with:
  ordered_stacks: "storage catalog"
  parallel_stacks: "messaging secrets datadog mwaa"
```

**Secrets:** Pass `secrets: inherit` to make `AWS_GITHUB_ACTIONS_ROLE_ARN` available.

**Permissions:** Declare in the caller workflow:
```yaml
permissions:
  id-token: write   # for OIDC
  contents: read
```

---

## Layout contract: Convention 1

Atlantis Trident enforces **Convention 1** (the `misty-mountain` pattern):

1. **Directory structure:** `<working_directory>/stacks/<stack>/` (each stack is a root Terraform module).
2. **Partial S3 backend:** Your `backend.tf` declares `backend "s3"` with `key` and `region`, but **not** `bucket`. The workflow supplies `bucket=<project>-tfstate-<account>` at `terraform init`.
3. **State bucket naming:** `<project>-tfstate-<account>`, where:
   - `<project>` defaults to the repository name, or override with the `project` input.
   - `<account>` is resolved from `aws sts get-caller-identity` during workflow execution.
4. **Ordered stacks:** The `stacks` input is a space-separated list in dependency order. Plan validates and plans all stacks; apply applies them serially and stops on the first failure.

Example `backend.tf`:

```hcl
terraform {
  backend "s3" {
    key    = "storage/terraform.tfstate"
    region = "us-west-2"
  }
}
```

At runtime, the workflow calls:

```bash
terraform -chdir=stacks/storage init -backend-config="bucket=myrepo-tfstate-123456789012"
```

---

## Migration guide

If your repo currently has an inline Terraform CICD workflow, migrate to Atlantis Trident in these steps:

### Step 1: Align your layout to Convention 1

If you use a different state-bucket convention (e.g., an explicit hardcoded bucket or an environment matrix), refactor to the partial-backend pattern described above. The design doc lists `isengard` and `Minas-Tirith` as larger migrations tracked separately.

### Step 2: Copy the caller workflows

Copy `examples/terraform-plan.yml` and `examples/terraform-apply.yml` into `.github/workflows/` and set the `stacks` input.

### Step 3: Remove your old inline workflows

Delete your old plan-on-PR and apply-on-main workflows (or comment them out and test the new workflows first).

### Step 4: Verify the new workflows

Open a PR to verify the plan workflow posts the sticky comment correctly. After merge, verify the apply workflow gates on the protected environment and applies in order.

### Rollout order

The recommended migration order (from the design spec):

1. **misty-mountain** — first consumer (reference check, since its logic is the source).
2. **the-great-hall** and **ravenclaw** — already on Convention 1, verbatim copies today.
3. **isengard** and **Minas-Tirith** — larger migrations (currently use explicit-bucket + env-matrix layout).

---

## Versioning

- **Consumers** pin the moving `@v1` tag (`uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-plan.yml@v1`). Changes propagate automatically on the next workflow run after a release.
- **Internal actions** (third-party actions like `actions/checkout`, `hashicorp/setup-terraform`, `aws-actions/configure-aws-credentials`) are SHA-pinned and bumped by Dependabot to prevent supply-chain risks.

See `RELEASING.md` for the release procedure.

---

## Lambda build + deploy

For repos that build a Lambda function and deploy it with Terraform (**Model B**: build artifact → Terraform apply), Atlantis Trident provides two additional reusable workflows:

- **`terraform-lambda-plan.yml`** — runs on pull requests: builds the Lambda zip, exports it as `TF_VAR_lambda_zip`, runs format check + validate + plan, and posts a sticky PR comment. **Single-app only** (plans aggregate all changes into one comment).
- **`terraform-lambda-deploy.yml`** — runs on main branch pushes: builds the Lambda zip(s), exports each as `TF_VAR_lambda_zip`, and applies after a protected environment approval gate. **Supports multi-app** with `ordered_apps` and `parallel_apps` (JSON arrays of app objects), or **single-app** mode with scalar `build_command` + `artifact_path` inputs.

The deploy workflow mirrors the two-group model from `terraform-apply.yml`: you can specify `ordered_apps` (applied serially) and `parallel_apps` (applied in parallel after the ordered group), each as a JSON array of `{"build_command": "...", "artifact_path": "...", "working_directory": "..."}` objects. The workflow calls the new **`build-deploy-lambda`** composite action once per app, which encapsulates the per-app build → Terraform apply sequence.

### When to use

Use the Lambda workflows when:

1. Your repo builds a Lambda function (Python, Node, etc.) as a zip artifact.
2. Your Terraform code consumes that zip via a `variable "lambda_zip"` and uses it as the `filename` and `source_code_hash` for `aws_lambda_function`.
3. You want centralized build + deploy logic (Python + uv setup, Terraform + AWS setup, plan comments, apply gates) without copy-pasting it into every Lambda repo.

For repos that only manage Terraform stacks (no build step), use the standard `terraform-plan.yml` and `terraform-apply.yml` workflows instead.

### Onboard a Lambda repo

#### 1. Copy the caller workflows

Copy `examples/terraform-lambda-plan.yml` and `examples/terraform-lambda-deploy.yml` into `.github/workflows/` in your repo.

Edit the `build_command` and `artifact_path` inputs to match your build:

```yaml
with:
  build_command: "uv run mypkg build"   # your build command; must write artifact_path
  artifact_path: "dist/lambda.zip"      # relative path to the zip
```

#### 2. Ensure the repository has the required secret and environment

- **Secret:** `AWS_GITHUB_ACTIONS_ROLE_ARN` (repository or organization secret)  
  Set at *Settings → Secrets and variables → Actions*.  
  Value: the ARN of your OIDC-enabled GitHub Actions deploy role.

- **Protected environment:** `production` (or override with the `environment` input)  
  Set at *Settings → Environments*.  
  Configure required reviewers to gate applies.

#### 3. Declare the `variable "lambda_zip"` in your Terraform

Your Terraform code must declare:

```hcl
variable "lambda_zip" {
  type        = string
  description = "Path to the built Lambda zip (exported by the reusable workflow)."
}
```

Then reference it in your `aws_lambda_function` resource:

```hcl
resource "aws_lambda_function" "example" {
  function_name    = "my-function"
  filename         = var.lambda_zip
  source_code_hash = filebase64sha256(var.lambda_zip)
  runtime          = "python3.13"
  handler          = "handler.handler"
  role             = aws_iam_role.lambda.arn
}
```

The workflow exports `TF_VAR_lambda_zip` as an **absolute path** to the built zip, so Terraform can consume it.

#### 4. Push and open a PR

The plan workflow runs on PRs that touch `terraform/**`, `src/**`, or `.github/workflows/terraform-lambda-plan.yml`. The apply workflow runs on merges to `main` after a reviewer approves the protected environment.

---

### Build contract

- **Your `build_command` must write `artifact_path`**  
  The workflow runs your build command, then asserts that the file exists. If it doesn't, the build step fails.

- **The workflow exports `TF_VAR_lambda_zip` as an absolute path**  
  After the build, the workflow resolves the artifact path to an absolute path and exports `TF_VAR_lambda_zip=<absolute-path>` to the Terraform environment. Your Terraform code consumes it via `variable "lambda_zip"` and uses it for `filename` and `source_code_hash`.

### Secrets and TF vars

The Lambda workflows provide two mechanisms for passing values into Terraform:

1. **`tf_vars` (non-sensitive)** — multiline `KEY=value` text. Each becomes `TF_VAR_<key>`, unmasked. Use for configuration that can appear in plan output.

2. **`tf_var_secrets` (sensitive)** — multiline `KEY=value` text assembled from the caller's own secrets. Each becomes `TF_VAR_<key>`, **masked** in GitHub Actions logs. Use for secrets (API keys, passwords) that must not leak.

   **Important:** Because a named `secrets:` block precludes `secrets: inherit`, you must pass `AWS_GITHUB_ACTIONS_ROLE_ARN` explicitly:

   ```yaml
   secrets:
     AWS_GITHUB_ACTIONS_ROLE_ARN: ${{ secrets.AWS_GITHUB_ACTIONS_ROLE_ARN }}
     tf_var_secrets: |
       some_api_key=${{ secrets.SOME_API_KEY }}
   ```

3. **Mark secrets as `sensitive = true` in Terraform**  
   Any secret that appears in Terraform plan output (e.g., as a Lambda environment variable or resource tag) **must** be declared `sensitive = true` in your `variable` block. Otherwise, the value will leak into the plan comment on the PR.

   ```hcl
   variable "some_secret" {
     type        = string
     description = "API key for external service."
     sensitive   = true
   }
   ```

See `examples/terraform-lambda-plan.yml`, `examples/terraform-lambda-deploy.yml`, and `examples/lambda-fixture/terraform/main.tf` for complete examples.

---

### Inputs reference (Lambda workflows)

#### `terraform-lambda-plan.yml`

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `build_command` | **Yes** | — | Shell command to build the Lambda artifact. Must write `artifact_path`. |
| `artifact_path` | **Yes** | — | Relative path to the Lambda zip produced by `build_command`. |
| `working_directory` | No | `terraform` | Directory containing your Terraform root module. |
| `python_version` | No | `3.13` | Python version for the build (if needed). |
| `use_uv` | No | `true` | Whether to install `uv` and run `uv sync` before the build. Set to `false` if you don't use `uv`. |
| `tf_vars` | No | `""` | Multiline `KEY=value` text for non-sensitive Terraform variables. Each becomes `TF_VAR_<key>`, unmasked. |
| `terraform_version` | No | `1.11.4` | Terraform version to install. |
| `aws_region` | No | `us-west-2` | AWS region for OIDC and Terraform operations. |
| `project` | No | Repository name | Name prefix for the state bucket; bucket is `<project>-tfstate-<account>`. |
| `aws_auth` | No | `oidc` | Authentication mode: `oidc` (default, uses OIDC role) or `none` (offline validate/plan with `-backend=false`). |
| `state_bucket` | No | `""` | Override the derived `<project>-tfstate-<account>` bucket name. Use for repos with pre-existing/non-matching state buckets (e.g., `isengard-tfstate-<account>-us-west-2`). Your `backend.tf` still supplies the `key`. |

**Secrets:**
- `tf_var_secrets` (optional) — multiline `KEY=value` text for sensitive Terraform variables. Each becomes `TF_VAR_<key>`, masked in logs.
- `AWS_GITHUB_ACTIONS_ROLE_ARN` (optional, required if `aws_auth: oidc`) — ARN of the OIDC-enabled GitHub Actions role.

**Permissions:** Declare in the caller workflow:
```yaml
permissions:
  id-token: write       # for OIDC
  contents: read
  pull-requests: write  # for the sticky comment
```

---

#### `terraform-lambda-deploy.yml`

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `ordered_apps` | No | `""` | JSON array of app objects built+applied **serially** in order (one flow each). Each object: `{"build_command": "...", "artifact_path": "...", "working_directory": "..."}`. The `working_directory` field defaults to `"terraform"` if omitted. |
| `parallel_apps` | No | `""` | JSON array of app objects built+applied **in parallel**, after the ordered group. Each object: `{"build_command": "...", "artifact_path": "...", "working_directory": "..."}`. The `working_directory` field defaults to `"terraform"` if omitted. |
| `apps` | No | `""` | **DEPRECATED** back-compat alias for `parallel_apps`. |
| `build_command` | No | `""` | **(Single-app mode)** Shell command to build the Lambda artifact. Must write `artifact_path`. Used only when no app lists are provided. |
| `artifact_path` | No | `""` | **(Single-app mode)** Relative path to the Lambda zip produced by `build_command`. Used only when no app lists are provided. |
| `working_directory` | No | `terraform` | **(Single-app mode)** Directory containing your Terraform root module. Used only when no app lists are provided. |
| `python_version` | No | `3.13` | Python version for the build (if needed). |
| `use_uv` | No | `true` | Whether to install `uv` and run `uv sync` before the build. Set to `false` if you don't use `uv`. |
| `tf_vars` | No | `""` | Multiline `KEY=value` text for non-sensitive Terraform variables. Each becomes `TF_VAR_<key>`, unmasked. |
| `terraform_version` | No | `1.11.4` | Terraform version to install. |
| `aws_region` | No | `us-west-2` | AWS region for OIDC and Terraform operations. |
| `project` | No | Repository name | Name prefix for the state bucket; bucket is `<project>-tfstate-<account>`. |
| `environment` | No | `production` | Protected environment name (gates apply with required reviewers). **NOTE:** Each app is a separate deployment to this environment and needs its own approval. |
| `state_bucket` | No | `""` | Override the derived `<project>-tfstate-<account>` bucket name. Use for repos with pre-existing/non-matching state buckets (e.g., `isengard-tfstate-<account>-us-west-2`). Your `backend.tf` still supplies the `key`. |

**At least one of** `ordered_apps`, `parallel_apps`, **or the single-app scalar inputs** (`build_command` + `artifact_path`) **must be provided.** The workflow will error if all are empty.

**Ordered-then-parallel model:** The workflow builds+applies the `ordered_apps` group first (serially, in order), then builds+applies the `parallel_apps` group (all in parallel) only after the ordered group succeeds. This mirrors the `terraform-apply.yml` two-group model but for Lambda apps.

**Single-app mode:** If you provide `build_command` and `artifact_path` (and optionally `working_directory`) without any app lists, the workflow treats it as a single app in the parallel group. This mode is backward-compatible with the original single-app API.

**Per-app `working_directory`:** Each app object can specify its own `working_directory` (defaults to `"terraform"` if omitted). This lets monorepos place Terraform roots in app-specific subdirectories (e.g., `apps/foo/terraform`, `apps/bar/terraform`).

**Build contract:** Each app's `build_command` must write its `artifact_path`. The workflow calls the new `build-deploy-lambda` composite action for each app, which runs the build, exports `TF_VAR_lambda_zip` as an absolute path, and applies the Terraform root at the app's `working_directory`.

**One approval per app:** Each app is a separate matrix job deployed to the protected environment, so each app triggers its own approval gate. For a workflow with 1 ordered app and 3 parallel apps, you will approve 4 times total (1 serial, then 3 concurrent).

**Example (multi-app with groups):**

```yaml
with:
  ordered_apps: |
    [
      {"build_command": "uv run build-auth", "artifact_path": "dist/auth.zip", "working_directory": "apps/auth/terraform"}
    ]
  parallel_apps: |
    [
      {"build_command": "uv run build-api", "artifact_path": "dist/api.zip"},
      {"build_command": "uv run build-worker", "artifact_path": "dist/worker.zip"},
      {"build_command": "uv run build-notifier", "artifact_path": "dist/notifier.zip"}
    ]
```

**Example (single-app, backward-compatible):**

```yaml
with:
  build_command: "uv run mypkg build"
  artifact_path: "dist/lambda.zip"
```

**Secrets:**
- `tf_var_secrets` (optional) — multiline `KEY=value` text for sensitive Terraform variables. Each becomes `TF_VAR_<key>`, masked in logs.
- `AWS_GITHUB_ACTIONS_ROLE_ARN` (optional) — ARN of the OIDC-enabled GitHub Actions role. (Deploy always uses OIDC auth; no offline mode.)

**Permissions:** Declare in the caller workflow:
```yaml
permissions:
  id-token: write   # for OIDC
  contents: read
```

---

## Development

Self-CI runs on every PR:

- **actionlint** checks workflow and composite action YAML.
- **shellcheck** lints all shell scripts.
- **Example smoke test** calls `terraform-plan.yml` in offline mode (`aws_auth: none`) against `examples/fixture/` to verify end-to-end wiring without AWS credentials.

## License

See `LICENSE`.

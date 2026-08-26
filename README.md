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

Edit the `stacks` input to list your stacks in **dependency order** (space-separated):

```yaml
with:
  stacks: "storage catalog messaging secrets datadog mwaa"
```

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
| `stacks` | **Yes** | — | Space-separated, dependency-ordered stack names under `<working_directory>/stacks/`. |
| `terraform_version` | No | `1.11.4` | Terraform version to install. |
| `aws_region` | No | `us-west-2` | AWS region for OIDC and Terraform operations. |
| `project` | No | Repository name | Name prefix for the state bucket; bucket is `<project>-tfstate-<account>`. |
| `working_directory` | No | `terraform` | Directory containing the `stacks/` subdirectory. |
| `environment` | No | `production` | Protected environment name (gates apply with required reviewers). |

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

## Development

Self-CI runs on every PR:

- **actionlint** checks workflow and composite action YAML.
- **shellcheck** lints all shell scripts.
- **Example smoke test** calls `terraform-plan.yml` in offline mode (`aws_auth: none`) against `examples/fixture/` to verify end-to-end wiring without AWS credentials.

## License

See `LICENSE`.

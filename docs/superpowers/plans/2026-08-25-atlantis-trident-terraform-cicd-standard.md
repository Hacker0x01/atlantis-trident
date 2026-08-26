# Atlantis Trident — Terraform CICD Standard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build centrally-maintained reusable GitHub Actions workflows for Terraform plan-on-PR (with a sticky per-stack PR comment) and apply-on-main, so every consumer repo references one source of truth instead of copy-pasting CICD.

**Architecture:** Two reusable workflows (`terraform-plan.yml`, `terraform-apply.yml`, both `on: workflow_call`) delegate their shared prologue to a `setup-terraform-aws` composite action and their PR comment to a `tf-plan-comment` composite action (whose comment body is a unit-tested pure JS function). Consumers copy a ~15-line caller that pins `@v1`. The repo lints and smoke-tests itself.

**Tech Stack:** GitHub Actions (reusable workflows + composite actions), Terraform ≥1.11.4, AWS OIDC (`aws-actions/configure-aws-credentials`), Node.js 20 (`github-script` + `node --test`), actionlint + shellcheck, Dependabot.

## Global Constraints

- Consumer org is `Hacker0x01`; consumers use `secrets: inherit` (same org) and pin `@v1`.
- Terraform default version `1.11.4`; AWS region default `us-west-2`.
- Terraform layout is **Convention 1**: `<working_directory>/stacks/<stack>/` (default `working_directory` = `terraform`), partial S3 backend (`bucket` supplied at init), state bucket = `<project>-tfstate-<account>` where `project` defaults to the repo name.
- The OIDC deploy-role secret name is exactly `AWS_GITHUB_ACTIONS_ROLE_ARN`.
- All third-party actions are pinned to full-length commit SHAs (docker images pinned by digest); a trailing `# vN` comment records the human tag. Consumers reference Atlantis Trident by the moving `@v1` tag.
- Least privilege: workflow default `permissions` are minimal; the plan job adds `id-token: write` + `contents: read` + `pull-requests: write`, the apply job adds `id-token: write` + `contents: read`.
- `terraform-apply.yml` runs under a protected `environment` (default `production`); no apply step runs before environment approval.

---

## File structure

| File | Responsibility |
|------|----------------|
| `.github/actions/setup-terraform-aws/action.yml` | Composite: verify role secret, OIDC creds, install Terraform, resolve state bucket. `aws_auth: none` skips AWS for offline plan/validate. |
| `.github/actions/tf-plan-comment/build-comment.js` | Pure function that builds the sticky-comment markdown from per-stack plan files (unit-tested). |
| `.github/actions/tf-plan-comment/action.yml` | Composite: `github-script` that calls `build-comment.js` and upserts the sticky PR comment. |
| `test/build-comment.test.js` | Node `node:test` unit tests for `build-comment.js`. |
| `.github/workflows/terraform-plan.yml` | Reusable: fmt/validate/plan each stack, comment on PR. |
| `.github/workflows/terraform-apply.yml` | Reusable: apply stacks in order behind a protected environment. |
| `.github/workflows/ci.yml` | Self-CI: actionlint + shellcheck + node unit tests + end-to-end plan-only smoke. |
| `.github/dependabot.yml` | Weekly bumps for `github-actions` ecosystem (keeps internal SHAs current). |
| `examples/terraform-plan.yml`, `examples/terraform-apply.yml` | Copy-paste caller snippets for consumers. |
| `examples/fixture/stacks/hello/main.tf` | Tiny provider-less stack the smoke test plans with `-backend=false`. |
| `README.md`, `RELEASING.md` | Onboarding + inputs reference + migration guide; how to move `@v1`. |

**Known risk (validated in Phase 1, not this plan):** a reusable workflow's local `./.github/actions/...` reference resolves against Atlantis Trident's own repo when called cross-repo. The smoke test only exercises the *same-repo* path; the cross-repo `@v1` path is first proven when misty-mountain adopts it.

---

### Task 1: Repo scaffold, self-CI lint, and pinned-SHA resolution

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `README.md` (stub; expanded in Task 7)

**Interfaces:**
- Consumes: nothing.
- Produces: a resolved SHA table (recorded in `README.md` temporarily or in the PR description) that every later task substitutes into `uses:` lines. Job names `lint`, `unit`, `smoke` in `ci.yml` (later tasks add `unit`/`smoke`).

- [ ] **Step 1: Resolve and record the action SHAs**

Run these and record each `sha`/digest; substitute them into the `# vN` slots in later tasks:

```bash
gh api repos/actions/checkout/commits/v4 --jq .sha
gh api repos/actions/setup-node/commits/v4 --jq .sha
gh api repos/actions/github-script/commits/v7 --jq .sha
gh api repos/aws-actions/configure-aws-credentials/commits/v4 --jq .sha
gh api repos/hashicorp/setup-terraform/commits/v3 --jq .sha
docker buildx imagetools inspect rhysd/actionlint:1.7.7 --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect koalaman/shellcheck:v0.10.0 --format '{{.Manifest.Digest}}'
```

Throughout the plan, `<checkout-sha>`, `<setup-node-sha>`, `<github-script-sha>`, `<configure-aws-sha>`, `<setup-terraform-sha>`, `<actionlint-digest>`, `<shellcheck-digest>` mean the exact values printed here.

- [ ] **Step 2: Write `.github/workflows/ci.yml` with the `lint` job only**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<checkout-sha>  # v4
      - name: actionlint
        run: |
          set -euo pipefail
          docker run --rm -v "$PWD:/repo" -w /repo \
            rhysd/actionlint:1.7.7@<actionlint-digest> -color
      - name: shellcheck standalone scripts
        run: |
          set -euo pipefail
          shopt -s nullglob globstar
          files=(**/*.sh)
          if [ ${#files[@]} -eq 0 ]; then echo "no standalone .sh files"; exit 0; fi
          docker run --rm -v "$PWD:/mnt" -w /mnt \
            koalaman/shellcheck:v0.10.0@<shellcheck-digest> "${files[@]}"
```

- [ ] **Step 3: Write `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
```

- [ ] **Step 4: Write a `README.md` stub**

```markdown
# atlantis-trident

Standard Terraform CICD for the fleet: reusable GitHub Actions workflows for
Terraform plan-on-PR (with a sticky PR comment) and apply-on-main.

See `examples/` for caller snippets. Full docs land in Task 7.
```

- [ ] **Step 5: Validate locally**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color`
Expected: no output, exit 0 (ci.yml is the only workflow and is valid).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/dependabot.yml README.md
git commit -m "chore: repo scaffold, self-CI lint, dependabot"
```

---

### Task 2: `setup-terraform-aws` composite action

**Files:**
- Create: `.github/actions/setup-terraform-aws/action.yml`

**Interfaces:**
- Consumes: `<configure-aws-sha>`, `<setup-terraform-sha>` from Task 1.
- Produces: composite action at `./.github/actions/setup-terraform-aws` with inputs `terraform_version`, `aws_region`, `project`, `role_arn` (default `""`), `aws_auth` (default `oidc`), and output `state_bucket`.

- [ ] **Step 1: Write `action.yml`**

```yaml
name: setup-terraform-aws
description: Configure AWS via OIDC, install Terraform, and resolve the state bucket.
inputs:
  terraform_version:
    description: Terraform version to install.
    required: true
  aws_region:
    description: AWS region.
    required: true
  project:
    description: Name prefix; state bucket is <project>-tfstate-<account>.
    required: true
  role_arn:
    description: OIDC role ARN to assume (required when aws_auth=oidc).
    required: false
    default: ""
  aws_auth:
    description: "oidc = assume role and resolve bucket; none = skip AWS (offline validate/plan)."
    required: false
    default: oidc
outputs:
  state_bucket:
    description: Resolved Terraform state bucket (empty when aws_auth=none).
    value: ${{ steps.bucket.outputs.state_bucket }}
runs:
  using: composite
  steps:
    - name: Verify role secret
      if: ${{ inputs.aws_auth == 'oidc' }}
      shell: bash
      env:
        ROLE_ARN: ${{ inputs.role_arn }}
      run: |
        set -euo pipefail
        if [ -z "$ROLE_ARN" ]; then
          echo "::error::role_arn is empty. Set the AWS_GITHUB_ACTIONS_ROLE_ARN secret (Settings > Secrets and variables > Actions) and call with 'secrets: inherit'."
          exit 1
        fi
    - name: Configure AWS credentials
      if: ${{ inputs.aws_auth == 'oidc' }}
      uses: aws-actions/configure-aws-credentials@<configure-aws-sha>  # v4
      with:
        role-to-assume: ${{ inputs.role_arn }}
        aws-region: ${{ inputs.aws_region }}
    - name: Setup Terraform
      uses: hashicorp/setup-terraform@<setup-terraform-sha>  # v3
      with:
        terraform_version: ${{ inputs.terraform_version }}
    - name: Resolve state bucket
      id: bucket
      shell: bash
      env:
        AWS_AUTH: ${{ inputs.aws_auth }}
        PROJECT: ${{ inputs.project }}
      run: |
        set -euo pipefail
        if [ "$AWS_AUTH" = "oidc" ]; then
          account="$(aws sts get-caller-identity --query Account --output text)"
          echo "state_bucket=${PROJECT}-tfstate-${account}" >> "$GITHUB_OUTPUT"
        else
          echo "state_bucket=" >> "$GITHUB_OUTPUT"
        fi
```

- [ ] **Step 2: Validate**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color`
Expected: exit 0. (actionlint validates workflows; the composite is checked for YAML validity by the smoke call in Task 6. If actionlint reports nothing, proceed.)

- [ ] **Step 3: Commit**

```bash
git add .github/actions/setup-terraform-aws/action.yml
git commit -m "feat: setup-terraform-aws composite action"
```

---

### Task 3: `tf-plan-comment` composite action (TDD on the comment builder)

**Files:**
- Create: `.github/actions/tf-plan-comment/build-comment.js`
- Create: `test/build-comment.test.js`
- Create: `.github/actions/tf-plan-comment/action.yml`
- Modify: `.github/workflows/ci.yml` (add the `unit` job)

**Interfaces:**
- Consumes: `<github-script-sha>`, `<setup-node-sha>` from Task 1.
- Produces:
  - `build-comment.js` exporting `buildComment({ stacks, plansDir, headSha, runUrl, ranAt, fs })` → `string`, plus `MARKER` (string) and `stackSection(stack, body)` → `string`. `stacks` is an array; `plansDir` holds `<stack>.txt` files.
  - Composite action at `./.github/actions/tf-plan-comment` with inputs `plans_dir`, `stacks`.

- [ ] **Step 1: Write the failing test `test/build-comment.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildComment,
  MARKER,
} = require('../.github/actions/tf-plan-comment/build-comment.js');

const fakeFs = (files) => ({
  existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFileSync: (p) => files[p],
});

test('starts with marker and heading, footer has short sha and run link', () => {
  const out = buildComment({
    stacks: ['storage'],
    plansDir: '/plans',
    headSha: 'abcdef1234567890',
    runUrl: 'https://example/run',
    ranAt: '2026-08-25 00:00:00 UTC',
    fs: fakeFs({
      '/plans/storage.txt':
        'No changes. Your infrastructure matches the configuration.',
    }),
  });
  assert.ok(out.startsWith(MARKER));
  assert.match(out, /### Terraform Plan/);
  assert.match(out, /commit abcdef1 /);
  assert.match(out, /\[run\]\(https:\/\/example\/run\)/);
  assert.match(out, /✅ Stack: <code>storage<\/code>/); // green check = no changes
});

test('changes render the book emoji', () => {
  const out = buildComment({
    stacks: ['catalog'],
    plansDir: '/plans',
    headSha: '1234567',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({ '/plans/catalog.txt': 'Plan: 1 to add, 0 to change, 0 to destroy.' }),
  });
  assert.match(out, /📖 Stack: <code>catalog<\/code>/);
});

test('missing plan file renders no-plan and warning emoji', () => {
  const out = buildComment({
    stacks: ['mwaa'],
    plansDir: '/plans',
    headSha: '0000000',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({}),
  });
  assert.match(out, /\(no plan produced\)/);
  assert.match(out, /⚠️ Stack: <code>mwaa<\/code>/);
});

test('bodies over 50k chars are truncated', () => {
  const big = 'x'.repeat(60000);
  const out = buildComment({
    stacks: ['big'],
    plansDir: '/plans',
    headSha: '0000000',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({ '/plans/big.txt': big }),
  });
  assert.match(out, /\.\.\. \(truncated\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '.../build-comment.js'`.

- [ ] **Step 3: Write `build-comment.js`**

```javascript
const nodeFs = require('fs');

const MARKER = '<!-- atlantis-trident:terraform-plan -->';

function stackSection(stack, body) {
  const noChanges = body.includes(
    'No changes. Your infrastructure matches the configuration.',
  );
  // A leading "Error:" or Terraform's diagnostic gutter char (╷) means the
  // stack didn't produce a clean plan.
  const errored = /^Error:/m.test(body) || body.includes('╷');
  const emoji = noChanges ? '✅' : errored ? '⚠️' : '📖';
  let shown = body;
  if (shown.length > 50000) shown = shown.slice(0, 50000) + '\n... (truncated)';
  return [
    `<details><summary>${emoji} Stack: <code>${stack}</code></summary>`,
    '',
    '```terraform',
    shown,
    '```',
    '</details>',
  ].join('\n');
}

function buildComment({ stacks, plansDir, headSha, runUrl, ranAt, fs = nodeFs }) {
  const sections = stacks.map((stack) => {
    const f = `${plansDir}/${stack}.txt`;
    const body = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no plan produced)';
    return stackSection(stack, body);
  });
  const footer = `_Last updated ${ranAt} for commit ${headSha.slice(0, 7)} · [run](${runUrl})_`;
  return [MARKER, '### Terraform Plan', '', ...sections, '', footer].join('\n');
}

module.exports = { buildComment, stackSection, MARKER };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the composite `action.yml`**

```yaml
name: tf-plan-comment
description: Upsert a sticky PR comment with per-stack Terraform plan output.
inputs:
  plans_dir:
    description: Directory containing <stack>.txt plan files.
    required: true
  stacks:
    description: Space-separated stack names, in order.
    required: true
runs:
  using: composite
  steps:
    - uses: actions/github-script@<github-script-sha>  # v7
      env:
        PLANS_DIR: ${{ inputs.plans_dir }}
        STACKS: ${{ inputs.stacks }}
      with:
        script: |
          const { buildComment, MARKER } = require(
            `${process.env.GITHUB_ACTION_PATH}/build-comment.js`,
          );
          const stacks = process.env.STACKS.trim().split(/\s+/);
          const headSha = context.payload.pull_request?.head?.sha ?? context.sha;
          const ranAt = new Date()
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d+Z$/, ' UTC');
          const { owner, repo } = context.repo;
          const runUrl = `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
          const body = buildComment({
            stacks,
            plansDir: process.env.PLANS_DIR,
            headSha,
            runUrl,
            ranAt,
          });
          const issue_number = context.issue.number;
          const existing = await github.paginate(github.rest.issues.listComments, {
            owner, repo, issue_number, per_page: 100,
          });
          const prior = existing.find(
            (c) => c.user?.type === 'Bot' && c.body?.includes(MARKER),
          );
          if (prior) {
            await github.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body });
          } else {
            await github.rest.issues.createComment({ owner, repo, issue_number, body });
          }
```

- [ ] **Step 6: Add the `unit` job to `.github/workflows/ci.yml`**

Add this job under `jobs:` (sibling of `lint`):

```yaml
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<checkout-sha>  # v4
      - uses: actions/setup-node@<setup-node-sha>  # v4
        with:
          node-version: '20'
      - name: Unit tests
        run: node --test
```

- [ ] **Step 7: Validate and commit**

Run: `node --test` (Expected: PASS) then `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color` (Expected: exit 0).

```bash
git add .github/actions/tf-plan-comment/ test/build-comment.test.js .github/workflows/ci.yml
git commit -m "feat: tf-plan-comment composite action with unit-tested builder"
```

---

### Task 4: `terraform-plan.yml` reusable workflow

**Files:**
- Create: `.github/workflows/terraform-plan.yml`

**Interfaces:**
- Consumes: `./.github/actions/setup-terraform-aws` (Task 2), `./.github/actions/tf-plan-comment` (Task 3), `<checkout-sha>` (Task 1).
- Produces: reusable workflow callable as `.../terraform-plan.yml` with inputs `stacks` (required), `terraform_version`, `aws_region`, `project`, `working_directory`, `aws_auth`.

- [ ] **Step 1: Write `terraform-plan.yml`**

```yaml
name: terraform-plan
on:
  workflow_call:
    inputs:
      stacks:
        description: Space-separated, dependency-ordered stack names under <working_directory>/stacks/.
        required: true
        type: string
      terraform_version:
        required: false
        type: string
        default: "1.11.4"
      aws_region:
        required: false
        type: string
        default: "us-west-2"
      project:
        description: Name prefix for the state bucket; defaults to the repo name.
        required: false
        type: string
        default: ""
      working_directory:
        required: false
        type: string
        default: "terraform"
      aws_auth:
        description: "oidc (default) or none (offline validate/plan with -backend=false)."
        required: false
        type: string
        default: "oidc"

permissions:
  id-token: write
  contents: read
  pull-requests: write

concurrency:
  group: terraform-plan-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  plan:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${{ inputs.working_directory }}
    steps:
      - uses: actions/checkout@<checkout-sha>  # v4
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
      - name: Setup
        id: setup
        uses: ./.github/actions/setup-terraform-aws
        with:
          terraform_version: ${{ inputs.terraform_version }}
          aws_region: ${{ inputs.aws_region }}
          project: ${{ steps.proj.outputs.project }}
          role_arn: ${{ secrets.AWS_GITHUB_ACTIONS_ROLE_ARN }}
          aws_auth: ${{ inputs.aws_auth }}
      - name: Format check
        shell: bash
        run: terraform fmt -check -recursive
      - name: Plan each stack
        id: plan
        shell: bash
        env:
          STATE_BUCKET: ${{ steps.setup.outputs.state_bucket }}
          STACKS: ${{ inputs.stacks }}
          AWS_AUTH: ${{ inputs.aws_auth }}
        run: |
          set +e
          plans_dir="$RUNNER_TEMP/plans"
          mkdir -p "$plans_dir"
          status=0
          for stack in $STACKS; do
            echo "::group::plan $stack"
            if [ "$AWS_AUTH" = "none" ]; then
              terraform -chdir="stacks/$stack" init -input=false -backend=false \
                || { status=1; echo "::endgroup::"; continue; }
            else
              terraform -chdir="stacks/$stack" init -input=false -backend-config="bucket=$STATE_BUCKET" \
                || { status=1; echo "::endgroup::"; continue; }
            fi
            terraform -chdir="stacks/$stack" validate -no-color || status=1
            terraform -chdir="stacks/$stack" plan -input=false -no-color -out="tfplan.$stack"
            [ $? -ne 0 ] && status=1
            terraform -chdir="stacks/$stack" show -no-color "tfplan.$stack" \
              > "$plans_dir/$stack.txt" 2>&1 || true
            echo "::endgroup::"
          done
          echo "plans_dir=$plans_dir" >> "$GITHUB_OUTPUT"
          exit $status
      - name: Comment plans on PR
        if: ${{ always() && github.event_name == 'pull_request' }}
        uses: ./.github/actions/tf-plan-comment
        with:
          plans_dir: ${{ steps.plan.outputs.plans_dir }}
          stacks: ${{ inputs.stacks }}
```

- [ ] **Step 2: Validate**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color`
Expected: exit 0. (End-to-end behavior is proven by the smoke test in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/terraform-plan.yml
git commit -m "feat: terraform-plan reusable workflow"
```

---

### Task 5: `terraform-apply.yml` reusable workflow

**Files:**
- Create: `.github/workflows/terraform-apply.yml`

**Interfaces:**
- Consumes: `./.github/actions/setup-terraform-aws` (Task 2), `<checkout-sha>` (Task 1).
- Produces: reusable workflow callable as `.../terraform-apply.yml` with inputs `stacks` (required), `terraform_version`, `aws_region`, `project`, `working_directory`, `environment`.

- [ ] **Step 1: Write `terraform-apply.yml`**

```yaml
name: terraform-apply
on:
  workflow_call:
    inputs:
      stacks:
        description: Space-separated, dependency-ordered stack names under <working_directory>/stacks/.
        required: true
        type: string
      terraform_version:
        required: false
        type: string
        default: "1.11.4"
      aws_region:
        required: false
        type: string
        default: "us-west-2"
      project:
        required: false
        type: string
        default: ""
      working_directory:
        required: false
        type: string
        default: "terraform"
      environment:
        description: Protected environment gating the apply (required reviewers).
        required: false
        type: string
        default: "production"

permissions:
  id-token: write
  contents: read

concurrency:
  group: terraform-apply-${{ github.repository }}
  cancel-in-progress: false

jobs:
  apply:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    defaults:
      run:
        working-directory: ${{ inputs.working_directory }}
    steps:
      - uses: actions/checkout@<checkout-sha>  # v4
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
      - name: Setup
        id: setup
        uses: ./.github/actions/setup-terraform-aws
        with:
          terraform_version: ${{ inputs.terraform_version }}
          aws_region: ${{ inputs.aws_region }}
          project: ${{ steps.proj.outputs.project }}
          role_arn: ${{ secrets.AWS_GITHUB_ACTIONS_ROLE_ARN }}
          aws_auth: oidc
      - name: Apply stacks in order
        shell: bash
        env:
          STATE_BUCKET: ${{ steps.setup.outputs.state_bucket }}
          STACKS: ${{ inputs.stacks }}
        run: |
          set -e
          for stack in $STACKS; do
            echo "::group::apply $stack"
            terraform -chdir="stacks/$stack" init -input=false -backend-config="bucket=$STATE_BUCKET"
            terraform -chdir="stacks/$stack" apply -input=false -auto-approve
            echo "::endgroup::"
          done
```

- [ ] **Step 2: Validate**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/terraform-apply.yml
git commit -m "feat: terraform-apply reusable workflow"
```

---

### Task 6: Fixture stack, caller examples, and end-to-end plan-only smoke

**Files:**
- Create: `examples/fixture/stacks/hello/main.tf`
- Create: `examples/terraform-plan.yml`
- Create: `examples/terraform-apply.yml`
- Modify: `.github/workflows/ci.yml` (add the `smoke` job)

**Interfaces:**
- Consumes: `./.github/workflows/terraform-plan.yml` (Task 4).
- Produces: a green end-to-end smoke that calls the plan workflow against the fixture with `aws_auth: none`, and the two consumer snippet files.

- [ ] **Step 1: Write the fixture stack `examples/fixture/stacks/hello/main.tf`**

```hcl
terraform {
  required_version = ">= 1.5"
}

variable "greeting" {
  type    = string
  default = "hello"
}

output "greeting" {
  value = var.greeting
}
```

- [ ] **Step 2: Verify the fixture is fmt-clean and plans offline**

Run:
```bash
terraform -chdir=examples/fixture/stacks/hello fmt -check
terraform -chdir=examples/fixture/stacks/hello init -backend=false
terraform -chdir=examples/fixture/stacks/hello validate
terraform -chdir=examples/fixture/stacks/hello plan
```
Expected: fmt exits 0; init/validate/plan succeed with no provider downloads.

- [ ] **Step 3: Add the `smoke` job to `.github/workflows/ci.yml`**

Add under `jobs:`:

```yaml
  smoke:
    needs: [lint, unit]
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    uses: ./.github/workflows/terraform-plan.yml
    with:
      stacks: "hello"
      working_directory: examples/fixture
      aws_auth: none
```

- [ ] **Step 4: Write `examples/terraform-plan.yml` (consumer snippet)**

```yaml
name: terraform-plan
on:
  pull_request:
    paths: ["terraform/**", ".github/workflows/terraform-plan.yml"]
permissions:
  id-token: write
  contents: read
  pull-requests: write
jobs:
  plan:
    uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-plan.yml@v1
    with:
      stacks: "storage catalog"   # space-separated, in dependency order
    secrets: inherit
```

- [ ] **Step 5: Write `examples/terraform-apply.yml` (consumer snippet)**

```yaml
name: terraform-apply
on:
  push:
    branches: [main]
    paths: ["terraform/**", ".github/workflows/terraform-apply.yml"]
permissions:
  id-token: write
  contents: read
jobs:
  apply:
    uses: Hacker0x01/atlantis-trident/.github/workflows/terraform-apply.yml@v1
    with:
      stacks: "storage catalog"
    secrets: inherit
```

- [ ] **Step 6: Validate**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7@<actionlint-digest> -color`
Expected: exit 0. (The example snippets reference `@v1`, which does not exist until Task 7 tags it; actionlint does not resolve external refs, so this passes. The real end-to-end validation is the `smoke` job running in the PR for this branch — confirm it goes green and posts a single "Terraform Plan" comment.)

- [ ] **Step 7: Commit**

```bash
git add examples/ .github/workflows/ci.yml
git commit -m "feat: fixture stack, caller examples, end-to-end plan smoke"
```

---

### Task 7: Documentation and v1 release

**Files:**
- Modify: `README.md` (full onboarding + inputs reference + migration guide)
- Create: `RELEASING.md`

**Interfaces:**
- Consumes: everything above.
- Produces: complete docs and the `v1` tag consumers pin to.

- [ ] **Step 1: Write the full `README.md`**

Replace the stub with sections: (1) what it is; (2) **Onboard a repo** — copy `examples/terraform-plan.yml` and `examples/terraform-apply.yml` into `.github/workflows/`, set `stacks`, ensure the repo has the `AWS_GITHUB_ACTIONS_ROLE_ARN` secret and a protected `production` environment; (3) **Inputs reference** — a table for each workflow (name, required, default, meaning) copied from Tasks 4 and 5; (4) **Layout contract** — Convention 1 (`terraform/stacks/<stack>/`, partial S3 backend, `<project>-tfstate-<account>`); (5) **Migration guide** — order misty-mountain → the-great-hall/ravenclaw → isengard/Minas-Tirith, and how to replace an inline workflow with the caller; (6) **Versioning** — consumers pin `@v1`; internal actions are SHA-pinned and bumped by Dependabot.

- [ ] **Step 2: Write `RELEASING.md`**

Document the release procedure:

```markdown
# Releasing

Consumers pin the moving `@v1` tag. To cut a release after changes merge to `main`:

1. Create an immutable version tag:
   `git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0`
2. Move the major alias to it:
   `git tag -f v1 v1.0.0 && git push -f origin v1`

Every consumer on `@v1` picks up the change on its next run. Only move `@v1`
after CI (lint + unit + smoke) is green on `main`.
```

- [ ] **Step 3: Commit docs**

```bash
git add README.md RELEASING.md
git commit -m "docs: onboarding, inputs reference, migration, releasing"
```

- [ ] **Step 4: Merge to main, then tag v1 (after CI is green)**

Run (after the PR merges and `main` CI is green):
```bash
git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
git tag -f v1 v1.0.0 && git push -f origin v1
```
Expected: `v1` and `v1.0.0` exist on the remote; a consumer referencing `@v1` resolves.

---

## Self-review

**Spec coverage:**
- Reusable `terraform-plan.yml` + sticky comment → Tasks 3, 4. ✓
- Reusable `terraform-apply.yml` + protected environment → Task 5. ✓
- `setup-terraform-aws` + `tf-plan-comment` composites → Tasks 2, 3. ✓
- Convention 1 (dynamic bucket, ordered stacks, `-chdir`) → Tasks 2, 4, 5 + Global Constraints. ✓
- Consumer `@v1` pinning + internal SHA-pinning + Dependabot → Global Constraints, Tasks 1, 6, 7. ✓
- Self-CI: actionlint + shellcheck + plan-only smoke → Tasks 1, 3 (unit), 6 (smoke). ✓
- Copy-paste caller snippets → Task 6. ✓
- Migration/rollout guidance → Task 7 (README). ✓
- Out-of-scope items (Python CI, Lambda/ECR, multi-account, org UI templates) → not planned, per spec. ✓

**Additive deviation from spec:** an `aws_auth` input (`oidc`|`none`) was added to `terraform-plan.yml` / `setup-terraform-aws`. Rationale: it is required to run the approved "plan-only, no-AWS-creds" smoke as a genuine end-to-end call of the reusable workflow, and doubles as a real offline-validate feature. Default `oidc` preserves the approved behavior. This is the only interface change.

**Placeholder scan:** SHA/digest slots (`<checkout-sha>`, etc.) are resolved by concrete commands in Task 1 Step 1 and substituted verbatim — not open-ended TODOs. No other placeholders.

**Type/name consistency:** `buildComment`/`MARKER`/`stackSection`, `state_bucket` output, `aws_auth`/`plans_dir`/`stacks` input names, and the `AWS_GITHUB_ACTIONS_ROLE_ARN` secret are used identically across Tasks 2–6.

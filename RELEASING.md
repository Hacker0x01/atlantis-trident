# Releasing

Consumers pin the moving `@v1` tag. To cut a release after changes merge to `main`:

1. Verify readiness:
   - CI (lint + unit + smoke) is green on `main`
   - A real cross-repo invocation has been verified. The same-repo smoke CANNOT
     validate cross-repo composite resolution — a reusable workflow's `./` paths
     resolve against the caller, so the composites are referenced by full
     `owner/repo/.github/actions/<name>@<ref>` and must be exercised by a call
     from another repo (the acceptance-test PR in a consumer repo).
2. **Point the internal composite refs at the tag you're about to cut.** In
   `terraform-plan.yml` (setup + tf-plan-comment) and `terraform-apply.yml`
   (setup), change the `…/.github/actions/<name>@…` refs to `@v1`, and merge.
   (Pre-v1 they point at `@main` for verification; `@v1` consumers must not pull
   composites from a moving `@main`, or a `main` change would hit them.)
3. Create an immutable version tag on that commit:
   ```bash
   git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
   ```
4. Move the major alias to it:
   ```bash
   git tag -f v1 v1.0.0 && git push -f origin v1
   ```

Every consumer on `@v1` picks up the change on its next run. At `@v1` the
workflow references composites `@v1`, so workflow and composites move together.

To cut a later version (e.g. `v1.1.0`): repeat — bump the composite refs to the
new tag, tag it, move `@v1`. The composite refs are the one internal thing that
must be bumped by hand each release (Dependabot doesn't track same-repo refs).

## v1.1.0 — Lambda workflows

The Lambda workflows (`terraform-lambda-plan.yml` and `terraform-lambda-deploy.yml`) are **additive** — the v1 multi-stack workflows (`terraform-plan.yml` and `terraform-apply.yml`) are unchanged. Both sets ship together by tagging `v1.1.0` and moving the `@v1` alias per the procedure above. The Lambda workflows reference the same shared composites (`setup-terraform-aws`, `tf-plan-comment`) at `@v1`, consistent with the release.

## v1.2.0 — Ordered + parallel stack/app groups

This release introduces the **ordered-then-parallel two-group model** to `terraform-apply.yml` and `terraform-lambda-deploy.yml`:

- **`terraform-apply.yml`** now accepts `ordered_stacks` (applied serially in order) and `parallel_stacks` (applied in parallel after the ordered group), in addition to the legacy `stacks` input (which is now a back-compat alias for `ordered_stacks`). Each stack is a separate deployment to the protected environment → one approval per stack.

- **`terraform-lambda-deploy.yml`** now accepts `ordered_apps` and `parallel_apps` (JSON arrays of app objects), in addition to the legacy single-app scalar inputs (`build_command`/`artifact_path`) and the deprecated `apps` input (back-compat alias for `parallel_apps`). Calls the new **`build-deploy-lambda`** composite action once per app. Each app is a separate deployment to the protected environment → one approval per app.

**This is a v1.x release (not v2)** because the changes are **backward-compatible**:
- Existing consumers using `stacks: "foo bar"` continue to work (the stacks apply serially, as before, via the `stacks` → `ordered_stacks` alias).
- Existing consumers using single-app scalar inputs (`build_command` + `artifact_path`) continue to work (they are folded into a 1-element parallel group).
- The new inputs (`ordered_stacks`/`parallel_stacks`, `ordered_apps`/`parallel_apps`) are opt-in.

However, this **changes released v1 behavior** (it's not purely additive): existing `@v1` consumers will receive the new two-group apply shape when they move the `@v1` tag to v1.2.0. Their workflows will continue to apply serially (via the back-compat alias), but the underlying implementation changes from a single loop to an ordered-then-parallel matrix. **Release is gated on a real cross-repo acceptance test** to verify that the back-compat alias and the new two-group model both work correctly in a consumer repo.

## Maintenance

The docker-pinned actionlint/shellcheck digests in `ci.yml` are NOT tracked by Dependabot. Bump them manually on a quarterly cadence.

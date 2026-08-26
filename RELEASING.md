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

## Maintenance

The docker-pinned actionlint/shellcheck digests in `ci.yml` are NOT tracked by Dependabot. Bump them manually on a quarterly cadence.

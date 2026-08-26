# Releasing

Consumers pin the moving `@v1` tag. To cut a release after changes merge to `main`:

1. Verify readiness:
   - CI (lint + unit + smoke) is green on `main`
   - A real cross-repo invocation has been verified (the smoke only tests the same-repo path; the first consumer — misty-mountain — is the acceptance test for cross-repo `./` composite resolution before moving `@v1` to the fleet)
2. Create an immutable version tag:
   ```bash
   git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
   ```
3. Move the major alias to it:
   ```bash
   git tag -f v1 v1.0.0 && git push -f origin v1
   ```

Every consumer on `@v1` picks up the change on its next run.

## Maintenance

The docker-pinned actionlint/shellcheck digests in `ci.yml` are NOT tracked by Dependabot. Bump them manually on a quarterly cadence.

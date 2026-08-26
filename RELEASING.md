# Releasing

Consumers pin the moving `@v1` tag. To cut a release after changes merge to `main`:

1. Create an immutable version tag:
   ```bash
   git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
   ```
2. Move the major alias to it:
   ```bash
   git tag -f v1 v1.0.0 && git push -f origin v1
   ```

Every consumer on `@v1` picks up the change on its next run. Only move `@v1` after CI (lint + unit + smoke) is green on `main`.

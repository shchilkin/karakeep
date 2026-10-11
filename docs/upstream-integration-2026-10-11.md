# Upstream integration — 2026-10-11

This local integration branch combines the fork at `9f1f4042b0dbe4713f5f96d795d62bb65f57c3cb` with upstream `55247937f32753e8105e7b906c3351b1e9ac58f4`: exactly 89 upstream commits. The fork has 79 commits not present upstream. The common ancestor is `5a2f009e2f6d266087f2f3f527e6e384cefd6de4`.

Branch: `codex/karakeep-upstream-89`. No push, PR, main integration, deployment, production data access, or paid AI requests are part of this change.

## Conflict resolution

- Keep upstream's reorganized crawler and Patchright/browser improvements. Reapply direct-video routing and first-frame posters, close media probe streams, validate downloaded asset content types, persist image dimensions, and preserve automatic local/hybrid catalog requests. Move direct-video helpers and tests into `workers/utils`.
- Preserve Sensitive editing and the accessible bookmark action label in upstream's grouped menu. Include the Sensitive dialog in its focus-restoration guard. Retain the tag editor's pills variant.
- Preserve thumbnails, hover clips, manual image sets, retained imports, and account-deletion guards while accepting upstream upload limits, shared-list fixes, and Better Auth.
- Keep migrations `0000`–`0104` and their snapshots unchanged. Append the upstream Better Auth SQL as `0105_migrate_to_better_auth.sql`, with a new combined schema snapshot and a timestamp later than the existing journal. Its SQL is identical to upstream's `0094_migrate_to_better_auth.sql`.
- Migrate the fork's AI workspace to the shared Better Auth session adapter and update its OpenAPI owner-session cookie documentation.
- Retain the fork's isolated E2E runner, diagnostic collection, Python contracts and media tests. Adopt Garage, install Playwright Chromium and add the new server auth tests to CI. Adapt preview checks to the fork's accessible Note field and bound E2E concurrency to four files against the shared service stack.
- Regenerate the lockfile from upstream plus fork-only dependencies; align Sharp across packages. Update the web test JSX transform for Vite 8 and exclude generated `.next` copies so tests also pass after a production build.
- Disable redundant dependency verification for Docker's `ncc` and `next` commands, consistent with the existing workers build. The base stage already installs with `--frozen-lockfile`; later stages must not reinstall the Docker-pruned workspace.

## Verification

- Typecheck: 23 tasks passed.
- Lint: 20 tasks passed, warnings remain; no errors.
- Format: 21 tasks passed.
- Sherif: no errors; five existing workspace/root-package warnings.
- JavaScript/TypeScript tests: 1,245 passed (shared 147, shared-server 11, tRPC 616, workers 152, API 36, web 124, MCP 57, durable queue 2).
- Python contracts: 92 passed (deployment gate 16, Sensitive 12, local catalog 5, GPU runtime 6, Nextcloud migration 53).
- Added regression coverage for migrating a populated fork database, preserving immutable imported content, originals, image sets and local batches, migrating legacy password/OAuth records, and running migration twice. Existing auth tests cover legacy password validation.
- Crawler coverage exercises real SQLite transitions, retained original video bytes and real FFmpeg posters, image dimensions, rejected HTML/login downloads, and local/hybrid routing.
- OpenAPI regenerated with the new session cookie.
- Workers, CLI and MCP builds passed. Workers reports an optional Redis `@node-rs/xxhash` import warning.
- Web production build passed; all 124 web tests also passed after the build.
- Docker AIO and Chromium images built successfully on local ARM64. Full Docker/browser E2E: 161 tests passed across 23 files with four workers, including sign-up/sign-in, preview notes, lists, search, crawler, feeds, imports, video, filesystem and S3 assets. Test containers were removed by teardown.
- The initial unrestricted E2E run exposed two incompatible Note selectors plus shared-server connection/hook failures under higher concurrency. After the selector and concurrency corrections the complete suite passed.
- Native mobile app binaries were not built; mobile TypeScript checks passed. Optional Redis/Restate plugin service suites are disabled in the existing CI and were not part of the validated run.

## Reproducing the checks

Use the repository's Node 24 and pnpm 11.2.1 toolchain. Standard checks are `pnpm preflight`, `pnpm exec sherif`, and `pnpm --filter @karakeep/open-api check`. Run the CI unit/Python package commands from `.github/workflows/ci.yml`.

For the complete E2E suite, use a dedicated `COMPOSE_PROJECT_NAME`, install Playwright Chromium, build `chrome` and `web` using `packages/e2e_tests/docker-compose.yml`, then run `pnpm test:no-build` inside `packages/e2e_tests`. The Vitest configuration bounds concurrency to four workers. The local verification used a separate temporary Playwright browser directory; its installation needed Node 24.12.0 because local Node 24.16.0 stalled while extracting Chromium. Application checks ran on Node 24.16.0; Docker uses the upstream-pinned Node 24.18.1 image.

## Future rollout consideration

Better Auth intentionally replaces existing sessions and verification/reset tokens. Existing users will need to sign in again after a future deployment. Password and OAuth records are converted by migration 0105. This run uses synthetic test databases only; no production migration or deployment has occurred.

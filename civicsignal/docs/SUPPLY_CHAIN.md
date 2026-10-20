# Supply chain

How dependencies, build tooling and images are controlled, and what is **not** controlled yet.
State as of 2026-10-20. Every number below comes from a command run on that date.

## Controls in CI (`.github/workflows/civicsignal-ci.yml`)

| Control | How | Fails the build when |
|---|---|---|
| Secret scanning | `node scripts/scan-secrets.mjs --history`. Rules cover private keys, cloud and SaaS tokens, JWTs, URLs with passwords, assigned secrets and `.env`-style values. It scans every tracked file and every added line in history. Output gives rule, file and line (or commit), **never the value**. | Any finding not in `scripts/secret-scan-allowlist.txt` (each entry carries a reason) |
| Lockfile | `npm ci` installs exactly `package-lock.json` | `package.json` and the lockfile disagree |
| Known vulnerabilities (deps) | `npm audit --omit=dev --audit-level=high` | A high or critical advisory in a **production** dependency |
| Licences | `node scripts/check-licenses.mjs` over the installed production tree (API and web) | A strong-copyleft licence (GPL, AGPL, SSPL, BUSL, Commons-Clause), or a weak-copyleft or unknown licence without a recorded review in `scripts/license-reviews.json` |
| Migrations | Applied to an empty PostgreSQL 16, then backup and `verify-restore.sh` | Any migration error; any restore, row-count, RLS, privilege or audit-chain mismatch |
| Container images | `docker build` of api and web, then Trivy `aquasec/trivy:0.56.2` (`--severity HIGH,CRITICAL --ignore-unfixed`) | A fixable high or critical vulnerability in OS packages or `node_modules` |
| Build context | `.dockerignore` excludes host `node_modules`, build output, `.env*` and dumps | — (prevents host secrets or binaries entering layers) |

Deployment (`civicsignal-deploy.yml`) builds from the exact commit that passed CI and deploys **by image digest**.

## Current results (2026-10-20)
- **`npm audit --omit=dev`:** 0 vulnerabilities.
- **`npm audit` (all, including dev tooling):** 39 advisories (32 high, 7 moderate). They all come through three direct dev dependencies: `jest`, `@types/jest` and `tailwindcss`. Each fix is a semver-major upgrade.
  - These packages run at build and test time only and are not in the runtime images (`npm prune --omit=dev`; Trivy found none in the images).
  - They are **not** auto-upgraded. Upgrade each in its own PR with the full test suite and a UI check (tailwind).
- **Licences:** 201 production packages: 168 MIT, 12 Apache-2.0, 9 ISC, 3 BSD-3-Clause, and a few others.
  Reviewed exceptions, recorded in `license-reviews.json` with reasons:
  - `png-js` declares no licence field; its LICENSE file is MIT.
  - The sharp/libvips binaries are LGPL-3.0-or-later. They are dynamically linked and unmodified, which is allowed with conditions: keep the licence notices, and allow replacement of the library.
  
  This is an engineering screen, **not legal advice**. Have counsel confirm the policy before distribution to a customer.
- **Images (Trivy 0.56.2, DB of 2026-10-20):**
  - The first scan found 7 fixable issues in `perl-base` from the `node:22-bookworm-slim` base and 10 in npm's own bundled dependencies, in both images.
  - Fix: the runtime stages now apply Debian updates and remove npm, npx and corepack.
  - Rescan: **0 fixable HIGH/CRITICAL** in both images. Unfixed and lower-severity findings are not gating; review them in the full report.
- **Secret scan:** 269 tracked files, 0 findings; 21 allow-listed occurrences (test fixtures and documented placeholders), tree plus history.

## Reproducibility
- Dependencies are pinned by the lockfile and installed with `npm ci`.
- Base images are pinned by **tag** (`node:22-bookworm-slim`, `postgres:16`, `redis:7`, `caddy:2`), not digest. Builds on different days can therefore get different base layers.
  **Open:** pin by digest and update through a reviewed PR (Renovate or Dependabot with digest pinning).
- GitHub Actions are pinned by **major tag** (`actions/checkout@v4`, `actions/setup-node@v4`). **Open:** pin to full commit SHAs. Do not take SHAs from memory: resolve them from the action's releases at the time of pinning.
- The Trivy image is pinned to a version tag. **Open:** pin by digest after verifying it against Aqua's signed release.
- Builds are not bit-for-bit reproducible: timestamps and npm metadata vary. The guarantee is "same commit + same lockfile + same base digest → functionally identical image".

## Not yet in place
| Item | Why it matters | Suggested step |
|---|---|---|
| SBOM per release | Lets the customer check exposure to a new CVE without access to the build | `trivy image --format cyclonedx` in the deploy workflow; attach to the run and the registry |
| Image signing and provenance | Lets the deployment agent verify that the image came from this workflow | cosign keyless signing plus SLSA provenance in `civicsignal-deploy.yml`; agent verifies before pulling |
| Automated update PRs | Prevents silent drift and missed patches | Renovate or Dependabot, grouped, never auto-merged, full CI required |
| Branch protection | Stops unreviewed changes reaching `main` | Require PR review, green `civicsignal-ci` and up-to-date branches (repository settings, outside this code) |
| Private registry mirror | Reduces exposure to npm or registry compromise | Mirror with an allow-list, used by CI and builds |

## Policy for changing dependencies
1. One purpose per PR (security fix, feature need, or a major upgrade), with the reason in the description.
2. Before adding a dependency, check maintenance, licence, install scripts, and transitive size.
3. The full CI must pass. For a major upgrade, also read its changelog and test the affected feature manually.
4. Never run `npm audit fix --force` across the tree.

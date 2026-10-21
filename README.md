# Paseo plugins

Plugins for [Paseo](https://github.com/getpaseo/paseo) by [Kingsley](https://github.com/kingsleydon).

| Plugin | What it does | npm | Source |
|---|---|---|---|
| [Recap](plugins/recap) | Writes a short recap of each agent's goal, progress, and next step after every turn | `npm:paseo-recap` | `github:kingsleydon/paseo-plugins:plugins/recap` |
| [Quick prompts](plugins/quick-prompts) | Saved prompts as one-tap pills above every agent's composer | `npm:paseo-quick-prompts` | `github:kingsleydon/paseo-plugins:plugins/quick-prompts` |

Install either source with `paseo plugin install <source>`, or paste it into **Settings → Plugins →
Plugin source**. Plugins must be enabled on the daemon (**Settings → Plugins → Enable plugins**).

This repository was previously `kingsleydon/paseo-recap`; old URLs redirect here.

## Layout

Each plugin lives in its own folder under `plugins/` with its own `package.json` and lockfile.
There is no root package and no npm workspaces; run commands inside the plugin folder:

```bash
cd plugins/recap
npm ci
npm run typecheck
npm test
```

CI runs the type check and tests for every plugin on pull requests and pushes to `main`.

## Releasing

Versions, changelogs, and GitHub Releases come from [release-please](https://github.com/googleapis/release-please),
and releases publish to npm from GitHub Actions with [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC), so no npm token is stored anywhere.

1. Title PRs with [Conventional Commits](https://www.conventionalcommits.org/), scoped to the plugin
   folder: `fix(recap): ...`, `feat(quick-prompts): ...`. PRs are squash-merged with the PR title as
   the commit title, and [`.github/workflows/pr-title.yml`](.github/workflows/pr-title.yml) checks
   the title. release-please assigns each commit on `main` to the plugins whose files it changes.
   `fix` bumps the patch version, `feat` the minor version, and `!` (breaking) the minor version
   while a plugin is below 1.0; `docs`, `chore`, `ci`, and similar types do not release.
2. [`.github/workflows/release.yml`](.github/workflows/release.yml) keeps one release PR open that
   bumps `version` in each changed plugin's `package.json` and `package-lock.json` and adds the
   entry to its `CHANGELOG.md`.
3. Merging the release PR tags each plugin `<folder>-v<version>` (for example `recap-v0.2.5`) and
   creates its GitHub Release with the changelog entry. The tag starts
   [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

`publish.yml` checks that `plugins/<folder>` exists and that its version matches the tag, then runs
`npm ci`, the type check, and the tests, and publishes that folder with provenance. The job runs in
the `npm` GitHub environment, which only `*-v*` tags can deploy to, and npm trusts only that workflow
and environment.

release-please runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY`
secret) with Contents, Issues, and Pull requests write access on this repository. Events made with
the default `GITHUB_TOKEN` do not start workflows, so the App token is what lets CI run on the
release PR and the release tag start `publish.yml`.

Release state lives in [`release-please-config.json`](release-please-config.json) and
[`.release-please-manifest.json`](.release-please-manifest.json); release-please updates the
manifest, so do not edit versions by hand. Dependabot keeps the pinned action SHAs up to date.

## License

[MIT](LICENSE)

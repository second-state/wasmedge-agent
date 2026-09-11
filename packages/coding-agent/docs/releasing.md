# Releasing

`.github/workflows/build-binaries.yml` builds and publishes WasmEdge Agent. It
only runs on `workflow_dispatch`; nothing publishes on a push. This page is
for the first time you dispatch it.

The release host is GitHub Releases on the repository the workflow runs in.
`<base>` is `https://github.com/<owner>/<repo>/releases` for that repository,
unless the `WASMEDGE_AGENT_DOWNLOAD_BASE_URL` repository variable is set to
something else.

## Order

Dispatch beta first, then production.

```bash
gh workflow run build-binaries.yml -f channel=beta
gh workflow run build-binaries.yml -f channel=production -f release_tag=vX.Y.Z
```

A beta dispatch always runs from the default branch. A production dispatch
runs from the default branch, or from the commit `release_tag` already
tags -- that second form is how you re-run a production release that failed
partway.

## Prerequisites

- **A green `ci.yml` run on the commit being released.** The workflow reads
  that commit's check runs and refuses to build if the aggregate is not a
  success, or if it cannot find one. It runs no tests of its own.
- **`## [Unreleased]` cut to a version heading, for a production dispatch.**
  Before dispatching production, edit
  `packages/coding-agent/CHANGELOG.md` so the entry you are shipping reads
  `## [X.Y.Z] - <date>` instead of `## [Unreleased]`. The workflow extracts
  that section as the GitHub release's notes; if it finds no matching
  heading, the notes fall back to a bare `Release vX.Y.Z` line.
- **`package.json`'s version, for a beta dispatch.** A beta build tags itself
  `v<package.json version>-beta.<run number>.<commit>`. Make sure that
  version is the one you mean to ship as beta before you dispatch.

## What a run publishes

Two URL shapes carry every published object:

- `<base>/download/v<version>/<file>` -- a version release's own assets. This
  object never changes once published; a rebuild that produced different
  bytes for an existing version is refused.
- `<base>/download/<channel>/<file>` -- a channel's current assets, where
  `<channel>` is `beta`. Stable has no channel release of its own: its assets
  are the current version release's assets, served through GitHub's `latest`
  alias at `<base>/latest/download/<file>`.

A production dispatch publishes one version release, tagged `v<version>`, and
marks it `latest` if its version is newer than (or equal to, on a re-run) the
version currently marked latest -- by semantic version, not by publish date.
That release carries nine assets: the four packed tarballs (`wasmedge-agent`
and its three internal dependencies), `SHA256SUMS`, `release.json`, the
`stable` version-pointer file, `install.sh` rendered for the stable channel,
and `latest.json` (a copy of `release.json`).

A beta dispatch publishes two releases. The version release, tagged
`v<beta-version>` and marked prerelease, carries seven assets: the four packed
tarballs, `SHA256SUMS`, `release.json`, and the `beta` version-pointer file,
all built for that beta build. The `beta` channel release has its tag
force-moved onto the commit just built, and its three assets -- `beta.json`,
the `beta` version-pointer file, and `install.sh` rendered for the beta channel
-- are re-uploaded with `--clobber`. Only the channel release update requires
`main` to still be at the commit that was built; the version release publishes
regardless.

## Recovery

`gh release create` with assets is a draft until every asset finishes
uploading. A run that dies partway through a create leaves that draft behind.
The next run finds it (`gh release view` sees drafts by tag), refuses, and
names what to do:

```bash
gh release delete <tag> --yes   # removes the draft; the tag stays
```

Re-run the workflow after deleting the draft. When `gh release delete` removes
the draft, the release no longer exists, so the re-run takes the create branch
and uploads all assets. If the re-run instead finds a complete, non-draft
release already there, it uploads only the assets that are missing or absent;
anything that matches is left alone, and anything present under the same name
with different bytes fails the run rather than being replaced.

A production dispatch that rebuilds a version older than the repository's
current latest release publishes that version's assets normally, but leaves
the `latest` alias where it is. That is by design, not a failure to fix.

### Re-running a production release when `main` has moved

If `main` has advanced past the commit `vX.Y.Z` names and the release for that
tag needs finishing, re-run the workflow from that tag's commit:

```bash
gh workflow run build-binaries.yml --ref vX.Y.Z -f channel=production -f release_tag=vX.Y.Z
```

This re-runs the production build and publish steps against that commit,
regardless of where `main` is now.

## The repository is private

Until this repository is public, its release assets do not resolve
anonymously -- the URLs above return 404 to an unauthenticated request, even
though they are correct. `gh release download <tag>` works meanwhile, using
your own GitHub credentials, and is the way to validate a release before the
repository goes public.

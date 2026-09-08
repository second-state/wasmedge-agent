#!/bin/sh
# Refuses to clobber a GitHub release asset with different bytes.
#
# The companion to guard-immutable-release.sh, for the other half of a
# release. That one protects the R2 bucket; the uploads here go up with
# `gh release upload --clobber`, which replaces an existing asset of the same
# name without asking. GitHub assets are not immutable the way the bucket's
# are, but they are what `install.sh` and every human downloading a release
# actually fetch, so replacing one silently is the same class of problem: two
# people holding different bytes for one version.
#
# The bucket guard cannot cover this, and one case makes that concrete. The
# packer stamps the publication host into the public package's manifest, so
# the same commit and version packed against a different R2_PUBLIC_BASE_URL
# produce different tarball bytes. Point the workflow at a new bucket and
# re-run an old version from its own commit: the tag check passes, because the
# commit really is the tagged one, and the bucket guard sees an empty prefix,
# because the bucket is new. Only the release's existing assets still remember
# what v<version> was.
#
# Usage: guard-immutable-github-assets.sh <repo> <tag> <local-dir>
#
# Only the assets this run is about to upload are considered. A release may
# legitimately carry others, and those are not this run's business.
#
# Every one of them is guarded. There used to be an exemption for the beta
# release's rolling pointer files, which is gone with the rolling release
# itself: each beta now publishes under a tag of its own, so no asset of any
# release is expected to change.
#
# It fails closed, and that has to include the question of whether the release
# exists at all. One request answers both -- does this tag have a release, and
# what is on it -- and only an explicit 404 counts as "no". Every other failure
# is an authentication error, a rate limit, a network blip or a 5xx, none of
# which say anything about what is published; reading them as absence would
# wave the caller straight through to `gh release upload --clobber`, which is
# the one thing this exists to stop.

set -eu

repo=${1:?repository (owner/name) required}
tag=${2:?release tag required}
local_dir=${3:?local release directory required}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if gh api "repos/${repo}/releases/tags/${tag}" --jq '.assets[].name' > "$work/assets" 2> "$work/probe.err"; then
	:
elif grep -q '(HTTP 404)' "$work/probe.err"; then
	echo "No GitHub release $tag yet; it will be created."
	exit 0
else
	echo "Could not determine what GitHub release $tag holds -- refusing to publish." >&2
	echo "Only an explicit 404 means the release is absent; every other error leaves the question open." >&2
	cat "$work/probe.err" >&2
	exit 1
fi

replaced=0
for artifact in "$local_dir"/*; do
	[ -f "$artifact" ] || continue
	name=$(basename "$artifact")
	grep -qxF "$name" "$work/assets" || continue

	rm -f "$work/$name"
	if ! gh release download "$tag" --repo "$repo" --pattern "$name" --dir "$work" --clobber > /dev/null 2> "$work/err"; then
		echo "GitHub release $tag already has $name, but it could not be downloaded -- refusing to replace it." >&2
		cat "$work/err" >&2
		exit 1
	fi

	if ! cmp -s "$work/$name" "$artifact"; then
		echo "GitHub release $tag already has $name with different bytes; refusing to replace it." >&2
		echo "Anyone who already downloaded $tag has the other copy. Release a new version." >&2
		exit 1
	fi
	replaced=$((replaced + 1))
done

echo "GitHub release $tag: $replaced existing asset(s) match this build; the rest are new."

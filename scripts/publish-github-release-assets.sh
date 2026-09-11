#!/bin/sh
# Uploads this release's assets to a GitHub release that already exists,
# deciding each one against what is on the release at the moment it decides.
#
# The workflow used to answer this from a listing taken earlier: the guard
# compared bytes before anything was published, and the upload loop then kept
# every asset whose *name* was already on the release. Between those two steps
# a tag is created and a release is written, which is time enough for another
# holder of the same token to add an asset. One that
# appears in that window has a name the loop recognises and bytes nothing ever
# looked at, and the loop keeps it.
#
# So the comparison happens here instead, beside the decision it informs:
# absent, upload it; present and identical, keep it; present and different,
# refuse. Nothing uses `gh release upload --clobber`, and nothing deletes an
# asset -- a re-run of a release that was complete must not pass through a
# state where it is missing a file it already had.
#
# Usage: publish-github-release-assets.sh <repo> <tag> <local-dir>
#
# Fails closed, the way the guard does. Only an explicit 404 is an answer
# about what is published; an expired token, a rate limit and a 5xx all look
# like an absent asset to anything reading an exit status alone, and reading
# one as absence is what would let this upload beside a copy it never saw.

set -eu

repo=${1:?repository (owner/name) required}
tag=${2:?release tag required}
local_dir=${3:?local release directory required}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if gh api "repos/${repo}/releases/tags/${tag}" --jq '.assets[].name' > "$work/assets" 2> "$work/probe.err"; then
	:
else
	echo "Could not read what GitHub release $tag holds -- refusing to publish into it." >&2
	cat "$work/probe.err" >&2
	exit 1
fi

kept=0
uploaded=0
for artifact in "$local_dir"/*; do
	[ -f "$artifact" ] || continue
	name=$(basename "$artifact")

	if grep -qxF "$name" "$work/assets"; then
		rm -f "$work/$name"
		if ! gh release download "$tag" --repo "$repo" --pattern "$name" --dir "$work" --clobber > /dev/null 2> "$work/err"; then
			echo "GitHub release $tag already has $name, but it could not be downloaded -- refusing to publish over it." >&2
			cat "$work/err" >&2
			exit 1
		fi
		if ! cmp -s "$work/$name" "$artifact"; then
			echo "GitHub release $tag already has $name with different bytes; refusing to replace it." >&2
			echo "Anyone who already downloaded $tag has the other copy. Release a new version." >&2
			exit 1
		fi
		echo "Keeping $name, which matches this build."
		kept=$((kept + 1))
		continue
	fi

	# No --clobber: an asset that appeared since the listing above fails the
	# upload rather than replacing something this run never compared.
	gh release upload "$tag" "$artifact" --repo "$repo"
	uploaded=$((uploaded + 1))
done

echo "GitHub release $tag: kept $kept asset(s), uploaded $uploaded."

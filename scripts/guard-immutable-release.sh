#!/bin/sh
# Refuses to publish over a release version that is already in the bucket with
# different bytes.
#
# Those objects go up with a one-year immutable cache policy, so a replacement
# cannot be corrected: caches keep serving whichever copy they got first, and
# two people can hold different bytes for the same URL forever. The tag check
# in the workflow's release-context job catches the usual way a second build of
# one version happens; this catches the rest, a tag moved after the fact
# included.
#
# The one safe republish is a byte-identical one, and it has to stay allowed:
# a publish step that fails halfway is re-run, and the packer rebuilds every
# workspace from source before it packs, so two clean packs of one commit hash
# identically. That includes the half-finished case, which is the likeliest
# reason anyone re-runs at all -- the tarballs go up before SHA256SUMS does, so
# an interruption between them leaves a prefix holding some of this release and
# none of another. Refusing that outright would make one bad minute of network
# cost the version forever, repairable only by hand. So the rule is not "the
# same objects" but "no object that differs": every object already there must
# match its local counterpart byte for byte, and the ones that are missing are
# the ones this run uploads.
#
# It fails closed. A probe that cannot read the bucket has not learned that the
# version is free -- an expired token, a throttled endpoint and a network blip
# all look exactly like an absent object to anything that only checks an exit
# status, and reading any of them as absence is what lets a retry overwrite
# another commit's bytes. Only a listing that succeeds and comes back empty is
# evidence of anything.
#
# Usage: guard-immutable-release.sh <bucket> <endpoint-url> <prefix> <local-dir>
#
# Lives in a file rather than inline in the workflow so its five outcomes --
# absent, unreadable, mismatched contents, mismatched object set, and an
# identical retry -- can be tested against a stub aws.

set -eu

bucket=${1:?bucket required}
endpoint=${2:?endpoint url required}
prefix=${3:?release prefix required}
local_dir=${4:?local release directory required}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

test -f "$local_dir/SHA256SUMS"
test -f "$local_dir/release.json"

# Listing the whole prefix, not just SHA256SUMS. A publish that failed after
# its tarballs and before its checksums leaves a release a SHA256SUMS-only
# probe reads as absent, and finishing it from a different commit is the exact
# outcome this guard exists to prevent.
if ! aws s3api list-objects-v2 \
	--bucket "$bucket" \
	--prefix "$prefix/" \
	--endpoint-url "$endpoint" \
	--query 'Contents[].Key' \
	--output text > "$work/listing" 2> "$work/listing.err"; then
	echo "Could not list s3://$bucket/$prefix/ -- refusing to publish." >&2
	echo "This check is what keeps a retry from replacing immutable objects, and a result it could not read is not a result that says the version is free." >&2
	cat "$work/listing.err" >&2
	exit 1
fi

# One tab-separated line, or the literal "None" when the prefix holds nothing.
# Keeping only the keys under the prefix drops that sentinel without a special
# case: every real key starts with it.
tr '[:space:]' '\n' < "$work/listing" | awk -v p="$prefix/" 'index($0, p) == 1' | sort > "$work/published-keys"

if [ ! -s "$work/published-keys" ]; then
	echo "s3://$bucket/$prefix/ is empty; publishing."
	exit 0
fi

for artifact in "$local_dir"/*.tgz "$local_dir/SHA256SUMS" "$local_dir/release.json"; do
	echo "$prefix/$(basename "$artifact")"
done | sort > "$work/local-keys"

# An object under this prefix that this release does not produce was put there
# by something else, and nothing here knows what. That is a question for a
# person, not a guard.
if [ -n "$(comm -23 "$work/published-keys" "$work/local-keys")" ]; then
	echo "s3://$bucket/$prefix/ holds objects this release does not produce; refusing to publish into it." >&2
	comm -23 "$work/published-keys" "$work/local-keys" >&2
	exit 1
fi

# Byte for byte, not by checksum manifest: in the half-finished case the
# manifest is exactly the object that did not make it, so there is nothing to
# compare the tarballs against but the tarballs.
while read -r key; do
	name=${key#"$prefix/"}
	if ! aws s3 cp "s3://$bucket/$key" "$work/published-$name" \
		--endpoint-url "$endpoint" > /dev/null 2> "$work/get.err"; then
		echo "s3://$bucket/$key is published, but it could not be read; refusing to publish over it." >&2
		cat "$work/get.err" >&2
		exit 1
	fi
	if ! cmp -s "$work/published-$name" "$local_dir/$name"; then
		echo "s3://$bucket/$key is already published with different bytes; refusing to replace it." >&2
		echo "Immutable objects cannot be corrected once caches hold them. Release a new version." >&2
		exit 1
	fi
done < "$work/published-keys"

if cmp -s "$work/published-keys" "$work/local-keys"; then
	echo "s3://$bucket/$prefix/ already holds these exact bytes; republishing is a no-op."
else
	echo "s3://$bucket/$prefix/ is a partial publish of these exact bytes; completing it."
fi

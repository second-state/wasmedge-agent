#!/bin/sh
# Publishes one object of a release, and refuses to replace anything.
#
# The guards around this compare before they write, which leaves the window
# between the two. Another holder of these credentials can publish different
# bytes inside it, and the write below would replace them: the guard that runs
# afterwards sees only what this run put there and passes, while caches that
# fetched in between keep serving the other copy -- for a year, under a URL
# whose whole promise is that it never changes.
#
# So the write itself carries the condition. `--if-none-match '*'` creates the
# object only if there is nothing at that key, which is one operation rather
# than a check and a write, and nothing this workflow does can slip between its
# halves.
#
# The one publish that has to survive is the byte-identical retry: a run that
# fails after some objects went up is re-run, and the packer rebuilds from
# source, so two clean packs of one commit produce one set of bytes. A refused
# condition is therefore not a failure on its own -- it is a question about
# what is already there, and this answers it by comparing.
#
# Usage: publish-immutable-object.sh <bucket> <endpoint-url> <key> <file> <content-type>

set -eu

bucket=${1:?bucket required}
endpoint=${2:?endpoint url required}
key=${3:?object key required}
file=${4:?local file required}
content_type=${5:?content type required}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

test -f "$file"

# A conditional write can also come back 409 ConditionalRequestConflict, which
# says another conditional request for this key is in flight and this one was
# not evaluated. It is not an answer about what is published -- S3 documents it
# as retryable -- so it is retried rather than read as either outcome.
attempt=1
attempts=5
while :; do
	if aws s3api put-object \
		--bucket "$bucket" \
		--key "$key" \
		--body "$file" \
		--content-type "$content_type" \
		--cache-control 'public, max-age=31536000, immutable' \
		--if-none-match '*' \
		--endpoint-url "$endpoint" > /dev/null 2> "$work/err"; then
		echo "Published s3://$bucket/$key."
		exit 0
	fi

	if ! grep -q 'ConditionalRequestConflict' "$work/err"; then
		break
	fi
	if [ "$attempt" -ge "$attempts" ]; then
		echo "s3://$bucket/$key stayed in conditional-request conflict after $attempts attempts." >&2
		cat "$work/err" >&2
		exit 1
	fi
	sleep "$attempt"
	attempt=$((attempt + 1))
done

# A CLI too old to make a conditional write cannot publish here at all.
# Falling back to an unconditional one would publish exactly the way this
# exists to stop, and would do it silently.
if grep -q 'Unknown options' "$work/err"; then
	echo "This aws CLI does not support --if-none-match, so it cannot publish an immutable object safely." >&2
	echo "Upgrade the CLI on the runner; publishing without the condition is not an option." >&2
	cat "$work/err" >&2
	exit 1
fi

# Every other failure that is not the condition is a failure. An expired
# token, a throttled endpoint and a 5xx say nothing about what is published.
if ! grep -qE 'PreconditionFailed|pre-conditions' "$work/err"; then
	echo "Could not publish s3://$bucket/$key." >&2
	cat "$work/err" >&2
	exit 1
fi

# Something is already at this key. It is publishable only if it is this.
if ! aws s3 cp "s3://$bucket/$key" "$work/published" \
	--endpoint-url "$endpoint" > /dev/null 2> "$work/get.err"; then
	echo "s3://$bucket/$key already exists, but it could not be read; refusing to go on." >&2
	cat "$work/get.err" >&2
	exit 1
fi

if ! cmp -s "$work/published" "$file"; then
	echo "s3://$bucket/$key is already published with different bytes." >&2
	echo "Immutable objects cannot be corrected once caches hold them. Release a new version." >&2
	exit 1
fi

echo "s3://$bucket/$key already holds these exact bytes."

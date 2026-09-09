#!/bin/sh
# Moves the beta channel pointer forward, and only forward.
#
# The freshness check before this reads the default branch and then writes,
# and no amount of re-reading closes the gap between the two: main can advance
# in it, and the older build's pointer is then what every beta install
# resolves. Re-checking narrows the window; it cannot remove it.
#
# What removes it is making the decision and the write one operation. A beta
# version ends in the run that produced it, and run numbers only ever go up,
# so the pointer already carries the ordering: this reads what the pointer
# names, refuses to publish under a run that is not newer, and writes with
# --if-match on the ETag it read. If another run moved the pointer in between,
# the condition fails rather than the write landing, and the whole decision is
# taken again against what is there now.
#
# Usage: advance-beta-pointer.sh <bucket> <endpoint-url> <key> <file> <content-type>

set -eu

bucket=${1:?bucket required}
endpoint=${2:?endpoint url required}
key=${3:?object key required}
file=${4:?local file required}
content_type=${5:?content type required}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

test -f "$file"

# The manifest is parsed, and not matched. This object is what every installer
# and every update check reads, so the helper that publishes it has no business
# being looser about it than they are: a pointer naming a manifest nothing can
# parse is a channel nothing can install. An artifact that arrived truncated is
# the ordinary way that happens, and a truncation after the version field reads
# as a perfectly good version.
case $content_type in
*json*)
	command -v node > /dev/null 2>&1 || {
		echo "node is needed to read the JSON at $key, and it is not on PATH." >&2
		echo "Refusing to move $key." >&2
		exit 1
	}
	;;
esac

# The version this file names, and nothing it merely contains. A manifest names
# its version once, in `version`, and then repeats it in the tarball path and in
# every file under `tarballs`, so a match over the whole file lands on the right
# string only for as long as those agree -- and a stable manifest, whose paths
# still name the beta it was cut from, is where they stop agreeing.
version_of() {
	case $content_type in
	*json*)
		# The ${} below are JavaScript template holes, and not shell ones.
		# shellcheck disable=SC2016
		node -e '
const { readFileSync } = require("node:fs");
let doc;
try {
	doc = JSON.parse(readFileSync(process.argv[1], "utf8"));
} catch (error) {
	process.stderr.write(`${process.argv[1]} is not JSON: ${error.message}\n`);
	process.exit(1);
}
if (typeof doc?.version !== "string") {
	process.stderr.write(`${process.argv[1]} has no top-level string version field.\n`);
	process.exit(1);
}
process.stdout.write(doc.version);
' "$1"
		;;
	*)
		# The text pointer is the version, on the only line it has.
		awk '{ line = $0 } END { if (NR == 1) print line }' "$1"
		;;
	esac
}

# The run out of a beta version: 0.7.0-beta.<run>.<commit>. A version this
# does not match is one this cannot order, and guessing is the one thing a
# pointer that must not go backwards cannot afford.
#
# The run is bounded at 18 digits because the comparison below is the shell's,
# and a value past its integer range does not compare false -- it fails. Under
# dash, which is /bin/sh on the runners, `[ -ge ]` prints "Illegal number" and
# reports false from inside an `if` condition that set -e does not see, so an
# older run reads as newer and takes the pointer. A run number is a counter
# that reached six figures at most, so anything longer is a file to refuse
# rather than a number to widen the comparison for.
beta_run() {
	version_of "$1" |
		sed -n 's/^v\{0,1\}[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-beta\.\([0-9]\{1,18\}\)\.[0-9A-Za-z][0-9A-Za-z]*$/\1/p'
}

mine=$(beta_run "$file")
if [ -z "$mine" ]; then
	echo "$file does not name a single beta version with a run number; refusing to move $key." >&2
	exit 1
fi

attempt=1
attempts=5
while :; do
	if etag=$(aws s3api get-object \
		--bucket "$bucket" \
		--key "$key" \
		--endpoint-url "$endpoint" \
		--query ETag \
		--output text "$work/published" 2> "$work/err"); then
		published=$(beta_run "$work/published")
		if [ -z "$published" ]; then
			echo "s3://$bucket/$key does not name a single beta version with a run number." >&2
			echo "Nothing here can tell whether this build is newer than it, so the pointer stays." >&2
			exit 1
		fi
		if [ "$published" -ge "$mine" ]; then
			echo "s3://$bucket/$key already names run $published; this build is run $mine, so it stays."
			exit 0
		fi
		condition="--if-match"
		condition_value="$etag"
	elif grep -qE 'NoSuchKey|Not Found|404' "$work/err"; then
		# Nothing published yet, so the write must be the one that creates it.
		condition="--if-none-match"
		condition_value="*"
	else
		echo "Could not read s3://$bucket/$key -- refusing to move it." >&2
		cat "$work/err" >&2
		exit 1
	fi

	if aws s3api put-object \
		--bucket "$bucket" \
		--key "$key" \
		--body "$file" \
		--content-type "$content_type" \
		--cache-control no-cache \
		"$condition" "$condition_value" \
		--endpoint-url "$endpoint" > /dev/null 2> "$work/put.err"; then
		echo "s3://$bucket/$key now names run $mine."
		exit 0
	fi

	if grep -q 'Unknown options' "$work/put.err"; then
		echo "This aws CLI does not support $condition, so it cannot move the pointer safely." >&2
		echo "Upgrade the CLI on the runner; an unconditional write can publish an older beta." >&2
		cat "$work/put.err" >&2
		exit 1
	fi

	# The pointer moved under this run, which is the case the condition is
	# here to catch: everything above is decided again against what is there
	# now, and the newer build usually wins on the next pass.
	if ! grep -qE 'PreconditionFailed|pre-conditions|ConditionalRequestConflict' "$work/put.err"; then
		echo "Could not move s3://$bucket/$key." >&2
		cat "$work/put.err" >&2
		exit 1
	fi
	if [ "$attempt" -ge "$attempts" ]; then
		echo "s3://$bucket/$key kept changing under this run after $attempts attempts." >&2
		cat "$work/put.err" >&2
		exit 1
	fi
	sleep "$attempt"
	attempt=$((attempt + 1))
done

#!/bin/sh
# Moves a channel pointer forward, and only forward.
#
# The checks before this read something -- the default branch, or the tag a
# release claims -- and then write, and no amount of re-reading closes the gap
# between the two: the world can move in it, and the older build's pointer is
# then what every install of that channel resolves. Re-checking narrows the
# window; it cannot remove it.
#
# What removes it is making the decision and the write one operation. The
# version already carries the ordering, so this reads what the pointer names,
# refuses to publish under a version that is not newer, and writes with
# --if-match on the ETag it read. If another run moved the pointer in between,
# the condition fails rather than the write landing, and the whole decision is
# taken again against what is there now.
#
# Two channels order two ways. A beta version ends in the run that produced it
# and run numbers only ever go up; a release names X.Y.Z, chosen by hand, and
# orders field by field. Both are versions of one question, which is why they
# are one script: the retry, the conditions and the refusals are the same, and
# the production channel had none of them.
#
# Exits 3 when the published pointer already names a later version, which is a
# decision and not a failure: another build owns this channel. A caller that
# publishes other things alongside the pointer -- the installers -- uses it to
# publish none of them.
#
# A pointer that already names this very build exits 0. That is what a
# publication finished by re-running looks like from here, and every step after
# this one still has to run.
#
# Usage: advance-channel-pointer.sh <bucket> <endpoint-url> <key> <file> \
#            <content-type> <beta-run|release>

set -eu

bucket=${1:?bucket required}
endpoint=${2:?endpoint url required}
key=${3:?object key required}
file=${4:?local file required}
content_type=${5:?content type required}
ordering=${6:?ordering required: beta-run or release}

case $ordering in
beta-run | release) ;;
*)
	echo "Unknown ordering $ordering; expected beta-run or release." >&2
	exit 1
	;;
esac

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
#
# The three forms this publishes: the JSON manifest, the one-line text pointer,
# and the installer script, which is ordered for the same reason the pointers
# are. Each canonical installer is written by one channel's runs, so an older
# run's copy is refused instead of landing on top of a newer one.
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
	*shellscript*)
		# A rendered installer carries the release it was rendered for on a
		# line of its own. An unrendered copy still holds the placeholder,
		# which is not a version, so publishing one is refused.
		sed -n 's/^# wasmedge-agent-rendered-release: \(.*\)$/\1/p' "$1" |
			awk '{ line = $0 } END { if (NR == 1) print line }'
		;;
	*)
		# The text pointer is the version, on the only line it has.
		awk '{ line = $0 } END { if (NR == 1) print line }' "$1"
		;;
	esac
}

# The fields that order two versions of this channel, most significant first,
# as whitespace-separated integers. A version this does not match is one this
# cannot order, and guessing is the one thing a pointer that must not go
# backwards cannot afford.
#
# Fields are bounded because they are compared as numbers: a value past the
# range of an integer does not compare false, it fails, and a comparison that
# fails reads as "not newer" -- which is an older run taking the pointer. A run
# number is a counter that reached six figures at most, and a release field is
# smaller still, so anything longer is a file to refuse rather than a number to
# widen the comparison for.
order_key() {
	case $ordering in
	beta-run)
		# 0.7.0-beta.<run>.<commit>: the run decides, and nothing else can.
		sed -n 's/^v\{0,1\}[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-beta\.\([0-9]\{1,18\}\)\.[0-9A-Za-z][0-9A-Za-z]*$/\1/p'
		;;
	release)
		# X.Y.Z, and nothing after it: a prerelease never names this channel.
		sed -n 's/^v\{0,1\}\([0-9]\{1,9\}\)\.\([0-9]\{1,9\}\)\.\([0-9]\{1,9\}\)$/\1 \2 \3/p'
		;;
	esac
}

# How the first key stands against the second: 0 newer, 1 the same, 2 older.
# Field by field, because 0.10.0 is later than 0.9.0, which no comparison of
# the versions as whole strings gets right, and no single number the shell can
# compare holds all three fields.
#
# Same and older are separate answers because they call for different things.
# Older means another build owns this channel and this run must not touch it.
# Same means this run already moved this pointer, which is what a publication
# finished by re-running looks like from here.
order_against() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		n = split(a, mine, " ");
		if (split(b, published, " ") != n) exit 2;
		for (i = 1; i <= n; i++) {
			if (mine[i] + 0 > published[i] + 0) exit 0;
			if (mine[i] + 0 < published[i] + 0) exit 2;
		}
		exit 1;
	}'
}

mine_version=$(version_of "$file")
mine=$(printf '%s\n' "$mine_version" | order_key)
if [ -z "$mine" ]; then
	echo "$file does not name one $ordering version; refusing to move $key." >&2
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
		published_version=$(version_of "$work/published")
		published=$(printf '%s\n' "$published_version" | order_key)
		if [ -z "$published" ]; then
			echo "s3://$bucket/$key does not name one $ordering version." >&2
			echo "Nothing here can tell whether this build is newer than it, so the pointer stays." >&2
			exit 1
		fi
		standing=0
		order_against "$mine" "$published" || standing=$?
		if [ "$standing" -eq 1 ]; then
			# This pointer already names this build, so there is nothing to move
			# and nothing to stand down from. Saying otherwise strands a
			# publication that stopped after this object: the retry that exists to
			# finish it cannot get past the one pointer it already wrote.
			echo "s3://$bucket/$key already names $published_version, which is this build."
			exit 0
		fi
		if [ "$standing" -ne 0 ]; then
			echo "s3://$bucket/$key already names $published_version; this build is $mine_version, so it stays."
			exit 3
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
		echo "s3://$bucket/$key now names $mine_version."
		exit 0
	fi

	if grep -q 'Unknown options' "$work/put.err"; then
		echo "This aws CLI does not support $condition, so it cannot move the pointer safely." >&2
		echo "Upgrade the CLI on the runner; an unconditional write can publish an older release." >&2
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

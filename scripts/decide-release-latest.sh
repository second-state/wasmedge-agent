#!/bin/sh
# Answers whether the release being published should become the repository's
# Latest, and prints `true` or `false`.
#
# GitHub decides Latest by publication date. That is wrong for a recovery
# publication: a run finishing a partial v0.7.0 after v0.8.0 shipped is the
# newest release by date and the older one by version, and letting it take the
# alias would move every stable install back a version with nothing to notice
# it. So the answer here is by version.
#
# `true` for a repository with no release yet, and `true` for the version
# already marked Latest -- a re-run of a finished release has to answer the way
# the run that finished it did. `false` for a prerelease, which GitHub excludes
# from the alias anyway.
#
# Fails closed. Only an explicit 404 is an answer about what is published; an
# expired token, a rate limit and a 5xx all look like an absent release to
# anything reading an exit status alone, and reading one as "no release yet"
# would hand the channel to whatever ran next.
#
# Usage: decide-release-latest.sh <repo> <version>

set -eu

repo=${1:?repository (owner/name) required}
version=${2:?version required}
version=${version#v}

# A prerelease never takes the alias.
case "$version" in
	*-*) echo false; exit 0 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if gh api "repos/${repo}/releases/latest" --jq .tag_name > "$work/latest" 2> "$work/err"; then
	current=$(tr -d '\n' < "$work/latest")
elif grep -q 'HTTP 404' "$work/err"; then
	echo true
	exit 0
else
	echo "Could not read which release ${repo} marks latest -- refusing to decide." >&2
	cat "$work/err" >&2
	exit 1
fi

current=${current#v}

if [ "$current" = "$version" ]; then
	echo true
	exit 0
fi

# sort -V orders a hyphenated tag like 1.0.0-rc.1 above 1.0.0, the reverse of
# semver precedence. That only matters here if $current itself is such a tag
# -- a hand-made release marked latest despite carrying a non-numeric suffix,
# since GitHub's own prerelease flag already keeps a real prerelease out of
# $current. Reachable only by that edge case, and it fails safe: the
# comparison below answers false rather than wrongly claiming latest.
newest=$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n 1)
if [ "$newest" = "$version" ]; then
	echo true
else
	echo false
fi

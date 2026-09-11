#!/bin/sh

set -eu

# One-release compatibility window, the shell side of what config.ts's
# readLegacyEnv does for the TypeScript CLI: emits one stderr deprecation line
# when a PRIME_AGENT_<suffix> variable is the one supplying a value that
# WASMEDGE_AGENT_<suffix> left unset. Takes the two variables' already-read
# raw values rather than their names -- POSIX sh has no `${!VAR}` indirection,
# and eval'ing constructed variable names is worth avoiding across eight call
# sites for two static, literal names each.
wasmedge_agent_warn_if_legacy_env() {
	if [ -z "$3" ] && [ -n "$4" ]; then
		printf 'warning: %s is deprecated; use %s. The old name stops working after the next release.\n' "$2" "$1" >&2
	fi
}

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
wasmedge_agent_unconfigured_base_url="__WASMEDGE_AGENT_DOWNLOAD_BASE""_URL__"
wasmedge_agent_unconfigured_default_release_channel="__WASMEDGE_AGENT_DEFAULT_RELEASE_""CHANNEL__"
wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_DOWNLOAD_BASE_URL" "PRIME_AGENT_DOWNLOAD_BASE_URL" \
	"${WASMEDGE_AGENT_DOWNLOAD_BASE_URL:-}" "${PRIME_AGENT_DOWNLOAD_BASE_URL:-}"
wasmedge_agent_base_url="${WASMEDGE_AGENT_DOWNLOAD_BASE_URL:-${PRIME_AGENT_DOWNLOAD_BASE_URL:-__WASMEDGE_AGENT_DOWNLOAD_BASE_URL__}}"
wasmedge_agent_base_url="${wasmedge_agent_base_url%/}"
wasmedge_agent_default_release_channel="__WASMEDGE_AGENT_DEFAULT_RELEASE_CHANNEL__"
# The release this copy was rendered for. Nothing here reads it: it is for the
# publisher, which writes each canonical installer forward-only and needs the
# published copy to say which release it came from. An unrendered copy keeps
# the placeholder, which is not a version, so publishing one is refused.
# wasmedge-agent-rendered-release: __WASMEDGE_AGENT_RENDERED_RELEASE__
if [ "$wasmedge_agent_default_release_channel" = "$wasmedge_agent_unconfigured_default_release_channel" ]; then
	wasmedge_agent_default_release_channel=stable
fi
wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_RELEASE_CHANNEL" "PRIME_AGENT_RELEASE_CHANNEL" \
	"${WASMEDGE_AGENT_RELEASE_CHANNEL:-}" "${PRIME_AGENT_RELEASE_CHANNEL:-}"
wasmedge_agent_release_channel="${WASMEDGE_AGENT_RELEASE_CHANNEL:-${PRIME_AGENT_RELEASE_CHANNEL:-$wasmedge_agent_default_release_channel}}"
wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_PACKAGE" "PRIME_AGENT_PACKAGE" \
	"${WASMEDGE_AGENT_PACKAGE:-}" "${PRIME_AGENT_PACKAGE:-}"
wasmedge_agent_package="${WASMEDGE_AGENT_PACKAGE:-${PRIME_AGENT_PACKAGE:-wasmedge-agent}}"
wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_CMD" "PRIME_AGENT_CMD" \
	"${WASMEDGE_AGENT_CMD:-}" "${PRIME_AGENT_CMD:-}"
wasmedge_agent_cmd="${WASMEDGE_AGENT_CMD:-${PRIME_AGENT_CMD:-wasmedge-agent}}"
wasmedge_agent_esc=$(printf '\033')
wasmedge_agent_original_path="${PATH:-}"
wasmedge_agent_reset="${wasmedge_agent_esc}[0m"
wasmedge_agent_bold="${wasmedge_agent_esc}[1m"
wasmedge_agent_italic="${wasmedge_agent_esc}[3m"
wasmedge_agent_hide_cursor="${wasmedge_agent_esc}[?25l"
wasmedge_agent_show_cursor="${wasmedge_agent_esc}[?25h"
wasmedge_agent_home_cursor="${wasmedge_agent_esc}[H"
wasmedge_agent_clear_screen="${wasmedge_agent_esc}[2J${wasmedge_agent_esc}[H"
wasmedge_agent_clear_line="${wasmedge_agent_esc}[K"
wasmedge_agent_sync_start="${wasmedge_agent_esc}[?2026h"
wasmedge_agent_sync_end="${wasmedge_agent_esc}[?2026l"
wasmedge_agent_color_text="${wasmedge_agent_esc}[38;2;244;244;245m"
wasmedge_agent_color_muted="${wasmedge_agent_esc}[38;2;161;161;170m"
wasmedge_agent_color_dim="${wasmedge_agent_esc}[38;2;113;113;122m"
wasmedge_agent_color_primary="${wasmedge_agent_esc}[38;2;127;91;213m"
wasmedge_agent_color_scan="${wasmedge_agent_esc}[38;2;14;165;233m"
wasmedge_agent_color_warning="${wasmedge_agent_esc}[38;2;245;158;11m"
readonly wasmedge_agent_unconfigured_base_url wasmedge_agent_unconfigured_default_release_channel wasmedge_agent_base_url wasmedge_agent_default_release_channel wasmedge_agent_release_channel wasmedge_agent_package wasmedge_agent_cmd wasmedge_agent_esc wasmedge_agent_original_path
readonly wasmedge_agent_reset wasmedge_agent_bold wasmedge_agent_italic wasmedge_agent_hide_cursor wasmedge_agent_show_cursor wasmedge_agent_home_cursor wasmedge_agent_clear_screen wasmedge_agent_clear_line
readonly wasmedge_agent_sync_start wasmedge_agent_sync_end
readonly wasmedge_agent_color_text wasmedge_agent_color_muted wasmedge_agent_color_dim wasmedge_agent_color_primary wasmedge_agent_color_scan wasmedge_agent_color_warning

wasmedge_agent_screen_enabled=0
wasmedge_agent_screen_frame=0
wasmedge_agent_screen_cols=80
wasmedge_agent_screen_rows=24
wasmedge_agent_screen_drawn=0
wasmedge_agent_screen_last_cols=0
wasmedge_agent_screen_last_rows=0
wasmedge_agent_screen_layout_ready=0
wasmedge_agent_screen_layout_show_logo=0
wasmedge_agent_screen_layout_lab_width=0
wasmedge_agent_screen_render_lab_width=0
wasmedge_agent_screen_compact=0
wasmedge_agent_download_dir=
wasmedge_agent_bootstrap_runtime_on_install=0
# --yes and --now: answer every prompt with its default and install. --now is
# the same mode by issue #5's definition of it, "run the non-interactive
# installer immediately", and having it mean anything else here would make the
# launcher's --now and this one two different things under one name.
wasmedge_agent_assume_yes=0
# --check: report on the runtime and change nothing.
wasmedge_agent_check_only=0
wasmedge_agent_requested_version=
# The channel manifest this run resolved its version from, when it resolved
# one. It names the package behind each artifact, which is what holds a
# verified tarball to being the package the release meant it to be.
wasmedge_agent_channel_manifest=
# The temporary directory that manifest lives in, so the run can remove it.
wasmedge_agent_channel_dir=
# The animated helpers run their command in the background and collect its
# output in a temporary directory. Both are recorded here for the same reason
# the directories above are: a Ctrl-C leaves the helper's own cleanup
# unreached, and what it was running is still running.
wasmedge_agent_animation_dir=
wasmedge_agent_animation_pid=
# Where the doctor report is written, tracked for the same reason.
wasmedge_agent_doctor_dir=
wasmedge_agent_screen_title=
wasmedge_agent_screen_status=
wasmedge_agent_screen_detail=
wasmedge_agent_screen_question=
wasmedge_agent_animation_frame=0

main() {
	parse_wasmedge_agent_arguments "$@"

	# Before the release host is required: --check reads what is installed and
	# downloads nothing, so it has to work on a host that has no host
	# configured.
	if [ "$wasmedge_agent_check_only" = 1 ]; then
		check_wasmedge_agent_runtime
		exit $?
	fi

	if [ "$wasmedge_agent_base_url" = "$wasmedge_agent_unconfigured_base_url" ]; then
		printf 'error: installer download URL is not configured.\n' >&2
		printf 'Set WASMEDGE_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.\n' >&2
		exit 1
	fi

	wasmedge_agent_install_traps
	wasmedge_agent_init_screen
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "Installing WasmEdge Agent" "" "" ""
	else
		printf '\n\033[1m  Installing WasmEdge Agent\033[0m\n\033[2m  npm global install\033[0m\n\n'
	fi

	start_preflight_checks

	if finish_preflight_checks; then
		check_status=0
	else
		check_status=$?
	fi

	if [ "$check_status" -ne 0 ]; then
		if ! install_node_npm_interactive; then
			exit "$check_status"
		fi

		start_preflight_checks
		if finish_preflight_checks; then
			check_status=0
		else
			check_status=$?
		fi

		if [ "$check_status" -ne 0 ]; then
			exit "$check_status"
		fi
	fi

	# Prepared here rather than inside the resolver: that runs in a command
	# substitution, so a path it chose would be lost with its subshell.
	wasmedge_agent_channel_dir=$(create_temp_dir)
	wasmedge_agent_channel_manifest="$wasmedge_agent_channel_dir/channel.json"
	version="$(resolve_wasmedge_agent_version "$wasmedge_agent_requested_version")"
	fetch_wasmedge_agent_release_manifest "$version"
	tarball_name="$wasmedge_agent_package-$version.tgz"
	tarball_url=$(wasmedge_agent_release_asset_url "$version" "$tarball_name")

	confirm_install "$version" "$tarball_url"
	confirm_cell_runtime_setup
	prepare_rust_toolchain

	download_dir=$(create_temp_dir)
	wasmedge_agent_download_dir="$download_dir"
	tarball_path="$download_dir/$tarball_name"

	download_wasmedge_agent_package "$version" "$tarball_url" "$tarball_path"
	stage_verified_wasmedge_agent_package "$version" "$tarball_path" "$download_dir/SHA256SUMS"
	install_wasmedge_agent_package "$wasmedge_agent_install_tarball"
	rm -rf "$download_dir" "$wasmedge_agent_channel_dir"
	wasmedge_agent_download_dir=
	wasmedge_agent_channel_dir=
	wasmedge_agent_channel_manifest=

	run_wasmedge_agent_doctor

	if [ "${WASMEDGE_AGENT_NODE_INSTALLED_STANDALONE:-0}" = 1 ]; then
		wasmedge_agent_screen "WasmEdge Agent installed" "" "Checking your shell PATH." ""
		configure_standalone_node_path
	elif command -v "$wasmedge_agent_cmd" >/dev/null 2>&1; then
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_screen "WasmEdge Agent installed" "" "Run it with: $wasmedge_agent_cmd" ""
		else
			printf '\nWasmEdge Agent was installed successfully.\n'
			printf '\nRun it with: %s\n' "$wasmedge_agent_cmd"
		fi
	else
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_screen "WasmEdge Agent installed" "" "PATH update needed for $wasmedge_agent_cmd." ""
			wasmedge_agent_restore_terminal
		else
			printf '\nWasmEdge Agent was installed successfully.\n'
		fi
		cat <<EOF
The $wasmedge_agent_cmd command was installed, but it is not on your PATH yet.
Check npm's global bin directory with:

  npm bin -g

Then add that directory to your shell PATH.
EOF
	fi
}

# Issue #3's last installer step: the agent repairs and validates its own
# runtime. Run through the command as installed, so it also answers whether
# the install produced a command that runs at all.
#
# A run that skipped runtime provisioning is a deliberate partial install --
# skip_cell_runtime_setup has already printed what to do by hand -- so doctor
# reports there and the install stands. When the runtime was provisioned, a
# doctor that cannot fix what it found is a failed install, not a successful
# one with advice.
run_wasmedge_agent_doctor() {
	doctor_path=$(command -v "$wasmedge_agent_cmd" 2>/dev/null) || doctor_path=
	if [ -z "$doctor_path" ]; then
		# Installed, but not on this shell's PATH yet. npm knows where it put
		# it, and the PATH guidance further down is about the user's next
		# shell rather than this step.
		npm_prefix=$(npm prefix -g 2>/dev/null) || npm_prefix=
		if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/$wasmedge_agent_cmd" ]; then
			doctor_path="$npm_prefix/bin/$wasmedge_agent_cmd"
		fi
	fi
	if [ -z "$doctor_path" ]; then
		# npm reported success and there is no command: the install did not
		# produce what it was for, and every check below is about a command
		# that does not exist. Reporting success here also skipped the
		# --version and doctor workflows issue #3 requires.
		printf 'error: npm installed %s but no %s command was found on PATH or under the npm prefix.\n' \
			"$wasmedge_agent_package" "$wasmedge_agent_cmd" >&2
		exit 1
	fi

	# Asked for as JSON, and read as data. `doctor --fix` exits 0 whether or
	# not the runtime it found is healthy, and that is not a defect to fix in
	# it: --fix also reaps background services, and it is run as a maintenance
	# command on hosts that have no Rust toolchain and never will. What is
	# wrong is taking its status for an answer it does not carry, so the
	# report is what this reads.
	doctor_status=0
	wasmedge_agent_doctor_dir=$(create_temp_dir)
	doctor_report="$wasmedge_agent_doctor_dir/report.json"
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		# Written to a file rather than read through a command substitution.
		# A substitution runs its command in a subshell, and the helper
		# records the child it started and the directory it made in variables
		# the traps read: set in a subshell they never reach the trap, so a
		# Ctrl-C during doctor left it running and its directory behind while
		# the installer reported itself interrupted.
		wasmedge_agent_run_capture_with_animation "$doctor_report" \
			"Checking the installation" \
			"Checking the installation" \
			"Running $wasmedge_agent_cmd doctor --fix." \
			"$doctor_path" doctor --fix --json || doctor_status=$?
	else
		printf '\nRunning %s doctor --fix...\n' "$wasmedge_agent_cmd"
		"$doctor_path" doctor --fix --json > "$doctor_report" || doctor_status=$?
	fi

	if [ "$doctor_status" -eq 0 ]; then
		node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	let report;
	try {
		report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		console.error("error: could not read the doctor report: " + error.message);
		process.exit(1);
	}
	const runtime = Array.isArray(report.runtime) ? report.runtime : [];
	const failed = runtime.filter((check) => check && check.ok === false);
	for (const check of failed) console.error("  " + check.name + ": " + check.detail);
	process.exit(runtime.length > 0 && failed.length === 0 ? 0 : 1);
});
' < "$doctor_report" || doctor_status=$?
	fi

	rm -rf "$wasmedge_agent_doctor_dir"
	wasmedge_agent_doctor_dir=

	if [ "$doctor_status" -eq 0 ]; then
		return 0
	fi

	if [ "$wasmedge_agent_bootstrap_runtime_on_install" = 1 ]; then
		printf 'error: %s doctor --fix could not repair the runtime it found.\n' "$wasmedge_agent_cmd" >&2
		exit 1
	fi

	printf 'Warning: %s doctor --fix reported problems, and the runtime setup above was skipped.\n' \
		"$wasmedge_agent_cmd" >&2
	return 0
}

create_temp_dir() {
	if command -v mktemp >/dev/null 2>&1; then
		if tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/wasmedge-agent-install.XXXXXX" 2>/dev/null); then
			printf '%s' "$tmp_dir"
			return
		fi
	fi

	printf 'error: mktemp is required to create a secure temporary directory.\n' >&2
	exit 1
}

wasmedge_agent_install_traps() {
	trap 'wasmedge_agent_cleanup' EXIT
	trap 'wasmedge_agent_signal_cleanup 130' INT
	trap 'wasmedge_agent_signal_cleanup 143' TERM
}

# Everything the tracked command started, children before their parent.
#
# The animated commands are package managers, npm installs and vendor
# install scripts, and signalling only the process this shell started
# leaves what that process started running -- with the terminal restored
# and the installer gone, which is the state an interrupt is supposed to
# avoid. Recurses through $1 rather than a variable, because a variable
# would be the same one in every frame.
wasmedge_agent_kill_tree() {
	if command -v ps >/dev/null 2>&1; then
		for wasmedge_agent_kill_child in $(ps -Ao pid=,ppid= 2>/dev/null |
			awk -v parent="$1" '$2 == parent { print $1 }'); do
			wasmedge_agent_kill_tree "$wasmedge_agent_kill_child"
		done
	fi
	kill "$1" 2>/dev/null || true
}

wasmedge_agent_cleanup() {
	status=$?
	# The child first: it holds the directory below open, and on the signal
	# path it is a curl or a doctor run that nothing else will stop.
	if [ -n "${wasmedge_agent_animation_pid:-}" ]; then
		wasmedge_agent_kill_tree "$wasmedge_agent_animation_pid"
		wait "$wasmedge_agent_animation_pid" 2>/dev/null || true
		wasmedge_agent_animation_pid=
	fi
	for wasmedge_agent_cleanup_dir in \
		"${wasmedge_agent_animation_dir:-}" \
		"${wasmedge_agent_doctor_dir:-}" \
		"${wasmedge_agent_download_dir:-}" \
		"${wasmedge_agent_channel_dir:-}"; do
		if [ -n "$wasmedge_agent_cleanup_dir" ] && [ -d "$wasmedge_agent_cleanup_dir" ]; then
			rm -rf "$wasmedge_agent_cleanup_dir"
		fi
	done
	wasmedge_agent_restore_terminal
	return "$status"
}

wasmedge_agent_signal_cleanup() {
	wasmedge_agent_restore_terminal
	exit "$1"
}

wasmedge_agent_restore_terminal() {
	if [ "${wasmedge_agent_screen_enabled:-0}" = 1 ]; then
		if ( : <>/dev/tty ) 2>/dev/null; then
			printf '%s%s' "$wasmedge_agent_reset" "$wasmedge_agent_show_cursor" >/dev/tty
		else
			printf '%s%s' "$wasmedge_agent_reset" "$wasmedge_agent_show_cursor" >&2
		fi
	fi
}

wasmedge_agent_init_screen() {
	wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_INSTALLER_PLAIN" "PRIME_AGENT_INSTALLER_PLAIN" \
		"${WASMEDGE_AGENT_INSTALLER_PLAIN:-}" "${PRIME_AGENT_INSTALLER_PLAIN:-}"
	if [ "${WASMEDGE_AGENT_INSTALLER_PLAIN:-${PRIME_AGENT_INSTALLER_PLAIN:-0}}" = 1 ]; then
		return
	fi
	if [ ! -t 1 ]; then
		return
	fi
	if [ "${TERM:-}" = dumb ]; then
		return
	fi
	wasmedge_agent_screen_enabled=1
}

wasmedge_agent_read_terminal_size() {
	wasmedge_agent_screen_cols=80
	wasmedge_agent_screen_rows=24

	if size=$(stty size 2>/dev/null </dev/tty); then
		set -- $size
		if [ "${1:-}" ] && [ "${2:-}" ]; then
			case "$1" in *[!0-9]*|"") ;; *) wasmedge_agent_screen_rows="$1" ;; esac
			case "$2" in *[!0-9]*|"") ;; *) wasmedge_agent_screen_cols="$2" ;; esac
		fi
	fi

	if [ "$wasmedge_agent_screen_cols" -lt 1 ]; then
		wasmedge_agent_screen_cols=80
	fi
	if [ "$wasmedge_agent_screen_rows" -lt 1 ]; then
		wasmedge_agent_screen_rows=24
	fi
}

wasmedge_agent_screen() {
	if [ "$wasmedge_agent_screen_enabled" != 1 ]; then
		return
	fi

	wasmedge_agent_screen_title="${2:-$1}"
	if [ -z "$wasmedge_agent_screen_title" ]; then
		wasmedge_agent_screen_title="$1"
	fi
	wasmedge_agent_screen_status=
	wasmedge_agent_screen_detail="${3:-}"
	wasmedge_agent_screen_question="${4:-}"
	wasmedge_agent_screen_frame=$((wasmedge_agent_screen_frame + 1))
	wasmedge_agent_read_terminal_size
	wasmedge_agent_init_screen_layout
	wasmedge_agent_refresh_screen_layout_mode

	if [ "$wasmedge_agent_screen_drawn" = 0 ] ||
		[ "$wasmedge_agent_screen_cols" -ne "$wasmedge_agent_screen_last_cols" ] ||
		[ "$wasmedge_agent_screen_rows" -ne "$wasmedge_agent_screen_last_rows" ]; then
		wasmedge_agent_screen_prefix="${wasmedge_agent_reset}${wasmedge_agent_clear_screen}${wasmedge_agent_hide_cursor}"
		wasmedge_agent_screen_drawn=1
		wasmedge_agent_screen_last_cols="$wasmedge_agent_screen_cols"
		wasmedge_agent_screen_last_rows="$wasmedge_agent_screen_rows"
	else
		wasmedge_agent_screen_prefix="${wasmedge_agent_reset}${wasmedge_agent_home_cursor}${wasmedge_agent_hide_cursor}"
	fi
	wasmedge_agent_screen_frame_text=$(wasmedge_agent_render_screen)

	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s%s' "$wasmedge_agent_sync_start" "$wasmedge_agent_screen_prefix" "$wasmedge_agent_screen_frame_text" "$wasmedge_agent_sync_end" >/dev/tty
	else
		printf '%s%s%s%s' "$wasmedge_agent_sync_start" "$wasmedge_agent_screen_prefix" "$wasmedge_agent_screen_frame_text" "$wasmedge_agent_sync_end" >&2
	fi
}

wasmedge_agent_init_screen_layout() {
	if [ "$wasmedge_agent_screen_layout_ready" = 1 ]; then
		return
	fi

	wasmedge_agent_screen_layout_ready=1
	wasmedge_agent_screen_layout_show_logo=0
	wasmedge_agent_screen_layout_lab_width=0
	wasmedge_agent_screen_render_lab_width=0
	if wasmedge_agent_terminal_size_supports_logo; then
		wasmedge_agent_screen_layout_show_logo=1
		wasmedge_agent_screen_layout_lab_width=$(wasmedge_agent_lab_width_for_cols "$wasmedge_agent_screen_cols")
	fi
}

wasmedge_agent_refresh_screen_layout_mode() {
	wasmedge_agent_screen_compact=0
	wasmedge_agent_screen_render_lab_width=0
	if [ "$wasmedge_agent_screen_layout_show_logo" != 1 ]; then
		return
	fi
	if [ "$wasmedge_agent_screen_rows" -lt 17 ]; then
		wasmedge_agent_screen_compact=1
		return
	fi

	max_safe_width=$((wasmedge_agent_screen_cols - 1))
	if [ "$max_safe_width" -lt 32 ]; then
		wasmedge_agent_screen_compact=1
		return
	fi

	wasmedge_agent_screen_render_lab_width="$wasmedge_agent_screen_layout_lab_width"
	if [ "$wasmedge_agent_screen_render_lab_width" -gt "$max_safe_width" ]; then
		wasmedge_agent_screen_render_lab_width="$max_safe_width"
	fi
}

wasmedge_agent_terminal_size_supports_logo() {
	[ "$wasmedge_agent_screen_rows" -ge 22 ] && [ "$wasmedge_agent_screen_cols" -ge 42 ]
}

wasmedge_agent_lab_width_for_cols() {
	cols="$1"
	width=$((cols - 6))
	if [ "$width" -gt 78 ]; then
		width=78
	fi
	if [ "$width" -lt 42 ]; then
		width=42
	fi
	max_safe_width=$((cols - 1))
	if [ "$max_safe_width" -lt 1 ]; then
		max_safe_width=1
	fi
	if [ "$width" -gt "$max_safe_width" ]; then
		width="$max_safe_width"
	fi
	if [ "$width" -lt 32 ]; then
		width=32
	fi
	printf '%s' "$width"
}

wasmedge_agent_render_screen() {
	content_height=$(wasmedge_agent_content_height)
	top=$(((wasmedge_agent_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi

	y=0
	while [ "$y" -lt "$wasmedge_agent_screen_rows" ]; do
		content_index=$((y - top))
		wasmedge_agent_content_line "$content_index"
		if [ "${wasmedge_agent_content_is_set:-0}" = 1 ]; then
			wasmedge_agent_print_centered_line "$wasmedge_agent_content_text" "$wasmedge_agent_content_width" "$wasmedge_agent_content_style"
		else
			wasmedge_agent_print_centered_line "" 0 ""
		fi
		y=$((y + 1))
	done
}

wasmedge_agent_content_height() {
	height=2
	if wasmedge_agent_show_logo; then
		height=$((height + 15))
	fi
	printf '%s' "$height"
}

wasmedge_agent_show_logo() {
	[ "$wasmedge_agent_screen_layout_show_logo" = 1 ] && [ "$wasmedge_agent_screen_compact" != 1 ] && [ "$wasmedge_agent_screen_render_lab_width" -ge 32 ]
}

wasmedge_agent_content_line() {
	index="$1"
	wasmedge_agent_content_is_set=0
	wasmedge_agent_content_text=
	wasmedge_agent_content_width=0
	wasmedge_agent_content_style=

	if wasmedge_agent_show_logo; then
		case "$index" in
			0|1|2|3|4|5|6|7|8|9|10|11|12|13) wasmedge_agent_set_lab_line "$index" ;;
			14) wasmedge_agent_set_blank_line ;;
		esac
		if [ "$wasmedge_agent_content_is_set" = 1 ]; then
			return
		fi
		index=$((index - 15))
	fi

	if [ "$index" -lt 0 ]; then
		return
	fi

	if [ "$index" -eq 0 ]; then
		if [ -n "$wasmedge_agent_screen_question" ]; then
			wasmedge_agent_set_text_line "$(wasmedge_agent_screen_primary_text)" "$wasmedge_agent_bold$wasmedge_agent_color_text"
		else
			wasmedge_agent_set_title_line "$wasmedge_agent_screen_title"
		fi
		return
	fi

	if [ "$index" -eq 1 ]; then
		if [ -n "$wasmedge_agent_screen_question" ]; then
			wasmedge_agent_set_text_line "Press Enter to continue; type n to cancel." "$wasmedge_agent_color_muted"
		elif [ -n "$wasmedge_agent_screen_detail" ]; then
			wasmedge_agent_set_text_line "$wasmedge_agent_screen_detail" "$wasmedge_agent_color_muted"
		else
			wasmedge_agent_set_blank_line
		fi
		return
	fi
}

wasmedge_agent_screen_primary_text() {
	if [ -z "$wasmedge_agent_screen_question" ]; then
		printf '%s' "$wasmedge_agent_screen_title"
		return
	fi

	case "$wasmedge_agent_screen_question" in
		*'[Y/n]'*) printf '%s [Y/n] >' "$wasmedge_agent_screen_title" ;;
		*) printf '%s %s' "$wasmedge_agent_screen_title" "$wasmedge_agent_screen_question" ;;
	esac
}

wasmedge_agent_set_lab_line() {
	lab_row="$1"
	wasmedge_agent_lab_width="$wasmedge_agent_screen_render_lab_width"

	logo_line=$(wasmedge_agent_logo_line "$lab_row")
	if [ -n "$logo_line" ]; then
		logo_start=$(((wasmedge_agent_lab_width - 32) / 2))
		logo_end=$((logo_start + 32))
		left=$(wasmedge_agent_lab_background_range "$lab_row" 0 "$logo_start")
		right=$(wasmedge_agent_lab_background_range "$lab_row" "$logo_end" "$wasmedge_agent_lab_width")
		trace="${left}${wasmedge_agent_color_text}${logo_line}${wasmedge_agent_reset}${right}"
	else
		trace=$(wasmedge_agent_lab_background_range "$lab_row" 0 "$wasmedge_agent_lab_width")
	fi

	wasmedge_agent_content_is_set=1
	wasmedge_agent_content_text="$trace"
	wasmedge_agent_content_width="$wasmedge_agent_lab_width"
	wasmedge_agent_content_style=
}

wasmedge_agent_logo_line() {
	case "$1" in
		2) printf '                          ▄▄███▀' ;;
		3) printf '    ▄▄▄▄▄              ▄█████▀' ;;
		4) printf '    ██████▄         ▄██████▀' ;;
		5) printf '   ▄███▀███▄     ▄███▀▄██▀' ;;
		6) printf '   ███ ▄████▄▄▄████▀▄▄██' ;;
		7) printf '  ▀██  ▀█████████▀▀▀▀▀▀' ;;
		8) printf '  ▄██   ██████▀▀ ▄███' ;;
		9) printf ' █████    ▀█▄▄▄█████▀' ;;
		10) printf '███████▄  ████████▀' ;;
		11) printf '▀███▀▀    █████▀' ;;
	esac
}

wasmedge_agent_lab_background_range() {
	lab_row="$1"
	range_start="$2"
	range_end="$3"
	active_style=
	line=
	x="$range_start"
	while [ "$x" -lt "$range_end" ]; do
		wasmedge_agent_lab_cell "$x" "$lab_row"
		if [ "$wasmedge_agent_lab_cell_style" != "$active_style" ]; then
			if [ -n "$active_style" ]; then
				line="${line}${wasmedge_agent_reset}"
			fi
			if [ -n "$wasmedge_agent_lab_cell_style" ]; then
				line="${line}${wasmedge_agent_lab_cell_style}"
			fi
			active_style="$wasmedge_agent_lab_cell_style"
		fi
		line="${line}${wasmedge_agent_lab_cell_char}"
		x=$((x + 1))
	done
	if [ -n "$active_style" ]; then
		line="${line}${wasmedge_agent_reset}"
	fi
	printf '%s' "$line"
}

wasmedge_agent_lab_cell() {
	x="$1"
	y="$2"
	width="$wasmedge_agent_lab_width"
	height=14
	frame="$wasmedge_agent_screen_frame"
	wasmedge_agent_lab_cell_char=" "
	wasmedge_agent_lab_cell_style=

	hash=$(((x * 37 + y * 53 + frame * 11 + x * y * 3) % 101))
	if [ "$hash" -lt 3 ]; then
		wasmedge_agent_lab_cell_char="·"
		wasmedge_agent_lab_cell_style="$wasmedge_agent_color_dim"
	fi

	center_x=$((width * 36 / 100))
	center_y=$((height * 54 / 100))
	dx=$((x - center_x))
	dy=$((y - center_y))
	if [ "$dx" -lt 0 ]; then
		dx=$((-dx))
	fi
	if [ "$dy" -lt 0 ]; then
		dy=$((-dy))
	fi
	contour=$((dx + dy * 4 + x / 6 - frame))
	if [ "$x" -lt $((width * 82 / 100)) ] && [ $(((contour % 24 + 24) % 24)) -eq 12 ]; then
		if [ $(((x + y) % 5)) -eq 0 ]; then
			wasmedge_agent_lab_cell_char="╌"
		else
			wasmedge_agent_lab_cell_char="·"
		fi
		wasmedge_agent_lab_cell_style="$wasmedge_agent_color_dim"
	fi

	horizon_y=$((height * 58 / 100))
	if [ "$y" -eq "$horizon_y" ] && [ $((x % 2)) -eq 0 ] && [ $(((x + frame) % 13)) -lt 2 ]; then
		wasmedge_agent_lab_cell_char="─"
		if [ "$x" -gt $((width * 60 / 100)) ]; then
			wasmedge_agent_lab_cell_style="$wasmedge_agent_color_primary"
		else
			wasmedge_agent_lab_cell_style="$wasmedge_agent_color_dim"
		fi
	fi

	scan_start=$((width / 2))
	if [ "$x" -ge "$scan_start" ]; then
		scan_offset=$((x - scan_start))
		if [ $((scan_offset % 5)) -eq 0 ]; then
			scan_index=$((scan_offset / 5))
			scan_top=$((1 + (scan_index + frame / 3) % 3))
			scan_bottom=$((height - 2 - (scan_index * 2 + frame / 4) % 3))
			if [ "$y" -ge "$scan_top" ] && [ "$y" -le "$scan_bottom" ] && [ $(((y + scan_index + frame) % 6)) -ne 0 ]; then
				if [ $(((scan_index + y) % 4)) -eq 0 ]; then
					wasmedge_agent_lab_cell_char="┃"
				else
					wasmedge_agent_lab_cell_char="╎"
				fi
				wasmedge_agent_lab_cell_style="$wasmedge_agent_color_scan"
			fi
		fi
	fi

	trace_index=0
	while [ "$trace_index" -lt 3 ]; do
		case "$trace_index" in
			0) base=$((height * 30 / 100)) ;;
			1) base=$((height * 49 / 100)) ;;
			*) base=$((height * 72 / 100)) ;;
		esac
		wave=$(((x * 2 + frame + trace_index * 7) % 16))
		if [ "$wave" -gt 7 ]; then
			wave=$((15 - wave))
		fi
		trace_y=$((base + (wave - 3) / 2))
		if [ "$y" -eq "$trace_y" ]; then
			if [ $(((x + frame + trace_index * 13) % 41)) -eq 0 ]; then
				wasmedge_agent_lab_cell_char="◆"
				wasmedge_agent_lab_cell_style="$wasmedge_agent_color_warning"
			elif [ $(((x + frame) % 12)) -eq 0 ]; then
				wasmedge_agent_lab_cell_char="•"
				wasmedge_agent_lab_cell_style="$wasmedge_agent_color_primary"
			else
				wasmedge_agent_lab_cell_char="·"
				wasmedge_agent_lab_cell_style="$wasmedge_agent_color_primary"
			fi
		fi
		trace_index=$((trace_index + 1))
	done
}

wasmedge_agent_set_blank_line() {
	wasmedge_agent_content_is_set=1
	wasmedge_agent_content_text=
	wasmedge_agent_content_width=0
	wasmedge_agent_content_style=
}

wasmedge_agent_set_text_line() {
	max_width=$((wasmedge_agent_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	wasmedge_agent_content_text=$(wasmedge_agent_fit_ascii "$1" "$max_width")
	wasmedge_agent_content_width=${#wasmedge_agent_content_text}
	wasmedge_agent_content_style="$2"
	wasmedge_agent_content_is_set=1
}

wasmedge_agent_set_title_line() {
	max_width=$((wasmedge_agent_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	wasmedge_agent_content_text=$(wasmedge_agent_fit_ascii "$1" "$max_width")
	wasmedge_agent_content_width=${#wasmedge_agent_content_text}
	wasmedge_agent_content_style="$wasmedge_agent_bold$wasmedge_agent_color_primary"
	wasmedge_agent_content_is_set=1
}

wasmedge_agent_fit_ascii() {
	text="$1"
	max_width="$2"
	if [ "${#text}" -le "$max_width" ]; then
		printf '%s' "$text"
		return
	fi
	if [ "$max_width" -le 3 ]; then
		printf '%s' "$text" | cut -c 1-"$max_width"
		return
	fi
	cut_width=$((max_width - 3))
	printf '%s...' "$(printf '%s' "$text" | cut -c 1-"$cut_width")"
}

wasmedge_agent_print_centered_line() {
	text="$1"
	width="$2"
	style="$3"
	left=$(((wasmedge_agent_screen_cols - width) / 2))
	if [ "$left" -lt 0 ]; then
		left=0
	fi
	if [ -n "$style" ]; then
		printf '%*s%s%s%s%s\n' "$left" "" "$style" "$text" "$wasmedge_agent_reset" "$wasmedge_agent_clear_line"
	else
		printf '%*s%s%s\n' "$left" "" "$text" "$wasmedge_agent_clear_line"
	fi
}

wasmedge_agent_place_prompt_cursor() {
	max_width=$((wasmedge_agent_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prompt_text=$(wasmedge_agent_fit_ascii "$(wasmedge_agent_screen_primary_text)" "$max_width")
	prompt_width=${#prompt_text}
	content_height=$(wasmedge_agent_content_height)
	top=$(((wasmedge_agent_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi
	prompt_index=0
	if wasmedge_agent_show_logo; then
		prompt_index=$((prompt_index + 15))
	fi
	row=$((top + prompt_index + 1))
	col=$(((wasmedge_agent_screen_cols - prompt_width) / 2 + prompt_width + 2))
	if [ "$col" -lt 1 ]; then
		col=1
	fi
	if [ "$col" -gt "$wasmedge_agent_screen_cols" ]; then
		col="$wasmedge_agent_screen_cols"
	fi
	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s[%s;%sH' "$wasmedge_agent_reset" "$wasmedge_agent_show_cursor" "$wasmedge_agent_esc" "$row" "$col" >/dev/tty
	else
		printf '%s%s%s[%s;%sH' "$wasmedge_agent_reset" "$wasmedge_agent_show_cursor" "$wasmedge_agent_esc" "$row" "$col" >&2
	fi
}

wasmedge_agent_pulse() {
	case $((wasmedge_agent_screen_frame % 4)) in
		0) printf '.' ;;
		1) printf '..' ;;
		2) printf '...' ;;
		*) printf '' ;;
	esac
}

wasmedge_agent_animation_detail_count() {
	details="$1"
	case "$details" in
		*'
'*) printf '%s\n' "$details" | wc -l | tr -d ' ' ;;
		*) printf '1' ;;
	esac
}

wasmedge_agent_animation_current_frame() {
	frame="${wasmedge_agent_animation_frame:-1}"
	case "$frame" in
		""|*[!0-9]*) frame=1 ;;
	esac
	if [ "$frame" -lt 1 ]; then
		frame=1
	fi
	printf '%s' "$frame"
}

wasmedge_agent_animation_step_index() {
	details="$1"
	detail_count=$(wasmedge_agent_animation_detail_count "$details")
	frame=$(wasmedge_agent_animation_current_frame)
	detail_index=$(((frame - 1) / 24 + 1))
	if [ "$detail_index" -gt "$detail_count" ]; then
		detail_index="$detail_count"
	fi
	printf '%s' "$detail_index"
}

wasmedge_agent_static_progress_title() {
	case "$1" in
		*...) printf '%s' "$1" ;;
		*) printf '%s...' "$1" ;;
	esac
}

wasmedge_agent_animation_status() {
	status="$1"
	details="$2"
	status_mode="$3"
	case "$status_mode" in
		static) wasmedge_agent_static_progress_title "$status" ;;
		*) printf '%s%s' "$status" "$(wasmedge_agent_pulse)" ;;
	esac
}

wasmedge_agent_animation_detail() {
	details="$1"
	case "$details" in
		*'
'*)
			detail_index=$(wasmedge_agent_animation_step_index "$details")
			printf '%s\n' "$details" | sed -n "${detail_index}p"
			;;
		*) printf '%s' "$details" ;;
	esac
}

# Animates until a background command exits, and returns that command's status.
#
# Every frame is drawn to /dev/tty, or to stderr when there is no terminal, so
# a caller may run this inside a command substitution and capture the command's
# own output and nothing else.
wasmedge_agent_animate_until_exit() {
	animate_title="$1"
	animate_status="$2"
	animate_details="$3"
	animate_mode="$4"
	animate_pid="$5"

	wasmedge_agent_animation_frame=0
	while kill -0 "$animate_pid" 2>/dev/null; do
		wasmedge_agent_animation_frame=$((wasmedge_agent_animation_frame + 1))
		animate_display=$(wasmedge_agent_animation_status "$animate_status" "$animate_details" "$animate_mode")
		wasmedge_agent_screen "$animate_title" "$animate_display" "$(wasmedge_agent_animation_detail "$animate_details")" ""
		sleep 0.18
	done

	wait "$animate_pid"
}

# The same animation, for a command whose output is the point of running it.
#
# The quiet helper folds stdout into the file it shows only when the command
# fails, and then deletes it, so a caller that runs it in a command
# substitution is handed an empty string. That is what `doctor --fix --json`
# was read through: a healthy interactive install produced no report, and
# failed on the report it could not parse. Here stdout stays separate and is
# printed, and stderr is what gets shown when the command fails.
wasmedge_agent_run_capture_with_animation() {
	output_path="$1"
	title="$2"
	status="$3"
	detail="$4"
	shift 4

	if [ "$wasmedge_agent_screen_enabled" != 1 ]; then
		printf '%s\n' "$status" >&2
		"$@" > "$output_path"
		return
	fi

	output_dir=$(create_temp_dir)
	wasmedge_agent_animation_dir="$output_dir"
	error_file="$output_dir/error"
	"$@" >"$output_path" 2>"$error_file" &
	command_pid=$!
	wasmedge_agent_animation_pid="$command_pid"
	command_status=0
	wasmedge_agent_animate_until_exit "$title" "$status" "$detail" pulse "$command_pid" ||
		command_status=$?
	# Cleared the moment it is reaped. Held any longer, a signal arriving
	# while the output below is read would have the trap kill a pid the
	# system may already have handed to something else.
	wasmedge_agent_animation_pid=

	if [ "$command_status" -ne 0 ] && [ -s "$error_file" ]; then
		wasmedge_agent_restore_terminal
		printf '\n' >&2
		cat "$error_file" >&2
	fi
	wasmedge_agent_animation_dir=
	rm -rf "$output_dir"
	return "$command_status"
}

wasmedge_agent_run_quiet_with_animation() {
	title="$1"
	status="$2"
	detail="$3"
	shift 3

	wasmedge_agent_run_quiet_with_animation_command "$title" "$status" "$detail" pulse "$@"
}

wasmedge_agent_run_quiet_with_animation_steps() {
	title="$1"
	status="$2"
	details="$3"
	shift 3

	wasmedge_agent_run_quiet_with_animation_command "$title" "$status" "$details" static "$@"
}

wasmedge_agent_run_quiet_with_animation_command() {
	title="$1"
	status="$2"
	details="$3"
	status_mode="$4"
	shift 4

	if [ "$wasmedge_agent_screen_enabled" != 1 ]; then
		printf '%s\n' "$status" >&2
		"$@"
		return
	fi

	output_dir=$(create_temp_dir)
	wasmedge_agent_animation_dir="$output_dir"
	output_file="$output_dir/output"
	"$@" >"$output_file" 2>&1 &
	command_pid=$!
	wasmedge_agent_animation_pid="$command_pid"
	command_status=0
	wasmedge_agent_animate_until_exit "$title" "$status" "$details" "$status_mode" "$command_pid" ||
		command_status=$?
	wasmedge_agent_animation_pid=

	if [ "$command_status" -ne 0 ] && [ -s "$output_file" ]; then
		wasmedge_agent_restore_terminal
		printf '\n' >&2
		cat "$output_file" >&2
	fi
	wasmedge_agent_animation_dir=
	rm -rf "$output_dir"
	return "$command_status"
}

wasmedge_agent_prompt_yes_no() {
	question="$1"
	detail="$2"
	input_prompt="$3"

	# --yes and --now: every prompt here offers install as its default, so
	# unattended means answering them rather than skipping the work behind
	# them.
	if [ "$wasmedge_agent_assume_yes" = 1 ]; then
		return 0
	fi

	if ( : <>/dev/tty ) 2>/dev/null; then
		prompt_input=tty
		exec 3<>/dev/tty
	elif [ -t 0 ]; then
		prompt_input=stdin
	else
		return 2
	fi

	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "$question" "" "$detail" "$input_prompt"
		wasmedge_agent_place_prompt_cursor "$input_prompt"
	else
		printf '%s\n' "$detail"
		if [ "$prompt_input" = tty ]; then
			printf '%s ' "$input_prompt" >&3
		else
			printf '%s ' "$input_prompt" >&2
		fi
	fi

	if [ "$prompt_input" = tty ]; then
		if ! IFS= read -r answer <&3; then
			answer=
		fi
		exec 3>&-
	else
		if ! IFS= read -r answer; then
			answer=
		fi
	fi

	case "$answer" in
		n|N|no|NO)
			return 1
			;;
	esac
	return 0
}

start_preflight_checks() {
	preflight_dir=$(create_temp_dir)
	preflight_file="$preflight_dir/preflight"
	run_preflight_checks >"$preflight_file" &
	preflight_pid=$!
}

finish_preflight_checks() {
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		while kill -0 "$preflight_pid" 2>/dev/null; do
			wasmedge_agent_screen "Checking Node.js and npm$(wasmedge_agent_pulse)" "" "" ""
			sleep 0.18
		done
	fi

	if wait "$preflight_pid"; then
		preflight_status=0
	else
		preflight_status=$?
	fi

	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		if [ "$preflight_status" -ne 0 ]; then
			preflight_summary=$(sed -n '1p' "$preflight_file")
			wasmedge_agent_screen "Node.js 22.8.0 or newer is required" "" "$preflight_summary" ""
			sleep 0.4
		elif [ -s "$preflight_file" ]; then
			preflight_summary="Existing $wasmedge_agent_cmd command found on PATH."
			wasmedge_agent_screen "Environment ready" "" "$preflight_summary" ""
			sleep 0.4
		fi
	else
		cat "$preflight_file"
	fi
	rm -rf "$preflight_dir"
	return "$preflight_status"
}

run_preflight_checks() {
	status=0
	yellow="${wasmedge_agent_esc}[33m"
	reset="${wasmedge_agent_esc}[0m"

	if command -v node >/dev/null 2>&1; then
		node_version=$(node --version)
		if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 8 || (minor === 8 && patch >= 0))) ? 0 : 1)' >/dev/null; then
			printf 'error: WasmEdge Agent requires Node.js 22.8.0 or newer. Found %s.\n' "$node_version"
			status=1
		fi
	else
		printf 'error: Node.js 22.8.0 or newer is required to install WasmEdge Agent.\n'
		status=1
	fi

	if ! command -v npm >/dev/null 2>&1; then
		printf 'error: npm is required to install WasmEdge Agent.\n'
		status=1
	fi

	if [ "$status" -ne 0 ]; then
		printf '\n'
	fi

	if wasmedge_agent_path=$(command -v "$wasmedge_agent_cmd" 2>/dev/null); then
		printf '%sExisting %s found at: %s%s\n' "$yellow" "$wasmedge_agent_cmd" "$wasmedge_agent_path" "$reset"
		printf '\n'
	fi

	return "$status"
}

# The installer's modes, from issue #3's installer contract and issue #5's
# definition of the launcher that drives it.
#
#   --check   report on the runtime and change nothing
#   --yes     answer prompts with their defaults, for unattended installs
#   --now     the same, spelled the way the launcher spells it
#
# Anything else option-shaped is refused rather than read as a version: the
# version validator accepts hyphens, so `install.sh --check` used to resolve
# the version `--check` and go looking for
# releases/v--check/wasmedge-agent---check.tgz, which cannot exist.
parse_wasmedge_agent_arguments() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--check)
				wasmedge_agent_check_only=1
				;;
			--yes | -y | --now)
				wasmedge_agent_assume_yes=1
				;;
			--help | -h)
				print_wasmedge_agent_usage
				exit 0
				;;
			-*)
				printf 'error: unknown option: %s\n' "$1" >&2
				print_wasmedge_agent_usage >&2
				exit 1
				;;
			*)
				if [ -n "$wasmedge_agent_requested_version" ]; then
					printf 'error: unexpected argument: %s\n' "$1" >&2
					print_wasmedge_agent_usage >&2
					exit 1
				fi
				wasmedge_agent_requested_version="$1"
				;;
		esac
		shift
	done
}

# Where a release's files sit under the host. Every URL this script builds for
# a published file comes from here, so moving to a different release layout
# is an edit to this function rather than a search through the script.
#
# An empty file name yields the release's prefix, with its trailing slash,
# which is what the staged-package rewrite matches against.
wasmedge_agent_release_asset_url() {
	printf '%s/download/v%s/%s' "$wasmedge_agent_base_url" "$1" "$2"
}

# Where a channel's own objects sit. Stable rides GitHub's `latest` alias,
# which is the newest release that is neither a draft nor a prerelease, and
# which GitHub switches in one operation. Every other channel is a release
# tagged with the channel's name, whose assets are replaced as the channel
# moves.
wasmedge_agent_channel_url() {
	case "$1" in
		stable) printf '%s/latest/download/%s' "$wasmedge_agent_base_url" "$2" ;;
		*) printf '%s/download/%s/%s' "$wasmedge_agent_base_url" "$1" "$2" ;;
	esac
}

print_wasmedge_agent_usage() {
	cat <<EOF
usage: install.sh [--check] [--yes|--now] [stable|beta|<version>]

  --check      report on the installed runtime and change nothing
  --yes,--now  answer prompts with their defaults, for unattended installs
EOF
}

# WasmEdge is present when it runs, and not when a file exists at its path. A
# partial extraction, an interrupted package install, or a build against
# another libc all leave an executable that cannot start, and a check that
# stopped at the file called such a host ready: the install finished, --check
# said ok, and the first rust cell was where the host found out.
#
# Every candidate is tried in precedence order, and the first one that answers
# wins. Stopping at the first that exists let a broken entry on PATH hide a
# working ~/.wasmedge/bin/wasmedge behind it -- and reinstalling could not
# repair that, because the broken one went on being the one selected.
#
# Prints the path that answered, so a caller can say which binary it found.
wasmedge_try() {
	[ -n "$1" ] && [ -x "$1" ] || return 1
	if "$1" --version >/dev/null 2>&1; then
		printf '%s\n' "$1"
		return 0
	fi
	# Exists and does not run, which is a different repair from missing.
	wasmedge_broken=1
	return 1
}

wasmedge_usable_bin() {
	wasmedge_broken=0
	if [ -n "${WASMEDGE_AGENT_WASMEDGE:-}" ]; then
		# The only candidate, the way the runtime treats it. --check reports on
		# the runtime the agent will use, so the two have to agree about which
		# binary that is -- and pointing at a binary and silently getting a
		# different one is worse than being told this one does not work.
		wasmedge_try "$WASMEDGE_AGENT_WASMEDGE" && return 0
	else
		wasmedge_try "$(command -v wasmedge 2>/dev/null)" && return 0
		wasmedge_try "$HOME/.wasmedge/bin/wasmedge" && return 0
	fi
	[ "$wasmedge_broken" -eq 1 ] || return 1
	return 2
}

# Reports on the runtime issue #5 asks --check to verify: the agent, WasmEdge,
# the Rust target, and the cell workspace. Reads only -- nothing here installs,
# repairs, or writes, which is what makes it safe to run from a launcher on
# every invocation.
#
# The agent's own doctor is the last word on the workspace, and it is run
# without --fix precisely so it stays a report.
check_wasmedge_agent_runtime() {
	check_status=0

	if command -v node >/dev/null 2>&1 &&
		node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 8) ? 0 : 1)' >/dev/null 2>&1; then
		printf 'ok       Node.js %s\n' "$(node --version)"
	else
		printf 'missing  Node.js 22.8.0 or newer\n'
		check_status=1
	fi

	if command -v npm >/dev/null 2>&1; then
		printf 'ok       npm %s\n' "$(npm --version 2>/dev/null)"
	else
		printf 'missing  npm\n'
		check_status=1
	fi

	if command -v rustup >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/rustup" ]; then
		# On stable, for the reason provisioning installs it there: this reports
		# on the runtime issue #3 asks for, and the active toolchain is not it.
		if PATH="$HOME/.cargo/bin:$PATH" rustup target list --installed --toolchain stable 2>/dev/null |
			grep -q '^wasm32-wasip1$'; then
			printf 'ok       rustup with the wasm32-wasip1 target on stable\n'
		else
			printf 'missing  the wasm32-wasip1 target on stable (rustup target add --toolchain stable wasm32-wasip1)\n'
			check_status=1
		fi
	else
		printf 'missing  rustup\n'
		check_status=1
	fi

	check_wasmedge_status=0
	check_wasmedge_bin=$(wasmedge_usable_bin) || check_wasmedge_status=$?
	if [ "$check_wasmedge_status" -eq 0 ]; then
		printf 'ok       WasmEdge (%s)\n' "$check_wasmedge_bin"
	elif [ "$check_wasmedge_status" -eq 2 ]; then
		printf 'broken   WasmEdge: installed, and it does not run\n'
		check_status=1
	else
		printf 'missing  WasmEdge\n'
		check_status=1
	fi

	check_agent_path=$(command -v "$wasmedge_agent_cmd" 2>/dev/null) || check_agent_path=
	if [ -z "$check_agent_path" ]; then
		check_npm_prefix=$(npm prefix -g 2>/dev/null) || check_npm_prefix=
		if [ -n "$check_npm_prefix" ] && [ -x "$check_npm_prefix/bin/$wasmedge_agent_cmd" ]; then
			check_agent_path="$check_npm_prefix/bin/$wasmedge_agent_cmd"
		fi
	fi

	if [ -z "$check_agent_path" ]; then
		printf 'missing  %s\n' "$wasmedge_agent_cmd"
		return 1
	fi

	if check_version=$("$check_agent_path" --version 2>/dev/null); then
		printf 'ok       %s %s\n' "$wasmedge_agent_cmd" "$check_version"
	else
		printf 'missing  a working %s (--version failed)\n' "$wasmedge_agent_cmd"
		return 1
	fi

	# Read out of the report rather than from its exit status: `doctor` reports
	# and exits 0 whatever it finds, and `doctor --fix` is the mode that
	# repairs, which is the one thing --check must not do.
	if check_report=$("$check_agent_path" doctor --json 2>/dev/null) &&
		printf '%s' "$check_report" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const runtime = Array.isArray(report.runtime) ? report.runtime : [];
	const failed = runtime.filter((check) => check && check.ok === false);
	for (const check of failed) console.log("missing  " + check.name + ": " + check.detail);
	process.exit(runtime.length > 0 && failed.length === 0 ? 0 : 1);
});
'; then
		printf 'ok       %s doctor\n' "$wasmedge_agent_cmd"
	else
		printf 'missing  a healthy runtime (%s doctor reported problems)\n' "$wasmedge_agent_cmd"
		check_status=1
	fi

	return "$check_status"
}

resolve_wasmedge_agent_version() {
	if [ "${1:-}" ]; then
		case "$1" in
			stable|beta) release_channel="$1" ;;
			*)
				normalize_version "$1"
				return
				;;
		esac
	else
		release_channel="$wasmedge_agent_release_channel"
	fi

	wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_VERSION" "PRIME_AGENT_VERSION" \
		"${WASMEDGE_AGENT_VERSION:-}" "${PRIME_AGENT_VERSION:-}"
	if [ "${WASMEDGE_AGENT_VERSION:-${PRIME_AGENT_VERSION:-}}" ]; then
		normalize_version "${WASMEDGE_AGENT_VERSION:-${PRIME_AGENT_VERSION:-}}"
		return
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to resolve the latest WasmEdge Agent version.\n' >&2
		exit 1
	fi

	case "$release_channel" in
		stable|beta) ;;
		*)
			printf 'error: invalid WasmEdge Agent release channel: %s\n' "$release_channel" >&2
			exit 1
			;;
	esac

	# The JSON manifest, which is the object the installed agent's own update
	# check reads. A channel used to be published twice -- as this JSON and as
	# a one-line text file -- and read once each way, so a publication that
	# moved one and failed before the other left fresh installs and installed
	# agents resolving different releases. One object answers both now; the
	# text file is still published for anything outside this repository that
	# reads it, and nothing here depends on the two agreeing.
	case "$release_channel" in
		stable) channel_manifest=latest.json ;;
		*) channel_manifest="$release_channel.json" ;;
	esac

	channel_manifest_url=$(wasmedge_agent_channel_url "$release_channel" "$channel_manifest")

	if [ -z "$wasmedge_agent_channel_manifest" ]; then
		printf 'error: no path was prepared for the channel manifest.\n' >&2
		exit 1
	fi
	if ! wasmedge_agent_run_quiet_with_animation \
		"Resolving latest release" \
		"Resolving latest release" \
		"Checking the $release_channel release channel." \
		curl -fsSL "$channel_manifest_url" -o "$wasmedge_agent_channel_manifest"; then
		printf 'error: could not resolve latest WasmEdge Agent version from %s\n' \
			"$channel_manifest_url" >&2
		exit 1
	fi

	channel_version=$(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof manifest.version !== "string" || !manifest.version.trim()) process.exit(1);
console.log(manifest.version.trim());
' "$wasmedge_agent_channel_manifest" < /dev/null) || channel_version=
	if [ -z "$channel_version" ]; then
		printf 'error: %s named no version.\n' "$channel_manifest_url" >&2
		exit 1
	fi

	normalize_version "$channel_version"
}

# The manifest of the release being installed, when resolving a channel did not
# already read one.
#
# Resolving a channel leaves that channel manifest behind, and it is the only
# thing that says which package each file of the release contains. An install
# that names a version resolves no channel, so it had none of that: the three
# packages it fetched beside the one it was asked for were held to their
# digests alone, and a digest says the bytes are the ones published under a
# file name and nothing about what is inside them.
#
# Every release publishes this object under its own prefix as well as at the
# channel names, so a version is enough to ask for one. Missing is fatal, since
# it is what the packages that arrive are checked against.
fetch_wasmedge_agent_release_manifest() {
	manifest_version="$1"

	if [ -s "$wasmedge_agent_channel_manifest" ]; then
		return 0
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to read what WasmEdge Agent v%s publishes.\n' "$manifest_version" >&2
		exit 1
	fi

	release_manifest_url=$(wasmedge_agent_release_asset_url "$manifest_version" release.json)

	if ! wasmedge_agent_run_quiet_with_animation \
		"Reading release v$manifest_version" \
		"Reading release v$manifest_version" \
		"Asking what v$manifest_version publishes." \
		curl -fsSL "$release_manifest_url" \
			-o "$wasmedge_agent_channel_manifest"; then
		printf 'error: could not read %s\n' "$release_manifest_url" >&2
		printf 'It names the package behind each file this installs, and nothing else does.\n' >&2
		exit 1
	fi
}

normalize_version() {
	version="${1#v}"
	case "$version" in
		"")
			printf 'error: empty WasmEdge Agent version.\n' >&2
			exit 1
			;;
		*[!0-9A-Za-z.-]*)
			printf 'error: invalid WasmEdge Agent version: %s\n' "$1" >&2
			exit 1
			;;
	esac
	printf '%s' "$version"
}

install_node_npm_interactive() {
	method=$(detect_node_install_method)
	case "$method" in
		homebrew) label="Homebrew" ;;
		apt) label="apt" ;;
		apk) label="apk" ;;
		standalone) label="standalone Node.js" ;;
		*)
			method=standalone
			label="standalone Node.js"
			;;
	esac

	if wasmedge_agent_prompt_yes_no \
		"Install Node.js and npm with $label?" \
		"Required before WasmEdge Agent can be installed." \
		"Install? [Y/n]"; then
		install_node_npm "$method" "$label"
		return
	else
		prompt_status=$?
	fi
	if [ "$prompt_status" -eq 2 ]; then
		# No terminal is not a refusal, and the two runtime prompts below have
		# always read it that way: `curl ... | sh` on a clean host is the case
		# this installer exists for, and answering it with instructions to run
		# the installer again left it unable to install anything at all.
		printf 'No terminal detected; installing Node.js and npm with %s.\n' "$label"
		install_node_npm "$method" "$label"
		return
	fi

	printf '\nInstall Node.js 22.8.0 or newer and npm, then run this installer again.\n'
	return 1
}

detect_node_install_method() {
	case "$(uname -s)" in
		Darwin)
			if command -v brew >/dev/null 2>&1; then
				printf 'homebrew'
			else
				printf 'standalone'
			fi
			;;
		Linux)
			if command -v apt-cache >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && apt_node_candidate_is_new_enough; then
				printf 'apt'
			elif command -v apk >/dev/null 2>&1 && apk_node_candidate_is_new_enough; then
				printf 'apk'
			else
				printf 'standalone'
			fi
			;;
		*)
			printf 'standalone'
			;;
	esac
}

apt_node_candidate_is_new_enough() {
	version=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')
	[ -n "$version" ] && [ "$version" != "(none)" ] && node_version_string_is_new_enough "$version"
}

apk_node_candidate_is_new_enough() {
	version=$(apk search -x nodejs 2>/dev/null | awk -F- '/^nodejs-/ { print $2; exit }')
	[ -n "$version" ] && node_version_string_is_new_enough "$version"
}

node_version_string_is_new_enough() {
	version="${1#v}"
	case "$version" in
		[0-9]*) ;;
		*) return 1 ;;
	esac
	version="${version%%[!0-9.]*}"
	version_ifs=${IFS- }
	IFS=.
	set -- $version
	IFS=$version_ifs
	major="${1:-}"
	minor="${2:-0}"
	patch="${3:-0}"
	case "$major" in ''|*[!0-9]*) return 1 ;; esac
	case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
	case "$patch" in ''|*[!0-9]*) patch=0 ;; esac

	# Must stay the package's engines.node floor: a machine the installer
	# accepts and the CLI rejects installs cleanly and then fails on first
	# launch, with npm having said nothing louder than an engine warning.
	# check-installer-render.mjs holds the two together.
	[ "$major" -gt 22 ] && return 0
	[ "$major" -eq 22 ] && [ "$minor" -gt 8 ] && return 0
	[ "$major" -eq 22 ] && [ "$minor" -eq 8 ] && [ "$patch" -ge 0 ] && return 0
	return 1
}

install_node_npm() {
	method="$1"
	label="$2"

	if [ "$wasmedge_agent_screen_enabled" != 1 ]; then
		printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
		run_node_install_method "$method"
	else
		prepare_sudo_for_node_install "$method"
		node_install_details="Using $label.
Resolving Node.js packages.
Downloading Node.js runtime.
Installing npm.
Preparing WasmEdge Agent setup."
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing Node.js and npm" \
			"Installing Node.js and npm" \
			"$node_install_details" \
			run_node_install_method "$method"
	fi

	if [ "$method" = standalone ]; then
		load_standalone_node
		WASMEDGE_AGENT_NODE_INSTALLED_STANDALONE=1
	fi
	hash -r
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "Node.js and npm installed" "" "Continuing WasmEdge Agent setup." ""
	else
		printf '\nNode.js and npm are installed.\n\n'
	fi
}

node_install_needs_sudo() {
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		return 1
	fi

	case "$1" in
		apt|apk)
			return 0
			;;
		standalone)
			[ "$(uname -s)" = Linux ] || return 1
			command -v xz >/dev/null 2>&1 && return 1
			command -v apt-get >/dev/null 2>&1 || command -v apk >/dev/null 2>&1
			;;
		*)
			return 1
			;;
	esac
}

prepare_sudo_for_node_install() {
	method="$1"
	if ! node_install_needs_sudo "$method"; then
		return 0
	fi

	wasmedge_agent_screen "Preparing Node.js install" "" "This may ask for your sudo password." ""
	wasmedge_agent_restore_terminal
	printf '\n'
	sudo -v
}

run_node_install_method() {
	case "$1" in
		homebrew) install_node_with_homebrew ;;
		apt) install_node_with_apt ;;
		apk) install_node_with_apk ;;
		standalone) install_node_standalone ;;
	esac
}

install_node_with_homebrew() {
	if brew list node >/dev/null 2>&1; then
		brew upgrade node
	else
		brew install node
	fi
}

install_node_with_apt() {
	print_sudo_note
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		apt-get update
		apt-get install -y nodejs npm
	else
		sudo sh -c 'apt-get update && apt-get install -y nodejs npm'
	fi
}

install_node_with_apk() {
	print_sudo_note
	run_with_sudo apk add --update-cache nodejs npm
}

install_node_standalone() {
	node_platform=$(detect_node_binary_platform) || {
		printf 'Unsupported operating system for automatic Node.js install: %s\n' "$(uname -s)"
		return 1
	}
	node_arch=$(detect_node_binary_arch) || {
		printf 'Unsupported CPU architecture for automatic Node.js install: %s\n' "$(uname -m)"
		return 1
	}
	node_dist_base="https://nodejs.org/dist/latest-v22.x"
	node_base_dir=$(node_standalone_base_dir)
	node_tmp_dir=$(create_temp_dir)

	mkdir -p "$node_tmp_dir" "$node_base_dir"

	printf 'Resolving Node.js binary for %s-%s\n' "$node_platform" "$node_arch"
	curl -fsSL "$node_dist_base/SHASUMS256.txt" -o "$node_tmp_dir/SHASUMS256.txt"
	node_file=$(awk -v suffix="-$node_platform-$node_arch.tar.xz" '
		index($2, "node-v") == 1 && length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
	' "$node_tmp_dir/SHASUMS256.txt")
	if [ -z "$node_file" ]; then
		printf 'No Node.js binary is available for %s-%s.\n' "$node_platform" "$node_arch"
		rm -rf "$node_tmp_dir"
		return 1
	fi
	case "$node_file" in
		*/*|*\\*|*..*)
			printf 'Unsafe Node.js archive name in checksum manifest: %s\n' "$node_file"
			rm -rf "$node_tmp_dir"
			return 1
			;;
		node-v*-"$node_platform"-"$node_arch".tar.xz) ;;
		*)
			printf 'Unexpected Node.js archive name in checksum manifest: %s\n' "$node_file"
			rm -rf "$node_tmp_dir"
			return 1
			;;
	esac

	printf 'Downloading Node.js %s\n' "${node_file%.tar.xz}"
	curl -fsSL "$node_dist_base/$node_file" -o "$node_tmp_dir/$node_file"
	verify_node_standalone_download "$node_tmp_dir" "$node_file"
	ensure_node_standalone_extract_tools "$node_platform"

	node_dir="$node_base_dir/${node_file%.tar.xz}"
	rm -rf "$node_dir"
	printf 'Extracting Node.js to %s\n' "$node_dir"
	tar -xf "$node_tmp_dir/$node_file" -C "$node_base_dir"
	rm -f "$node_base_dir/current"
	ln -s "$node_dir" "$node_base_dir/current"
	rm -rf "$node_tmp_dir"
	printf 'Node.js installed at %s\n' "$node_dir"
}

verify_node_standalone_download() {
	checksum_dir="$1"
	checksum_file_name="$2"
	awk -v file="$checksum_file_name" '$2 == file { print }' "$checksum_dir/SHASUMS256.txt" >"$checksum_dir/SHASUMS256.selected"

	if command -v sha256sum >/dev/null 2>&1; then
		printf 'Verifying Node.js download\n'
		(cd "$checksum_dir" && sha256sum -c SHASUMS256.selected)
	elif command -v shasum >/dev/null 2>&1; then
		printf 'Verifying Node.js download\n'
		(cd "$checksum_dir" && shasum -a 256 -c SHASUMS256.selected)
	else
		printf 'error: sha256sum or shasum is required to verify the Node.js download.\n'
		return 1
	fi
}

ensure_node_standalone_extract_tools() {
	extract_platform="$1"

	if [ "$extract_platform" = linux ] && ! command -v xz >/dev/null 2>&1; then
		printf 'Installing xz-utils for Node.js archive extraction\n'
		print_sudo_note
		if command -v apt-get >/dev/null 2>&1; then
			run_with_sudo apt-get update
			run_with_sudo apt-get install -y xz-utils
		elif command -v apk >/dev/null 2>&1; then
			run_with_sudo apk add --update-cache xz
		else
			printf 'xz is required to extract Node.js. Install xz and run this installer again.\n'
			return 1
		fi
	fi
}

load_standalone_node() {
	WASMEDGE_AGENT_STANDALONE_NODE_BIN="$(node_standalone_base_dir)/current/bin"
	PATH="$WASMEDGE_AGENT_STANDALONE_NODE_BIN:$PATH"
	export WASMEDGE_AGENT_STANDALONE_NODE_BIN PATH
}

node_standalone_base_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		printf '%s/wasmedge-agent-node' "$XDG_DATA_HOME"
	else
		printf '%s/.local/share/wasmedge-agent-node' "$HOME"
	fi
}

detect_node_binary_platform() {
	case "$(uname -s)" in
		Darwin) printf 'darwin' ;;
		Linux) printf 'linux' ;;
		*) return 1 ;;
	esac
}

detect_node_binary_arch() {
	case "$(uname -m)" in
		x86_64|amd64) printf 'x64' ;;
		arm64|aarch64) printf 'arm64' ;;
		armv7l) printf 'armv7l' ;;
		ppc64le) printf 'ppc64le' ;;
		s390x) printf 's390x' ;;
		*) return 1 ;;
	esac
}

print_sudo_note() {
	if [ "${EUID:-$(id -u)}" -ne 0 ]; then
		printf 'This may ask for your sudo password.\n\n'
	fi
}

run_with_sudo() {
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		"$@"
	else
		sudo "$@"
	fi
}

configure_standalone_node_path() {
	if original_wasmedge_agent_path=$(resolve_wasmedge_agent_with_original_path); then
		case "$original_wasmedge_agent_path" in
			"$WASMEDGE_AGENT_STANDALONE_NODE_BIN/"*)
				if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
					wasmedge_agent_screen "WasmEdge Agent installed" "" "Run it with: $wasmedge_agent_cmd" ""
				else
					printf '\nRun it with: %s\n' "$wasmedge_agent_cmd"
				fi
				return 0
				;;
		esac
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_screen "WasmEdge Agent installed" "" "PATH update needed for $wasmedge_agent_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$wasmedge_agent_cmd"
			printf 'Your shell currently resolves %s to: %s\n' "$wasmedge_agent_cmd" "$original_wasmedge_agent_path"
		fi
	else
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_screen "WasmEdge Agent installed" "" "PATH update needed for $wasmedge_agent_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$wasmedge_agent_cmd"
		fi
	fi

	profile=$(detect_shell_profile) || {
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_restore_terminal
			printf '\n'
		fi
		print_standalone_path_manual_instructions
		return 0
	}

	if shell_profile_has_standalone_node_path "$profile"; then
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_screen "WasmEdge Agent installed" "" "Run: $(wasmedge_agent_source_profile_command "$profile")" ""
		else
			printf '%s already contains %s.\n' "$profile" "$WASMEDGE_AGENT_STANDALONE_NODE_BIN"
			printf 'Restart your shell or run: %s\n' "$(wasmedge_agent_source_profile_command "$profile")"
		fi
		return 0
	fi

	prompt_add_standalone_node_path "$profile"
}

resolve_wasmedge_agent_with_original_path() {
	saved_path=$PATH
	PATH=$wasmedge_agent_original_path
	if command -v "$wasmedge_agent_cmd" 2>/dev/null; then
		status=0
	else
		status=$?
	fi
	PATH=$saved_path
	return "$status"
}

detect_shell_profile() {
	wasmedge_agent_warn_if_legacy_env "WASMEDGE_AGENT_SHELL_PROFILE" "PRIME_AGENT_SHELL_PROFILE" \
		"${WASMEDGE_AGENT_SHELL_PROFILE:-}" "${PRIME_AGENT_SHELL_PROFILE:-}"
	if [ -n "${WASMEDGE_AGENT_SHELL_PROFILE:-${PRIME_AGENT_SHELL_PROFILE:-}}" ]; then
		printf '%s' "${WASMEDGE_AGENT_SHELL_PROFILE:-${PRIME_AGENT_SHELL_PROFILE:-}}"
		return 0
	fi
	if [ -z "${HOME:-}" ]; then
		return 1
	fi

	shell_name="${SHELL:-}"
	shell_name="${shell_name##*/}"
	case "$shell_name" in
		zsh)
			printf '%s/.zshrc' "${ZDOTDIR:-$HOME}"
			;;
		bash)
			printf '%s/.bashrc' "$HOME"
			;;
		*)
			if [ -f "$HOME/.zshrc" ]; then
				printf '%s/.zshrc' "$HOME"
			elif [ -f "$HOME/.bashrc" ]; then
				printf '%s/.bashrc' "$HOME"
			else
				printf '%s/.profile' "$HOME"
			fi
			;;
	esac
}

shell_profile_has_standalone_node_path() {
	profile="$1"
	[ -f "$profile" ] && grep -F "$WASMEDGE_AGENT_STANDALONE_NODE_BIN" "$profile" >/dev/null 2>&1
}

prompt_add_standalone_node_path() {
	profile="$1"
	path_line=$(standalone_node_path_line)

	if ! wasmedge_agent_prompt_yes_no \
		"Add standalone Node.js to your PATH?" \
		"Updates $profile so future shells can run $wasmedge_agent_cmd." \
		"Update PATH? [Y/n]"; then
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_restore_terminal
			printf '\n'
		fi
		print_standalone_path_manual_instructions
		return 0
	fi

	mkdir -p "$(dirname "$profile")"
	{
		printf '\n# WasmEdge Agent standalone Node.js\n'
		printf '%s\n' "$path_line"
	} >>"$profile"
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "WasmEdge Agent installed" "" "Run: $(wasmedge_agent_source_profile_command "$profile")" ""
	else
		printf 'Added %s to %s.\n' "$WASMEDGE_AGENT_STANDALONE_NODE_BIN" "$profile"
		printf 'Restart your shell or run: %s\n' "$(wasmedge_agent_source_profile_command "$profile")"
	fi
}

print_standalone_path_manual_instructions() {
	printf 'Add this to your shell profile to use %s from new shells:\n\n' "$wasmedge_agent_cmd"
	printf '  %s\n' "$(standalone_node_path_line)"
	printf '\nThen restart your shell and run: %s\n' "$wasmedge_agent_cmd"
}

standalone_node_path_line() {
	printf 'export PATH="%s:$PATH"' "$WASMEDGE_AGENT_STANDALONE_NODE_BIN"
}

wasmedge_agent_shell_quote() {
	quoted=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
	printf "'%s'" "$quoted"
}

wasmedge_agent_source_profile_command() {
	printf '. %s && %s' "$(wasmedge_agent_shell_quote "$1")" "$wasmedge_agent_cmd"
}

download_wasmedge_agent_package() {
	version="$1"
	tarball_url="$2"
	tarball_path="$3"
	download_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	checksums_url=$(wasmedge_agent_release_asset_url "$version" SHA256SUMS)
	checksums_path="$download_dir/SHA256SUMS"

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to download WasmEdge Agent.\n' >&2
		exit 1
	fi

	wasmedge_agent_run_quiet_with_animation \
		"Downloading checksums" \
		"Downloading release checksums" \
		"WasmEdge Agent v$version" \
		curl -fsSL "$checksums_url" -o "$checksums_path"

	wasmedge_agent_run_quiet_with_animation \
		"Downloading WasmEdge Agent" \
		"Downloading WasmEdge Agent v$version" \
		"Fetching the verified package." \
		curl -fsSL "$tarball_url" -o "$tarball_path"

	verify_wasmedge_agent_package_checksum "$checksums_path" "$tarball_path"
}

verify_wasmedge_agent_package_checksum() {
	checksums_path="$1"
	tarball_path="$2"
	checksum_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	selected_checksums_path="$checksum_dir/SHA256SUMS.selected"

	if ! awk -v file="$tarball_name" '$2 == file { print; found = 1; exit } END { if (!found) exit 1 }' \
		"$checksums_path" >"$selected_checksums_path"; then
		printf 'error: checksum for %s was not found in %s\n' "$tarball_name" "$checksums_path" >&2
		exit 1
	fi

	if command -v sha256sum >/dev/null 2>&1; then
		wasmedge_agent_run_quiet_with_animation \
			"Verifying download" \
			"Verifying WasmEdge Agent download" \
			"Checking SHA-256." \
			wasmedge_agent_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		wasmedge_agent_run_quiet_with_animation \
			"Verifying download" \
			"Verifying WasmEdge Agent download" \
			"Checking SHA-256." \
			wasmedge_agent_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" shasum
	else
		printf 'error: sha256sum or shasum is required to verify the WasmEdge Agent download.\n' >&2
		exit 1
	fi
}

# Resolves the release's own packages to files this script has verified.
#
# SHA256SUMS covers all four published tarballs, but only one of them was ever
# fetched here. The other three are reached from it as URLs under the same
# release -- two from its own manifest, and the AI package again from inside
# the core package's -- and npm resolves every one of them itself: npm carries
# no integrity
# metadata for a URL dependency, and a global install of a tarball has no
# lockfile to hold any. So three quarters of what landed on the machine
# arrived unchecked, beside a package this script had just checksummed.
#
# They are fetched here instead, checked against the same SHA256SUMS, and
# handed to npm as local files. A file: dependency is installed from disk, and
# its own dependencies still resolve from the registry exactly as before, so
# nothing outside our four packages changes.
#
# A shipped npm-shrinkwrap.json would have been the smaller fix, and it does
# not work: npm records an integrity hash for a URL dependency in a lockfile,
# then installs replaced bytes from that URL without checking them.
#
# Sets wasmedge_agent_install_tarball to what should be installed. That is the
# downloaded tarball itself when the release has no internal dependencies to
# resolve, so the fetch-and-repack only happens when there is something to
# verify.
stage_verified_wasmedge_agent_package() {
	staged_version="$1"
	staged_tarball="$2"
	staged_checksums="$3"
	staged_dir=$(dirname "$staged_tarball")
	staged_name=$(basename "$staged_tarball")
	staged_prefix=$(wasmedge_agent_release_asset_url "$staged_version" "")
	staged_root="$staged_dir/staged"
	wasmedge_agent_install_tarball="$staged_tarball"

	if ! command -v tar >/dev/null 2>&1; then
		printf 'error: tar is required to verify the WasmEdge Agent packages.\n' >&2
		exit 1
	fi

	mkdir -p "$staged_root/deps" "$staged_root/pkg"
	printf '%s\n' "$staged_name" > "$staged_root/queue"
	printf '%s\n' "$staged_name" > "$staged_root/seen"
	: > "$staged_root/processed"

	# Breadth-first over the release's own packages, because they depend on
	# each other: the core package names the AI package by URL in its own
	# manifest, so resolving the installed package's manifest and stopping
	# there left npm fetching one of them the unchecked way.
	while [ -s "$staged_root/queue" ]; do
		staged_file=$(head -n 1 "$staged_root/queue")
		tail -n +2 "$staged_root/queue" > "$staged_root/queue.rest"
		mv "$staged_root/queue.rest" "$staged_root/queue"
		printf '%s\n' "$staged_file" >> "$staged_root/processed"

		mkdir -p "$staged_root/pkg/$staged_file"
		tar -xzf "$staged_dir/$staged_file" -C "$staged_root/pkg/$staged_file"
		staged_manifest="$staged_root/pkg/$staged_file/package/package.json"
		if [ ! -f "$staged_manifest" ]; then
			printf 'error: %s does not contain package/package.json\n' "$staged_file" >&2
			exit 1
		fi

		# A digest says the bytes are the ones published under this file name,
		# and nothing about the package inside them. This install resolved one
		# version and installs one package name, and every artifact of a
		# release carries that release's version, so each package that arrives
		# is held to those two facts.
		if [ "$staged_file" = "$staged_name" ]; then
			staged_expected_name="$wasmedge_agent_package"
		else
			staged_expected_name=
		fi
		if [ -n "${wasmedge_agent_channel_manifest:-}" ] && [ -f "$wasmedge_agent_channel_manifest" ]; then
			staged_channel_manifest="$wasmedge_agent_channel_manifest"
		else
			staged_channel_manifest=
		fi
		node -e '
const fs = require("fs");
const [manifestPath, file, expectedName, expectedVersion, channelManifestPath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
	console.error("error: " + file + " declares no package name and version.");
	process.exit(1);
}
// What the file has to contain. The install target names the root, and the
// release manifest names every artifact -- which is the only thing that can:
// a digest says nothing about what is inside the bytes, the file name is a
// choice the packer makes, and a package that depends on another one keys it
// by its source package name rather than by the branded name its artifact
// carries. An artifact nothing names cannot be checked, and is refused.
let required = expectedName;
if (!required && channelManifestPath) {
	const channel = JSON.parse(fs.readFileSync(channelManifestPath, "utf8"));
	const entry = (Array.isArray(channel.tarballs) ? channel.tarballs : []).find((each) => each && each.file === file);
	if (entry && typeof entry.package === "string") required = entry.package;
}
if (!required) {
	console.error("error: the release manifest does not say which package " + file + " should contain.");
	process.exit(1);
}
if (manifest.name !== required) {
	console.error("error: " + file + " should be " + required + " and contains " + manifest.name + ".");
	process.exit(1);
}
if (manifest.version !== expectedVersion) {
	console.error("error: " + file + " should be version " + expectedVersion + " and contains " +
		manifest.version + ".");
	process.exit(1);
}
' "$staged_manifest" "$staged_file" "$staged_expected_name" "$staged_version" "$staged_channel_manifest" < /dev/null

		node -e '
const fs = require("fs");
const [manifestPath, prefix] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const field of ["dependencies", "optionalDependencies"]) {
	for (const [name, spec] of Object.entries(manifest[field] || {})) {
		if (typeof spec === "string" && spec.startsWith(prefix)) console.log(name + " " + spec.slice(prefix.length));
	}
}
' "$staged_manifest" "$staged_prefix" > "$staged_root/deps/$staged_file" < /dev/null

		while read -r staged_package staged_dep; do
			[ -n "$staged_package" ] || continue
			# The name becomes a URL and a path below. It comes out of a
			# manifest already checked against its own digest, so this is not
			# load-bearing; it costs nothing and keeps it from becoming so.
			case "$staged_dep" in
				"" | */* | *..*)
					printf 'error: %s names an unusable release file: %s\n' "$staged_package" "$staged_dep" >&2
					exit 1
					;;
			esac
			# Recorded on sight rather than after staging: more than one
			# package depends on the AI package, and a list of staged ones
			# would fetch and verify it once per dependent.
			if grep -qxF "$staged_dep" "$staged_root/seen"; then
				continue
			fi
			printf '%s\n' "$staged_dep" >> "$staged_root/seen"
			printf '%s\n' "$staged_dep" >> "$staged_root/queue"

			wasmedge_agent_run_quiet_with_animation \
				"Downloading WasmEdge Agent" \
				"Downloading WasmEdge Agent v$staged_version" \
				"Fetching $staged_package." \
				curl -fsSL "$staged_prefix$staged_dep" -o "$staged_dir/$staged_dep"

			verify_wasmedge_agent_package_checksum "$staged_checksums" "$staged_dir/$staged_dep"
		done < "$staged_root/deps/$staged_file"
	done

	if [ ! -s "$staged_root/deps/$staged_name" ]; then
		# Every dependency comes from the registry, which verifies its own.
		# The downloaded tarball installs as it is.
		return 0
	fi

	# Each package's final location is decided before any manifest is written:
	# the graph has no order that makes a package's repacked path exist before
	# a dependent has to name it, and npm reads these paths at install time,
	# when all of them are on disk.
	mkdir -p "$staged_root/repacked"
	while read -r staged_file; do
		[ -s "$staged_root/deps/$staged_file" ] || continue
		staged_manifest="$staged_root/pkg/$staged_file/package/package.json"
		while read -r staged_package staged_dep; do
			[ -n "$staged_package" ] || continue
			node -e '
const fs = require("fs");
const [manifestPath, name, filePath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const field of ["dependencies", "optionalDependencies"]) {
	if (manifest[field] && typeof manifest[field][name] === "string") manifest[field][name] = "file:" + filePath;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
' "$staged_manifest" "$staged_package" "$(staged_release_install_path "$staged_dep")" < /dev/null
		done < "$staged_root/deps/$staged_file"
		(cd "$staged_root/pkg/$staged_file" && tar -czf "$staged_root/repacked/$staged_file" package)
	done < "$staged_root/processed"

	wasmedge_agent_install_tarball="$staged_root/repacked/$staged_name"
}

# Where a release package will be once staging is done: its repacked copy when
# it carries dependencies on this release, and the verified download otherwise.
staged_release_install_path() {
	if [ -s "$staged_root/deps/$1" ]; then
		printf '%s\n' "$staged_root/repacked/$1"
	else
		printf '%s\n' "$staged_dir/$1"
	fi
}

wasmedge_agent_run_checksum_check() {
	checksum_dir="$1"
	selected_checksums_name="$2"
	checker="$3"
	case "$checker" in
		sha256sum)
			(cd "$checksum_dir" && sha256sum -c "$selected_checksums_name")
			;;
		shasum)
			(cd "$checksum_dir" && shasum -a 256 -c "$selected_checksums_name")
			;;
	esac
}

confirm_install() {
	version="$1"
	tarball_url="$2"

	if wasmedge_agent_prompt_yes_no \
		"Install WasmEdge Agent v$version globally with npm?" \
		"Downloads the verified release and runs npm install -g." \
		"Install? [Y/n]"; then
		return 0
	else
		prompt_status=$?
	fi

	if [ "$prompt_status" -eq 2 ]; then
		printf 'This will download, verify, and install:\n\n  %s\n\n' "$tarball_url"
		printf 'No terminal detected; continuing without confirmation.\n'
		return 0
	fi

	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "Installation cancelled" "" "No changes were made." ""
		exit 0
	fi
	printf '\nInstallation cancelled.\n'
	exit 0
}

confirm_cell_runtime_setup() {
	case "${WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL:-}" in
		1)
			wasmedge_agent_bootstrap_runtime_on_install=1
			return
			;;
		0)
			wasmedge_agent_bootstrap_runtime_on_install=0
			return
			;;
	esac

	if wasmedge_agent_prompt_yes_no \
		"Prepare the Rust cell runtime now?" \
		"Checks rustup + wasm32-wasip1 and WasmEdge, then prebuilds the cell workspace." \
		"Prepare? [Y/n]"; then
		wasmedge_agent_bootstrap_runtime_on_install=1
		return
	else
		prompt_status=$?
	fi

	if [ "$prompt_status" -eq 2 ]; then
		printf 'No terminal detected; preparing the Rust cell runtime during install.\n'
		wasmedge_agent_bootstrap_runtime_on_install=1
		return
	fi

	wasmedge_agent_bootstrap_runtime_on_install=0
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "Cell runtime setup skipped" "" "The runtime can be prepared on first rust cell use." ""
		sleep 0.4
	else
		printf '\nSkipping Rust cell runtime setup.\n'
	fi
}

skip_cell_runtime_setup() {
	wasmedge_agent_bootstrap_runtime_on_install=0
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_screen "Cell runtime setup skipped" "" "$1" ""
		sleep 0.4
	else
		printf '\n%s\n' "$1"
	fi
}

# DESIGN.md section 10: the installer checks/guides rustup + the
# wasm32-wasip1 target and WasmEdge before npm install, so postinstall's
# template prebuild (vendor + warm) can succeed.
prepare_rust_toolchain() {
	[ "$wasmedge_agent_bootstrap_runtime_on_install" = 1 ] || return 0
	# Called plainly, so `set -e` applies. These used to run as
	# `ensure_... || return 0`, which turned every nonzero result into
	# success and, because a function on the left of || runs with errexit
	# suppressed, also stopped the commands inside them from failing the
	# install. A rustup or WasmEdge installer that did not finish left an
	# install that reported success with no toolchain and no runtime.
	#
	# Declining a component is not a failure: those paths report what to run
	# by hand through skip_cell_runtime_setup and return 0, so the agent still
	# installs.
	ensure_rustup_and_target
	ensure_wasmedge
}

ensure_rustup_and_target() {
	if [ -x "$HOME/.cargo/bin/rustup" ] || command -v rustup >/dev/null 2>&1; then
		PATH="$HOME/.cargo/bin:$PATH"
		export PATH
		# Stable by name, and not whatever this host happens to have active.
		# `rustup target` without --toolchain reads and writes the default one,
		# so a host defaulting to nightly was asked whether nightly had the
		# target, said yes, and finished the install issue #3 defines as
		# installing the stable toolchain without a stable toolchain on it.
		#
		# The default is left alone. Which toolchain a host builds with is its
		# own choice; what this owes issue #3 is that stable is there and can
		# build a cell.
		if ! rustup toolchain list 2>/dev/null | grep -q '^stable'; then
			if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
				wasmedge_agent_run_quiet_with_animation_steps \
					"Installing the Rust stable toolchain" \
					"Installing the Rust stable toolchain" \
					"Running rustup toolchain install stable." \
					rustup toolchain install --no-self-update stable
			else
				printf '\nInstalling the Rust stable toolchain...\n'
				rustup toolchain install --no-self-update stable
			fi
		fi
		if rustup target list --installed --toolchain stable 2>/dev/null | grep -q '^wasm32-wasip1$'; then
			return 0
		fi
		if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
			wasmedge_agent_run_quiet_with_animation_steps \
				"Adding the wasm32-wasip1 target" \
				"Adding the wasm32-wasip1 target" \
				"Running rustup target add --toolchain stable wasm32-wasip1." \
				rustup target add --toolchain stable wasm32-wasip1
		else
			printf '\nAdding the wasm32-wasip1 target...\n'
			rustup target add --toolchain stable wasm32-wasip1
		fi
		return 0
	fi

	if wasmedge_agent_prompt_yes_no \
		"Install Rust with rustup?" \
		"Runs the official rustup installer (stable toolchain + wasm32-wasip1)." \
		"Install? [Y/n]"; then
		:
	else
		prompt_status=$?
		if [ "$prompt_status" -ne 2 ]; then
			skip_cell_runtime_setup "Install rustup (rustup.rs), then run: rustup target add wasm32-wasip1"
			return 0
		fi
		printf 'No terminal detected; installing Rust with rustup.\n'
	fi

	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing Rust" \
			"Installing Rust" \
			"Downloading rustup.
Installing the stable toolchain.
Adding the wasm32-wasip1 target." \
			run_rustup_install
	else
		printf '\nInstalling Rust with rustup...\n\n'
		run_rustup_install
	fi
	PATH="$HOME/.cargo/bin:$PATH"
	export PATH
	hash -r
}

# Downloaded, then run. `curl ... | sh` reports the shell's status and not
# curl's, and POSIX sh has no pipefail to lean on, so a download that ended
# early -- a truncated script, a proxy error page -- ran as far as it parsed
# and reported success.
run_rustup_install() {
	rustup_dir=$(create_temp_dir)
	rustup_status=0
	if ! curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$rustup_dir/rustup-init.sh"; then
		printf 'error: could not download the rustup installer.\n' >&2
		rustup_status=1
	elif ! sh "$rustup_dir/rustup-init.sh" -y --no-modify-path --default-toolchain stable --target wasm32-wasip1; then
		printf 'error: the rustup installer did not finish.\n' >&2
		rustup_status=1
	fi
	rm -rf "$rustup_dir"
	return "$rustup_status"
}

ensure_wasmedge() {
	if wasmedge_usable_bin >/dev/null; then
		return 0
	fi

	if wasmedge_agent_prompt_yes_no \
		"Install WasmEdge?" \
		"Uses the wasmedge-bin package where it is available, otherwise the official install script." \
		"Install? [Y/n]"; then
		:
	else
		prompt_status=$?
		if [ "$prompt_status" -ne 2 ]; then
			skip_cell_runtime_setup "Install WasmEdge (wasmedge.org), then run any rust cell to finish setup."
			return 0
		fi
		printf 'No terminal detected; installing WasmEdge.\n'
	fi

	# The order issue #1 fixed: the package first, the official installer as
	# the fallback.
	if install_wasmedge_bin_package; then
		return 0
	fi

	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing WasmEdge" \
			"Installing WasmEdge" \
			"Downloading the WasmEdge install script.
Installing to ~/.wasmedge." \
			run_wasmedge_install
	else
		printf '\nInstalling WasmEdge...\n\n'
		run_wasmedge_install
	fi
}

# Installs the wasmedge-bin package, and says whether it managed to.
#
# The package lives in the AUR, so it takes a helper: pacman alone cannot see
# it. A host with no helper is every host that is not Arch, and it falls
# straight through to the official installer that has always run here -- which
# is also what a helper that fails does, because the fallback exists for
# exactly that.
install_wasmedge_bin_package() {
	wasmedge_helper=
	for wasmedge_candidate in yay paru; do
		if command -v "$wasmedge_candidate" >/dev/null 2>&1; then
			wasmedge_helper="$wasmedge_candidate"
			break
		fi
	done
	if [ -z "$wasmedge_helper" ]; then
		return 1
	fi

	wasmedge_bin_status=0
	if [ "$wasmedge_agent_screen_enabled" = 1 ]; then
		# Same shape as the Node.js package installs: authorize sudo on a real
		# terminal first, because the helper's own prompt would be invisible
		# behind the animation and would simply hang.
		wasmedge_agent_screen "Preparing the WasmEdge install" "" "This may ask for your sudo password." ""
		wasmedge_agent_restore_terminal
		printf '\n'
		sudo -v || true
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing WasmEdge" \
			"Installing WasmEdge" \
			"Installing the wasmedge-bin package with $wasmedge_helper." \
			"$wasmedge_helper" -S --needed --noconfirm wasmedge-bin || wasmedge_bin_status=$?
	else
		printf '\nInstalling WasmEdge with %s...\n\n' "$wasmedge_helper"
		"$wasmedge_helper" -S --needed --noconfirm wasmedge-bin || wasmedge_bin_status=$?
	fi

	if [ "$wasmedge_bin_status" -ne 0 ]; then
		printf 'Warning: %s could not install wasmedge-bin; using the official WasmEdge installer.\n' \
			"$wasmedge_helper" >&2
		return 1
	fi

	hash -r

	# A helper can exit zero and leave nothing that runs: a package that built
	# but did not install, a mirror that served an empty payload, a --noconfirm
	# that skipped the one thing asked for. Issue #1 made the official installer
	# the fallback, and saying "managed it" here is exactly what skips it.
	if ! wasmedge_usable_bin >/dev/null; then
		printf 'Warning: %s reported success and no WasmEdge runs; using the official WasmEdge installer.\n' \
			"$wasmedge_helper" >&2
		return 1
	fi
	return 0
}

# Downloaded, then run, for the reason run_rustup_install is.
run_wasmedge_install() {
	wasmedge_dir=$(create_temp_dir)
	wasmedge_status=0
	if ! curl -fsSL https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install_v2.sh \
		-o "$wasmedge_dir/install_v2.sh"; then
		printf 'error: could not download the WasmEdge installer.\n' >&2
		wasmedge_status=1
	elif ! bash "$wasmedge_dir/install_v2.sh"; then
		printf 'error: the WasmEdge installer did not finish.\n' >&2
		wasmedge_status=1
	fi
	rm -rf "$wasmedge_dir"
	return "$wasmedge_status"
}

install_wasmedge_agent_package() {
	tarball_path="$1"
	if [ "$wasmedge_agent_bootstrap_runtime_on_install" = 1 ]; then
		npm_install_details="Preparing global install.
Linking command binaries.
Installing runtime packages.
Preloading search tools.
Prebuilding the cell workspace template.
Finalizing npm install."
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing WasmEdge Agent" \
			"Installing WasmEdge Agent" \
			"$npm_install_details" \
			env WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL=1 npm install -g --no-fund --no-audit --loglevel=error --progress=false "$tarball_path"
	else
		npm_install_details="Preparing global install.
Linking command binaries.
Installing runtime packages.
Preloading search tools.
Finalizing npm install."
		wasmedge_agent_run_quiet_with_animation_steps \
			"Installing WasmEdge Agent" \
			"Installing WasmEdge Agent" \
			"$npm_install_details" \
			env WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 npm install -g --no-fund --no-audit --loglevel=error --progress=false "$tarball_path"
	fi
}

main "$@"

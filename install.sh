#!/bin/sh

set -eu

# Emit one deprecation line during the one-release compatibility window
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
# The release this copy was rendered for. The workflow substitutes it when it
# renders a channel's installer; nothing reads it back -- it is provenance,
# not a mechanism. An unrendered copy keeps the placeholder, which is not a
# version.
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


native_fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

native_platform() {
    case "$(uname -s):$(uname -m)" in
        Linux:x86_64) echo linux-x64 ;;
        Linux:aarch64|Linux:arm64) echo linux-arm64 ;;
        Darwin:x86_64) echo darwin-x64 ;;
        Darwin:arm64) echo darwin-arm64 ;;
        MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) echo win32-x64 ;;
        *) native_fail "no native release for $(uname -s) $(uname -m)" ;;
    esac
}

check_archive() {
    tar -tzf "$1" > "$work/paths" || native_fail "unreadable release archive"
    awk '/^\// || /\\/ || /(^|\/)\.\.(\/|$)/ || /[[:cntrl:]]/ || /:/ {exit 1}' "$work/paths" || native_fail "unsafe archive path"
    tar -tvzf "$1" > "$work/types" || native_fail "unreadable archive headers"
    awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' "$work/types" || native_fail "unsupported archive entry"
    mkdir "$work/payload"
    tar -xzf "$1" -C "$work/payload"
    for item in "$exe" version.json LICENSE README.md catalog/models.bundled.json skills/websearch/SKILL.md wasmedge-agent-runtime/template/Cargo.lock; do
        [ -f "$work/payload/$item" ] || native_fail "release is missing $item"
    done
    [ -d "$work/payload/wasmedge-agent-runtime/template/vendor" ] || native_fail "release is missing offline cell dependencies"
    package_root=$work/payload
    if [ "$platform" = win32-x64 ]; then package_root=$(cygpath -aw "$package_root"); fi
    observed=$(PI_PACKAGE_DIR="$package_root" "$work/payload/$exe" --version)
    [ "$observed" = "$version" ] || native_fail "the archive names $version but its payload reports $observed"
}
main() {
    archive= rollback=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --check) wasmedge_agent_check_only=1 ;;
            --now|--yes|-y) wasmedge_agent_assume_yes=1 ;;
            --archive) shift; [ "$#" -gt 0 ] || native_fail "--archive requires a file"; archive=$1 ;;
            --rollback) rollback=1 ;;
            --help|-h) printf 'Usage: install.sh [VERSION] [--yes] [--check | --archive FILE | --rollback]\n'; return ;;
            -*) native_fail "unknown option $1" ;;
            *) [ -z "$wasmedge_agent_requested_version" ] || native_fail "unexpected argument $1"; wasmedge_agent_requested_version=$1 ;;
        esac
        shift
    done
    prefix=${WASMEDGE_AGENT_RUST_PREFIX:-"$HOME/.local"}
    if command -v cygpath >/dev/null 2>&1; then prefix=$(cygpath -au "$prefix"); fi
    case "$prefix" in /*) ;; *) native_fail "installation prefix must be absolute";; esac
    case "$wasmedge_agent_release_channel" in stable|beta) ;; *) native_fail "unknown release channel";; esac
    case "$wasmedge_agent_cmd" in ''|*[!a-zA-Z0-9_-]*) native_fail "invalid launcher name";; esac
    exe=wasmedge-agent
    platform=$(native_platform)
    [ "$platform" != win32-x64 ] || exe=wasmedge-agent.exe
    share="$prefix/share"; live="$share/wasmedge-agent"; previous="$share/wasmedge-agent.old"
    if [ "$wasmedge_agent_check_only" = 1 ]; then
        [ -x "$live/$exe" ] || native_fail "no native installation under $prefix"
        "$live/$exe" doctor
        "$live/$exe" --wasmedge-agent-runtime-check
        return
    fi
    [ -z "$archive" ] || [ "$rollback" = 0 ] || native_fail "choose one of --archive and --rollback"
    wasmedge_agent_install_traps
    wasmedge_agent_init_screen
    mkdir -p "$share" "$prefix/bin"
    for owned in "$live" "$previous"; do
        if [ -e "$owned" ] || [ -L "$owned" ]; then
            [ ! -L "$owned" ] && [ -f "$owned/.wasmedge-agent-install" ] || native_fail "unmanaged installation at $owned"
        fi
    done
    work=$(mktemp -d "$share/.wasmedge-install.XXXXXXXX")
    wasmedge_agent_download_dir=$work
    if [ "$rollback" = 1 ]; then
        [ -x "$previous/$exe" ] || native_fail "nothing to roll back"
        if [ "${WASMEDGE_AGENT_ROLLBACK_CHECK:-0}" = 1 ]; then printf '%s\n' "$previous"; return 0; fi
    else
        if [ -n "$archive" ]; then
            name=${archive##*/}; version=${name#wasmedge-agent-}; version=${version%-$platform.tar.gz}
            version=$(normalize_version "$version")
            [ "$name" = "wasmedge-agent-$version-$platform.tar.gz" ] || native_fail "wrong archive for $platform"
            bundle=$archive
        else
            [ "$wasmedge_agent_base_url" != "$wasmedge_agent_unconfigured_base_url" ] || native_fail "set WASMEDGE_AGENT_DOWNLOAD_BASE_URL or use the published installer"
            version=${wasmedge_agent_requested_version:-${WASMEDGE_AGENT_VERSION:-${PRIME_AGENT_VERSION:-}}}
            if [ -z "$version" ]; then
                version=$(curl -fsSL "$(wasmedge_agent_channel_url "$wasmedge_agent_release_channel" "$wasmedge_agent_release_channel")")
            fi
            version=$(normalize_version "$version"); name="wasmedge-agent-$version-$platform.tar.gz"; bundle="$work/$name"
            curl -fsSL "$(wasmedge_agent_release_asset_url "$version" SHA256SUMS)" -o "$work/sums"
            curl -fsSL "$(wasmedge_agent_release_asset_url "$version" "$name")" -o "$bundle"
            awk -v name="$name" '$2==name && length($1)==64 && $1 !~ /[^[:xdigit:]]/ {print $1 "  " name; n++} END {if(n!=1)exit 1}' "$work/sums" > "$work/check" || native_fail "missing or duplicate archive checksum"
            (cd "$work"; if command -v sha256sum >/dev/null; then sha256sum -c check; else shasum -a 256 -c check; fi)
        fi
        check_archive "$bundle"
        [ "${WASMEDGE_AGENT_ARCHIVE_CHECK:-0}" != 1 ] || return 0
        confirm_cell_runtime_setup
        prepare_rust_toolchain
        if [ "$wasmedge_agent_bootstrap_runtime_on_install" = 1 ]; then
            PI_PACKAGE_DIR="$package_root" "$work/payload/$exe" --wasmedge-agent-bootstrap || native_fail "could not prepare the WASI runtime"
        fi
        printf 'install-rust.sh channel %s\nversion %s\n' "$wasmedge_agent_release_channel" "$version" > "$work/payload/.wasmedge-agent-install"
    fi
    # Serialise the short activation step. Keep the last good installation
    # available if a rename on this filesystem or a launcher update fails.
    lock="$share/.wasmedge-activate.lock"
    mkdir "$lock" || native_fail "another installation is active"
    native_lock=$lock
    launcher="$prefix/bin/$wasmedge_agent_cmd"
    if [ "$platform" = win32-x64 ]; then
        launcher="$launcher.cmd"
        printf '@echo off\r\n"%%~dp0..\\share\\wasmedge-agent\\wasmedge-agent.exe" %%*\r\n' > "$work/launcher"
    else
        ln -s "../share/wasmedge-agent/$exe" "$work/launcher"
    fi
    if [ -e "$launcher" ] || [ -L "$launcher" ]; then
        if [ -L "$launcher" ]; then
            case "$(readlink "$launcher")" in
                "../share/wasmedge-agent/$exe"|"../lib/node_modules/wasmedge-agent/dist/native-launch.js"|"../lib/node_modules/wasmedge-agent/dist/cli.js") ;;
                *) native_fail "existing launcher is not managed by this installer: $launcher" ;;
            esac
        elif [ "$platform" != win32-x64 ] || ! cmp -s "$work/launcher" "$launcher"; then
            native_fail "existing launcher is not managed by this installer: $launcher"
        fi
    fi
    if [ "$rollback" = 1 ]; then
        mv "$previous" "$work/payload"
    elif [ -d "$previous" ]; then
        mv "$previous" "$work/older"
    fi
    if [ -d "$live" ]; then mv "$live" "$previous"; fi
    if ! mv "$work/payload" "$live"; then
        if [ -d "$previous" ]; then mv "$previous" "$live"; fi
        if [ "$rollback" = 1 ]; then mv "$work/payload" "$previous"; elif [ -d "$work/older" ]; then mv "$work/older" "$previous"; fi
        native_fail "could not activate release"
    fi
    if ! mv -f "$work/launcher" "$launcher"; then
        mv "$live" "$work/payload"
        if [ -d "$previous" ]; then mv "$previous" "$live"; fi
        if [ "$rollback" = 1 ]; then mv "$work/payload" "$previous"; elif [ -d "$work/older" ]; then mv "$work/older" "$previous"; fi
        native_fail "could not activate the launcher"
    fi
    alias_path="$prefix/bin/prime-agent"
    if [ "$platform" = win32-x64 ]; then alias_path="$alias_path.cmd"; fi
    if [ ! -e "$alias_path" ] && [ ! -L "$alias_path" ]; then
        if [ "$platform" = win32-x64 ]; then cp "$launcher" "$alias_path"; else ln -s "../share/wasmedge-agent/$exe" "$alias_path"; fi
    fi
    printf 'Installed %s at %s\n' "$("$live/$exe" --version)" "$launcher"
    case ":${PATH:-}:" in *":$prefix/bin:"*) ;; *) printf 'Add %s to PATH to run %s.\n' "$prefix/bin" "$wasmedge_agent_cmd";; esac
}

native_lock=
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
# The animated commands are toolchain installations and vendor
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
	if [ -n "$native_lock" ]; then rmdir "$native_lock" || true; fi
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
		logo_start=$(((wasmedge_agent_lab_width - 28) / 2))
		logo_end=$((logo_start + 28))
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
	# The mark draws in one row per screen draw, so it is whole about two
	# seconds into the install, and it is whole at once on a screen that
	# waits for an answer. A row not yet drawn is its width of spaces, so
	# the band it will fill is already quiet.
	if [ -z "$wasmedge_agent_screen_question" ] && [ "$1" -ge "${wasmedge_agent_screen_frame:-0}" ]; then
		printf '%28s' ''
		return
	fi
	case "$1" in
		0) printf '%s' '            ▄██▄            ' ;;
		1) printf '%s' '            █  █            ' ;;
		2) printf '%s' '            ▄██▄            ' ;;
		3) printf '%s' '         ▄█▀ ██ ▀█▄         ' ;;
		4) printf '%s' '      ▄▄▀    ▀▀    ▀▄▄      ' ;;
		5) printf '%s' '█▀▀█▄▀▀    ▄█▀▀█▄▄   ▀▀▄█▀▀█' ;;
		6) printf '%s' '█▄▄███▄ ▄▄█▀      █▄ ▄███▄▄█' ;;
		7) printf '%s' '    █  █           ▀█  █    ' ;;
		8) printf '%s' '    ▀▄ ▀▄▄        ▄▄▀ ▄▀    ' ;;
		9) printf '%s' '     █   ▀▀▀▀▀▀▀▀▀▀   █     ' ;;
		10) printf '%s' '      █  ▄▀      ▀▄  █      ' ;;
		11) printf '%s' '      █▄█▀        ▀█▄█      ' ;;
		12) printf '%s' '    ▄▀▀▀█▀▀▀▀▀▀▀▀▀▀█▀▀▀▄    ' ;;
		13) printf '%s' '    ▀▄▄█▀          ▀█▄▄▀    ' ;;
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

# DESIGN.md section 10: the installer prepares rustup, the
# wasm32-wasip1 target and WasmEdge before the installer's
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
		# Authorize sudo on a real
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


main "$@"

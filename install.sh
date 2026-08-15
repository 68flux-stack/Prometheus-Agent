#!/bin/sh

set -eu

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
prometheus_unconfigured_base_url="__PROMETHEUS_DOWNLOAD_BASE""_URL__"
prometheus_unconfigured_default_release_channel="__PROMETHEUS_DEFAULT_RELEASE_""CHANNEL__"
prometheus_base_url="${PROMETHEUS_DOWNLOAD_BASE_URL:-__PROMETHEUS_DOWNLOAD_BASE_URL__}"
prometheus_base_url="${prometheus_base_url%/}"
prometheus_default_release_channel="__PROMETHEUS_DEFAULT_RELEASE_CHANNEL__"
if [ "$prometheus_default_release_channel" = "$prometheus_unconfigured_default_release_channel" ]; then
	prometheus_default_release_channel=stable
fi
prometheus_release_channel="${PROMETHEUS_RELEASE_CHANNEL:-$prometheus_default_release_channel}"
prometheus_package="${PROMETHEUS_PACKAGE:-prometheus}"
prometheus_cmd="${PROMETHEUS_CMD:-prometheus}"
prometheus_esc=$(printf '\033')
prometheus_original_path="${PATH:-}"
prometheus_reset="${prometheus_esc}[0m"
prometheus_bold="${prometheus_esc}[1m"
prometheus_italic="${prometheus_esc}[3m"
prometheus_hide_cursor="${prometheus_esc}[?25l"
prometheus_show_cursor="${prometheus_esc}[?25h"
prometheus_home_cursor="${prometheus_esc}[H"
prometheus_clear_screen="${prometheus_esc}[2J${prometheus_esc}[H"
prometheus_clear_line="${prometheus_esc}[K"
prometheus_sync_start="${prometheus_esc}[?2026h"
prometheus_sync_end="${prometheus_esc}[?2026l"
prometheus_color_text="${prometheus_esc}[38;2;244;244;245m"
prometheus_color_muted="${prometheus_esc}[38;2;161;161;170m"
prometheus_color_dim="${prometheus_esc}[38;2;113;113;122m"
prometheus_color_primary="${prometheus_esc}[38;2;127;91;213m"
prometheus_color_scan="${prometheus_esc}[38;2;14;165;233m"
prometheus_color_warning="${prometheus_esc}[38;2;245;158;11m"
readonly prometheus_unconfigured_base_url prometheus_unconfigured_default_release_channel prometheus_base_url prometheus_default_release_channel prometheus_release_channel prometheus_package prometheus_cmd prometheus_esc prometheus_original_path
readonly prometheus_reset prometheus_bold prometheus_italic prometheus_hide_cursor prometheus_show_cursor prometheus_home_cursor prometheus_clear_screen prometheus_clear_line
readonly prometheus_sync_start prometheus_sync_end
readonly prometheus_color_text prometheus_color_muted prometheus_color_dim prometheus_color_primary prometheus_color_scan prometheus_color_warning

prometheus_screen_enabled=0
prometheus_screen_frame=0
prometheus_screen_cols=80
prometheus_screen_rows=24
prometheus_screen_drawn=0
prometheus_screen_last_cols=0
prometheus_screen_last_rows=0
prometheus_screen_layout_ready=0
prometheus_screen_layout_show_logo=0
prometheus_screen_layout_lab_width=0
prometheus_screen_render_lab_width=0
prometheus_screen_compact=0
prometheus_download_dir=
prometheus_bootstrap_kernel_on_install=0
prometheus_screen_title=
prometheus_screen_status=
prometheus_screen_detail=
prometheus_screen_question=
prometheus_animation_frame=0

main() {
	if [ "$prometheus_base_url" = "$prometheus_unconfigured_base_url" ]; then
		printf 'error: installer download URL is not configured.\n' >&2
		printf 'Set PROMETHEUS_DOWNLOAD_BASE_URL or use the installer published by the release workflow.\n' >&2
		exit 1
	fi

	prometheus_install_traps
	prometheus_init_screen
	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "Installing Prometheus" "" "" ""
	else
		printf '\n\033[1m  Installing Prometheus\033[0m\n\033[2m  npm global install\033[0m\n\n'
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

	version="$(resolve_prometheus_version "$@")"
	tarball_name="$prometheus_package-$version.tgz"
	tarball_url="$prometheus_base_url/releases/v$version/$tarball_name"

	confirm_install "$version" "$tarball_url"
	confirm_kernel_runtime_setup

	download_dir=$(create_temp_dir)
	prometheus_download_dir="$download_dir"
	tarball_path="$download_dir/$tarball_name"

	download_prometheus_package "$version" "$tarball_url" "$tarball_path"
	install_prometheus_package "$tarball_path"
	rm -rf "$download_dir"
	prometheus_download_dir=

	if [ "${PROMETHEUS_NODE_INSTALLED_STANDALONE:-0}" = 1 ]; then
		prometheus_screen "Prometheus installed" "" "Checking your shell PATH." ""
		configure_standalone_node_path
	elif command -v "$prometheus_cmd" >/dev/null 2>&1; then
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_screen "Prometheus installed" "" "Run it with: $prometheus_cmd" ""
		else
			printf '\nPrometheus was installed successfully.\n'
			printf '\nRun it with: %s\n' "$prometheus_cmd"
		fi
	else
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_screen "Prometheus installed" "" "PATH update needed for $prometheus_cmd." ""
			prometheus_restore_terminal
		else
			printf '\nPrometheus was installed successfully.\n'
		fi
		cat <<EOF
The $prometheus_cmd command was installed, but it is not on your PATH yet.
Check npm's global bin directory with:

  npm bin -g

Then add that directory to your shell PATH.
EOF
	fi
}

create_temp_dir() {
	if command -v mktemp >/dev/null 2>&1; then
		if tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prometheus-install.XXXXXX" 2>/dev/null); then
			printf '%s' "$tmp_dir"
			return
		fi
	fi

	printf 'error: mktemp is required to create a secure temporary directory.\n' >&2
	exit 1
}

prometheus_install_traps() {
	trap 'prometheus_cleanup' EXIT
	trap 'prometheus_signal_cleanup 130' INT
	trap 'prometheus_signal_cleanup 143' TERM
}

prometheus_cleanup() {
	status=$?
	if [ -n "${prometheus_download_dir:-}" ] && [ -d "$prometheus_download_dir" ]; then
		rm -rf "$prometheus_download_dir"
	fi
	prometheus_restore_terminal
	return "$status"
}

prometheus_signal_cleanup() {
	prometheus_restore_terminal
	exit "$1"
}

prometheus_restore_terminal() {
	if [ "${prometheus_screen_enabled:-0}" = 1 ]; then
		if ( : <>/dev/tty ) 2>/dev/null; then
			printf '%s%s' "$prometheus_reset" "$prometheus_show_cursor" >/dev/tty
		else
			printf '%s%s' "$prometheus_reset" "$prometheus_show_cursor" >&2
		fi
	fi
}

prometheus_init_screen() {
	if [ "${PROMETHEUS_INSTALLER_PLAIN:-0}" = 1 ]; then
		return
	fi
	if [ ! -t 1 ]; then
		return
	fi
	if [ "${TERM:-}" = dumb ]; then
		return
	fi
	prometheus_screen_enabled=1
}

prometheus_read_terminal_size() {
	prometheus_screen_cols=80
	prometheus_screen_rows=24

	if size=$(stty size 2>/dev/null </dev/tty); then
		set -- $size
		if [ "${1:-}" ] && [ "${2:-}" ]; then
			case "$1" in *[!0-9]*|"") ;; *) prometheus_screen_rows="$1" ;; esac
			case "$2" in *[!0-9]*|"") ;; *) prometheus_screen_cols="$2" ;; esac
		fi
	fi

	if [ "$prometheus_screen_cols" -lt 1 ]; then
		prometheus_screen_cols=80
	fi
	if [ "$prometheus_screen_rows" -lt 1 ]; then
		prometheus_screen_rows=24
	fi
}

prometheus_screen() {
	if [ "$prometheus_screen_enabled" != 1 ]; then
		return
	fi

	prometheus_screen_title="${2:-$1}"
	if [ -z "$prometheus_screen_title" ]; then
		prometheus_screen_title="$1"
	fi
	prometheus_screen_status=
	prometheus_screen_detail="${3:-}"
	prometheus_screen_question="${4:-}"
	prometheus_screen_frame=$((prometheus_screen_frame + 1))
	prometheus_read_terminal_size
	prometheus_init_screen_layout
	prometheus_refresh_screen_layout_mode

	if [ "$prometheus_screen_drawn" = 0 ] ||
		[ "$prometheus_screen_cols" -ne "$prometheus_screen_last_cols" ] ||
		[ "$prometheus_screen_rows" -ne "$prometheus_screen_last_rows" ]; then
		prometheus_screen_prefix="${prometheus_reset}${prometheus_clear_screen}${prometheus_hide_cursor}"
		prometheus_screen_drawn=1
		prometheus_screen_last_cols="$prometheus_screen_cols"
		prometheus_screen_last_rows="$prometheus_screen_rows"
	else
		prometheus_screen_prefix="${prometheus_reset}${prometheus_home_cursor}${prometheus_hide_cursor}"
	fi
	prometheus_screen_frame_text=$(prometheus_render_screen)

	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s%s' "$prometheus_sync_start" "$prometheus_screen_prefix" "$prometheus_screen_frame_text" "$prometheus_sync_end" >/dev/tty
	else
		printf '%s%s%s%s' "$prometheus_sync_start" "$prometheus_screen_prefix" "$prometheus_screen_frame_text" "$prometheus_sync_end" >&2
	fi
}

prometheus_init_screen_layout() {
	if [ "$prometheus_screen_layout_ready" = 1 ]; then
		return
	fi

	prometheus_screen_layout_ready=1
	prometheus_screen_layout_show_logo=0
	prometheus_screen_layout_lab_width=0
	prometheus_screen_render_lab_width=0
	if prometheus_terminal_size_supports_logo; then
		prometheus_screen_layout_show_logo=1
		prometheus_screen_layout_lab_width=$(prometheus_lab_width_for_cols "$prometheus_screen_cols")
	fi
}

prometheus_refresh_screen_layout_mode() {
	prometheus_screen_compact=0
	prometheus_screen_render_lab_width=0
	if [ "$prometheus_screen_layout_show_logo" != 1 ]; then
		return
	fi
	if [ "$prometheus_screen_rows" -lt 17 ]; then
		prometheus_screen_compact=1
		return
	fi

	max_safe_width=$((prometheus_screen_cols - 1))
	if [ "$max_safe_width" -lt 32 ]; then
		prometheus_screen_compact=1
		return
	fi

	prometheus_screen_render_lab_width="$prometheus_screen_layout_lab_width"
	if [ "$prometheus_screen_render_lab_width" -gt "$max_safe_width" ]; then
		prometheus_screen_render_lab_width="$max_safe_width"
	fi
}

prometheus_terminal_size_supports_logo() {
	[ "$prometheus_screen_rows" -ge 22 ] && [ "$prometheus_screen_cols" -ge 42 ]
}

prometheus_lab_width_for_cols() {
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

prometheus_render_screen() {
	content_height=$(prometheus_content_height)
	top=$(((prometheus_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi

	y=0
	while [ "$y" -lt "$prometheus_screen_rows" ]; do
		content_index=$((y - top))
		prometheus_content_line "$content_index"
		if [ "${prometheus_content_is_set:-0}" = 1 ]; then
			prometheus_print_centered_line "$prometheus_content_text" "$prometheus_content_width" "$prometheus_content_style"
		else
			prometheus_print_centered_line "" 0 ""
		fi
		y=$((y + 1))
	done
}

prometheus_content_height() {
	height=2
	if prometheus_show_logo; then
		height=$((height + 15))
	fi
	printf '%s' "$height"
}

prometheus_show_logo() {
	[ "$prometheus_screen_layout_show_logo" = 1 ] && [ "$prometheus_screen_compact" != 1 ] && [ "$prometheus_screen_render_lab_width" -ge 32 ]
}

prometheus_content_line() {
	index="$1"
	prometheus_content_is_set=0
	prometheus_content_text=
	prometheus_content_width=0
	prometheus_content_style=

	if prometheus_show_logo; then
		case "$index" in
			0|1|2|3|4|5|6|7|8|9|10|11|12|13) prometheus_set_lab_line "$index" ;;
			14) prometheus_set_blank_line ;;
		esac
		if [ "$prometheus_content_is_set" = 1 ]; then
			return
		fi
		index=$((index - 15))
	fi

	if [ "$index" -lt 0 ]; then
		return
	fi

	if [ "$index" -eq 0 ]; then
		if [ -n "$prometheus_screen_question" ]; then
			prometheus_set_text_line "$(prometheus_screen_primary_text)" "$prometheus_bold$prometheus_color_text"
		else
			prometheus_set_title_line "$prometheus_screen_title"
		fi
		return
	fi

	if [ "$index" -eq 1 ]; then
		if [ -n "$prometheus_screen_question" ]; then
			prometheus_set_text_line "Press Enter to continue; type n to cancel." "$prometheus_color_muted"
		elif [ -n "$prometheus_screen_detail" ]; then
			prometheus_set_text_line "$prometheus_screen_detail" "$prometheus_color_muted"
		else
			prometheus_set_blank_line
		fi
		return
	fi
}

prometheus_screen_primary_text() {
	if [ -z "$prometheus_screen_question" ]; then
		printf '%s' "$prometheus_screen_title"
		return
	fi

	case "$prometheus_screen_question" in
		*'[Y/n]'*) printf '%s [Y/n] >' "$prometheus_screen_title" ;;
		*) printf '%s %s' "$prometheus_screen_title" "$prometheus_screen_question" ;;
	esac
}

prometheus_set_lab_line() {
	lab_row="$1"
	prometheus_lab_width="$prometheus_screen_render_lab_width"

	logo_line=$(prometheus_logo_line "$lab_row")
	if [ -n "$logo_line" ]; then
		logo_start=$(((prometheus_lab_width - 32) / 2))
		logo_end=$((logo_start + 32))
		left=$(prometheus_lab_background_range "$lab_row" 0 "$logo_start")
		right=$(prometheus_lab_background_range "$lab_row" "$logo_end" "$prometheus_lab_width")
		trace="${left}${prometheus_color_text}${logo_line}${prometheus_reset}${right}"
	else
		trace=$(prometheus_lab_background_range "$lab_row" 0 "$prometheus_lab_width")
	fi

	prometheus_content_is_set=1
	prometheus_content_text="$trace"
	prometheus_content_width="$prometheus_lab_width"
	prometheus_content_style=
}

prometheus_logo_line() {
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

prometheus_lab_background_range() {
	lab_row="$1"
	range_start="$2"
	range_end="$3"
	active_style=
	line=
	x="$range_start"
	while [ "$x" -lt "$range_end" ]; do
		prometheus_lab_cell "$x" "$lab_row"
		if [ "$prometheus_lab_cell_style" != "$active_style" ]; then
			if [ -n "$active_style" ]; then
				line="${line}${prometheus_reset}"
			fi
			if [ -n "$prometheus_lab_cell_style" ]; then
				line="${line}${prometheus_lab_cell_style}"
			fi
			active_style="$prometheus_lab_cell_style"
		fi
		line="${line}${prometheus_lab_cell_char}"
		x=$((x + 1))
	done
	if [ -n "$active_style" ]; then
		line="${line}${prometheus_reset}"
	fi
	printf '%s' "$line"
}

prometheus_lab_cell() {
	x="$1"
	y="$2"
	width="$prometheus_lab_width"
	height=14
	frame="$prometheus_screen_frame"
	prometheus_lab_cell_char=" "
	prometheus_lab_cell_style=

	hash=$(((x * 37 + y * 53 + frame * 11 + x * y * 3) % 101))
	if [ "$hash" -lt 3 ]; then
		prometheus_lab_cell_char="·"
		prometheus_lab_cell_style="$prometheus_color_dim"
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
			prometheus_lab_cell_char="╌"
		else
			prometheus_lab_cell_char="·"
		fi
		prometheus_lab_cell_style="$prometheus_color_dim"
	fi

	horizon_y=$((height * 58 / 100))
	if [ "$y" -eq "$horizon_y" ] && [ $((x % 2)) -eq 0 ] && [ $(((x + frame) % 13)) -lt 2 ]; then
		prometheus_lab_cell_char="─"
		if [ "$x" -gt $((width * 60 / 100)) ]; then
			prometheus_lab_cell_style="$prometheus_color_primary"
		else
			prometheus_lab_cell_style="$prometheus_color_dim"
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
					prometheus_lab_cell_char="┃"
				else
					prometheus_lab_cell_char="╎"
				fi
				prometheus_lab_cell_style="$prometheus_color_scan"
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
				prometheus_lab_cell_char="◆"
				prometheus_lab_cell_style="$prometheus_color_warning"
			elif [ $(((x + frame) % 12)) -eq 0 ]; then
				prometheus_lab_cell_char="•"
				prometheus_lab_cell_style="$prometheus_color_primary"
			else
				prometheus_lab_cell_char="·"
				prometheus_lab_cell_style="$prometheus_color_primary"
			fi
		fi
		trace_index=$((trace_index + 1))
	done
}

prometheus_set_blank_line() {
	prometheus_content_is_set=1
	prometheus_content_text=
	prometheus_content_width=0
	prometheus_content_style=
}

prometheus_set_text_line() {
	max_width=$((prometheus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prometheus_content_text=$(prometheus_fit_ascii "$1" "$max_width")
	prometheus_content_width=${#prometheus_content_text}
	prometheus_content_style="$2"
	prometheus_content_is_set=1
}

prometheus_set_title_line() {
	max_width=$((prometheus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prometheus_content_text=$(prometheus_fit_ascii "$1" "$max_width")
	prometheus_content_width=${#prometheus_content_text}
	case "$prometheus_content_text" in
		*"Prometheus"*)
			prometheus_content_text=$(prometheus_style_prometheus_title "$prometheus_content_text")
			prometheus_content_style=
			;;
		*)
			prometheus_content_style="$prometheus_bold$prometheus_color_primary"
			;;
	esac
	prometheus_content_is_set=1
}

prometheus_style_prometheus_title() {
	text="$1"
	styled=
	while :; do
		case "$text" in
			*"Prometheus"*)
				before=${text%%Prometheus*}
				rest=${text#*Prometheus}
				styled="${styled}${prometheus_bold}${prometheus_color_primary}${before}"
				styled="${styled}${prometheus_bold}${prometheus_color_primary}Prometheus${prometheus_reset}"
				text="$rest"
				;;
			*)
				styled="${styled}${prometheus_bold}${prometheus_color_primary}${text}${prometheus_reset}"
				printf '%s' "$styled"
				return
				;;
		esac
	done
}

prometheus_fit_ascii() {
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

prometheus_print_centered_line() {
	text="$1"
	width="$2"
	style="$3"
	left=$(((prometheus_screen_cols - width) / 2))
	if [ "$left" -lt 0 ]; then
		left=0
	fi
	if [ -n "$style" ]; then
		printf '%*s%s%s%s%s\n' "$left" "" "$style" "$text" "$prometheus_reset" "$prometheus_clear_line"
	else
		printf '%*s%s%s\n' "$left" "" "$text" "$prometheus_clear_line"
	fi
}

prometheus_place_prompt_cursor() {
	max_width=$((prometheus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prompt_text=$(prometheus_fit_ascii "$(prometheus_screen_primary_text)" "$max_width")
	prompt_width=${#prompt_text}
	content_height=$(prometheus_content_height)
	top=$(((prometheus_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi
	prompt_index=0
	if prometheus_show_logo; then
		prompt_index=$((prompt_index + 15))
	fi
	row=$((top + prompt_index + 1))
	col=$(((prometheus_screen_cols - prompt_width) / 2 + prompt_width + 2))
	if [ "$col" -lt 1 ]; then
		col=1
	fi
	if [ "$col" -gt "$prometheus_screen_cols" ]; then
		col="$prometheus_screen_cols"
	fi
	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s[%s;%sH' "$prometheus_reset" "$prometheus_show_cursor" "$prometheus_esc" "$row" "$col" >/dev/tty
	else
		printf '%s%s%s[%s;%sH' "$prometheus_reset" "$prometheus_show_cursor" "$prometheus_esc" "$row" "$col" >&2
	fi
}

prometheus_pulse() {
	case $((prometheus_screen_frame % 4)) in
		0) printf '.' ;;
		1) printf '..' ;;
		2) printf '...' ;;
		*) printf '' ;;
	esac
}

prometheus_animation_detail_count() {
	details="$1"
	case "$details" in
		*'
'*) printf '%s\n' "$details" | wc -l | tr -d ' ' ;;
		*) printf '1' ;;
	esac
}

prometheus_animation_current_frame() {
	frame="${prometheus_animation_frame:-1}"
	case "$frame" in
		""|*[!0-9]*) frame=1 ;;
	esac
	if [ "$frame" -lt 1 ]; then
		frame=1
	fi
	printf '%s' "$frame"
}

prometheus_animation_step_index() {
	details="$1"
	detail_count=$(prometheus_animation_detail_count "$details")
	frame=$(prometheus_animation_current_frame)
	detail_index=$(((frame - 1) / 24 + 1))
	if [ "$detail_index" -gt "$detail_count" ]; then
		detail_index="$detail_count"
	fi
	printf '%s' "$detail_index"
}

prometheus_static_progress_title() {
	case "$1" in
		*...) printf '%s' "$1" ;;
		*) printf '%s...' "$1" ;;
	esac
}

prometheus_animation_status() {
	status="$1"
	details="$2"
	status_mode="$3"
	case "$status_mode" in
		static) prometheus_static_progress_title "$status" ;;
		*) printf '%s%s' "$status" "$(prometheus_pulse)" ;;
	esac
}

prometheus_animation_detail() {
	details="$1"
	case "$details" in
		*'
'*)
			detail_index=$(prometheus_animation_step_index "$details")
			printf '%s\n' "$details" | sed -n "${detail_index}p"
			;;
		*) printf '%s' "$details" ;;
	esac
}

prometheus_run_quiet_with_animation() {
	title="$1"
	status="$2"
	detail="$3"
	shift 3

	prometheus_run_quiet_with_animation_command "$title" "$status" "$detail" pulse "$@"
}

prometheus_run_quiet_with_animation_steps() {
	title="$1"
	status="$2"
	details="$3"
	shift 3

	prometheus_run_quiet_with_animation_command "$title" "$status" "$details" static "$@"
}

prometheus_run_quiet_with_animation_command() {
	title="$1"
	status="$2"
	details="$3"
	status_mode="$4"
	shift 4

	if [ "$prometheus_screen_enabled" != 1 ]; then
		printf '%s\n' "$status" >&2
		"$@"
		return
	fi

	output_dir=$(create_temp_dir)
	output_file="$output_dir/output"
	"$@" >"$output_file" 2>&1 &
	command_pid=$!
	prometheus_animation_frame=0

	while kill -0 "$command_pid" 2>/dev/null; do
		prometheus_animation_frame=$((prometheus_animation_frame + 1))
		status_display=$(prometheus_animation_status "$status" "$details" "$status_mode")
		prometheus_screen "$title" "$status_display" "$(prometheus_animation_detail "$details")" ""
		sleep 0.18
	done

	if wait "$command_pid"; then
		command_status=0
	else
		command_status=$?
	fi

	if [ "$command_status" -ne 0 ] && [ -s "$output_file" ]; then
		prometheus_restore_terminal
		printf '\n' >&2
		cat "$output_file" >&2
	fi
	rm -rf "$output_dir"
	return "$command_status"
}

prometheus_prompt_yes_no() {
	question="$1"
	detail="$2"
	input_prompt="$3"

	if ( : <>/dev/tty ) 2>/dev/null; then
		prompt_input=tty
		exec 3<>/dev/tty
	elif [ -t 0 ]; then
		prompt_input=stdin
	else
		return 2
	fi

	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "$question" "" "$detail" "$input_prompt"
		prometheus_place_prompt_cursor "$input_prompt"
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
	if [ "$prometheus_screen_enabled" = 1 ]; then
		while kill -0 "$preflight_pid" 2>/dev/null; do
			prometheus_screen "Checking Node.js and npm$(prometheus_pulse)" "" "" ""
			sleep 0.18
		done
	fi

	if wait "$preflight_pid"; then
		preflight_status=0
	else
		preflight_status=$?
	fi

	if [ "$prometheus_screen_enabled" = 1 ]; then
		if [ "$preflight_status" -ne 0 ]; then
			preflight_summary=$(sed -n '1p' "$preflight_file")
			prometheus_screen "Node.js 20.6.0 or newer is required" "" "$preflight_summary" ""
			sleep 0.4
		elif [ -s "$preflight_file" ]; then
			preflight_summary="Existing $prometheus_cmd command found on PATH."
			prometheus_screen "Environment ready" "" "$preflight_summary" ""
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
	yellow="${prometheus_esc}[33m"
	reset="${prometheus_esc}[0m"

	if command -v node >/dev/null 2>&1; then
		node_version=$(node --version)
		if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && (minor > 6 || (minor === 6 && patch >= 0))) ? 0 : 1)' >/dev/null; then
			printf 'error: Prometheus requires Node.js 20.6.0 or newer. Found %s.\n' "$node_version"
			status=1
		fi
	else
		printf 'error: Node.js 20.6.0 or newer is required to install Prometheus.\n'
		status=1
	fi

	if ! command -v npm >/dev/null 2>&1; then
		printf 'error: npm is required to install Prometheus.\n'
		status=1
	fi

	if [ "$status" -ne 0 ]; then
		printf '\n'
	fi

	if prometheus_path=$(command -v "$prometheus_cmd" 2>/dev/null); then
		printf '%sExisting %s found at: %s%s\n' "$yellow" "$prometheus_cmd" "$prometheus_path" "$reset"
		printf '\n'
	fi

	return "$status"
}

resolve_prometheus_version() {
	if [ "${1:-}" ]; then
		case "$1" in
			stable|beta) release_channel="$1" ;;
			*)
				normalize_version "$1"
				return
				;;
		esac
	else
		release_channel="$prometheus_release_channel"
	fi

	if [ "${PROMETHEUS_VERSION:-}" ]; then
		normalize_version "$PROMETHEUS_VERSION"
		return
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to resolve the latest Prometheus version.\n' >&2
		exit 1
	fi

	case "$release_channel" in
		stable|beta) ;;
		*)
			printf 'error: invalid Prometheus release channel: %s\n' "$release_channel" >&2
			exit 1
			;;
	esac

	channel_dir=$(create_temp_dir)
	channel_path="$channel_dir/$release_channel"
	if ! prometheus_run_quiet_with_animation \
		"Resolving latest release" \
		"Resolving latest release" \
		"Checking the $release_channel release channel." \
		curl -fsSL "$prometheus_base_url/$release_channel" -o "$channel_path"; then
		rm -rf "$channel_dir"
		printf 'error: could not resolve latest Prometheus version from %s/%s\n' "$prometheus_base_url" "$release_channel" >&2
		exit 1
	fi
	channel_version="$(tr -d '[:space:]' <"$channel_path")"
	rm -rf "$channel_dir"
	if [ -z "$channel_version" ]; then
		printf 'error: could not resolve latest Prometheus version from %s/%s\n' "$prometheus_base_url" "$release_channel" >&2
		exit 1
	fi
	normalize_version "$channel_version"
}

normalize_version() {
	version="${1#v}"
	case "$version" in
		"")
			printf 'error: empty Prometheus version.\n' >&2
			exit 1
			;;
		*[!0-9A-Za-z.-]*)
			printf 'error: invalid Prometheus version: %s\n' "$1" >&2
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

	if prometheus_prompt_yes_no \
		"Install Node.js and npm with $label?" \
		"Required before Prometheus can be installed." \
		"Install? [Y/n]"; then
		install_node_npm "$method" "$label"
		return
	else
		prompt_status=$?
	fi
	if [ "$prompt_status" -eq 2 ]; then
		printf 'No terminal detected; install Node.js 20.6.0 or newer and npm, then run this installer again.\n'
	else
		printf '\nInstall Node.js 20.6.0 or newer and npm, then run this installer again.\n'
	fi
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

	[ "$major" -gt 20 ] && return 0
	[ "$major" -eq 20 ] && [ "$minor" -gt 6 ] && return 0
	[ "$major" -eq 20 ] && [ "$minor" -eq 6 ] && [ "$patch" -ge 0 ] && return 0
	return 1
}

install_node_npm() {
	method="$1"
	label="$2"

	if [ "$prometheus_screen_enabled" != 1 ]; then
		printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
		run_node_install_method "$method"
	else
		prepare_sudo_for_node_install "$method"
		node_install_details="Using $label.
Resolving Node.js packages.
Downloading Node.js runtime.
Installing npm.
Preparing Prometheus setup."
		prometheus_run_quiet_with_animation_steps \
			"Installing Node.js and npm" \
			"Installing Node.js and npm" \
			"$node_install_details" \
			run_node_install_method "$method"
	fi

	if [ "$method" = standalone ]; then
		load_standalone_node
		PROMETHEUS_NODE_INSTALLED_STANDALONE=1
	fi
	hash -r
	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "Node.js and npm installed" "" "Continuing Prometheus setup." ""
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

	prometheus_screen "Preparing Node.js install" "" "This may ask for your sudo password." ""
	prometheus_restore_terminal
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
	PROMETHEUS_STANDALONE_NODE_BIN="$(node_standalone_base_dir)/current/bin"
	PATH="$PROMETHEUS_STANDALONE_NODE_BIN:$PATH"
	export PROMETHEUS_STANDALONE_NODE_BIN PATH
}

node_standalone_base_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		printf '%s/prometheus-node' "$XDG_DATA_HOME"
	else
		printf '%s/.local/share/prometheus-node' "$HOME"
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
	if original_prometheus_path=$(resolve_prometheus_with_original_path); then
		case "$original_prometheus_path" in
			"$PROMETHEUS_STANDALONE_NODE_BIN/"*)
				if [ "$prometheus_screen_enabled" = 1 ]; then
					prometheus_screen "Prometheus installed" "" "Run it with: $prometheus_cmd" ""
				else
					printf '\nRun it with: %s\n' "$prometheus_cmd"
				fi
				return 0
				;;
		esac
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_screen "Prometheus installed" "" "PATH update needed for $prometheus_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$prometheus_cmd"
			printf 'Your shell currently resolves %s to: %s\n' "$prometheus_cmd" "$original_prometheus_path"
		fi
	else
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_screen "Prometheus installed" "" "PATH update needed for $prometheus_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$prometheus_cmd"
		fi
	fi

	profile=$(detect_shell_profile) || {
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_restore_terminal
			printf '\n'
		fi
		print_standalone_path_manual_instructions
		return 0
	}

	if shell_profile_has_standalone_node_path "$profile"; then
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_screen "Prometheus installed" "" "Run: $(prometheus_source_profile_command "$profile")" ""
		else
			printf '%s already contains %s.\n' "$profile" "$PROMETHEUS_STANDALONE_NODE_BIN"
			printf 'Restart your shell or run: %s\n' "$(prometheus_source_profile_command "$profile")"
		fi
		return 0
	fi

	prompt_add_standalone_node_path "$profile"
}

resolve_prometheus_with_original_path() {
	saved_path=$PATH
	PATH=$prometheus_original_path
	if command -v "$prometheus_cmd" 2>/dev/null; then
		status=0
	else
		status=$?
	fi
	PATH=$saved_path
	return "$status"
}

detect_shell_profile() {
	if [ -n "${PROMETHEUS_SHELL_PROFILE:-}" ]; then
		printf '%s' "$PROMETHEUS_SHELL_PROFILE"
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
	[ -f "$profile" ] && grep -F "$PROMETHEUS_STANDALONE_NODE_BIN" "$profile" >/dev/null 2>&1
}

prompt_add_standalone_node_path() {
	profile="$1"
	path_line=$(standalone_node_path_line)

	if ! prometheus_prompt_yes_no \
		"Add standalone Node.js to your PATH?" \
		"Updates $profile so future shells can run $prometheus_cmd." \
		"Update PATH? [Y/n]"; then
		if [ "$prometheus_screen_enabled" = 1 ]; then
			prometheus_restore_terminal
			printf '\n'
		fi
		print_standalone_path_manual_instructions
		return 0
	fi

	mkdir -p "$(dirname "$profile")"
	{
		printf '\n# Prometheus standalone Node.js\n'
		printf '%s\n' "$path_line"
	} >>"$profile"
	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "Prometheus installed" "" "Run: $(prometheus_source_profile_command "$profile")" ""
	else
		printf 'Added %s to %s.\n' "$PROMETHEUS_STANDALONE_NODE_BIN" "$profile"
		printf 'Restart your shell or run: %s\n' "$(prometheus_source_profile_command "$profile")"
	fi
}

print_standalone_path_manual_instructions() {
	printf 'Add this to your shell profile to use %s from new shells:\n\n' "$prometheus_cmd"
	printf '  %s\n' "$(standalone_node_path_line)"
	printf '\nThen restart your shell and run: %s\n' "$prometheus_cmd"
}

standalone_node_path_line() {
	printf 'export PATH="%s:$PATH"' "$PROMETHEUS_STANDALONE_NODE_BIN"
}

prometheus_shell_quote() {
	quoted=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
	printf "'%s'" "$quoted"
}

prometheus_source_profile_command() {
	printf '. %s && %s' "$(prometheus_shell_quote "$1")" "$prometheus_cmd"
}

download_prometheus_package() {
	version="$1"
	tarball_url="$2"
	tarball_path="$3"
	download_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	checksums_url="$prometheus_base_url/releases/v$version/SHA256SUMS"
	checksums_path="$download_dir/SHA256SUMS"

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to download Prometheus.\n' >&2
		exit 1
	fi

	prometheus_run_quiet_with_animation \
		"Downloading checksums" \
		"Downloading release checksums" \
		"Prometheus v$version" \
		curl -fsSL "$checksums_url" -o "$checksums_path"

	prometheus_run_quiet_with_animation \
		"Downloading Prometheus" \
		"Downloading Prometheus v$version" \
		"Fetching the verified package." \
		curl -fsSL "$tarball_url" -o "$tarball_path"

	verify_prometheus_package_checksum "$checksums_path" "$tarball_path"
}

verify_prometheus_package_checksum() {
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
		prometheus_run_quiet_with_animation \
			"Verifying download" \
			"Verifying Prometheus download" \
			"Checking SHA-256." \
			prometheus_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		prometheus_run_quiet_with_animation \
			"Verifying download" \
			"Verifying Prometheus download" \
			"Checking SHA-256." \
			prometheus_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" shasum
	else
		printf 'error: sha256sum or shasum is required to verify the Prometheus download.\n' >&2
		exit 1
	fi
}

prometheus_run_checksum_check() {
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

	if prometheus_prompt_yes_no \
		"Install Prometheus v$version globally with npm?" \
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

	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "Installation cancelled" "" "No changes were made." ""
		exit 0
	fi
	printf '\nInstallation cancelled.\n'
	exit 0
}

confirm_kernel_runtime_setup() {
	case "${PROMETHEUS_BOOTSTRAP_KERNEL_ON_INSTALL:-}" in
		1)
			prometheus_bootstrap_kernel_on_install=1
			return
			;;
		0)
			prometheus_bootstrap_kernel_on_install=0
			return
			;;
	esac

	if prometheus_prompt_yes_no \
		"Prepare IPython runtime now?" \
		"Installs uv, Python 3.11, ipykernel, and Prometheus runtime." \
		"Prepare? [Y/n]"; then
		prometheus_bootstrap_kernel_on_install=1
		return
	else
		prompt_status=$?
	fi

	if [ "$prompt_status" -eq 2 ]; then
		printf 'No terminal detected; preparing the IPython runtime during install.\n'
		prometheus_bootstrap_kernel_on_install=1
		return
	fi

	prometheus_bootstrap_kernel_on_install=0
	if [ "$prometheus_screen_enabled" = 1 ]; then
		prometheus_screen "IPython setup skipped" "" "The runtime can be prepared on first ipython use." ""
		sleep 0.4
	else
		printf '\nSkipping IPython runtime setup.\n'
	fi
}

install_prometheus_package() {
	tarball_path="$1"
	if [ "$prometheus_bootstrap_kernel_on_install" = 1 ]; then
		npm_install_details="Preparing global install.
Linking command binaries.
Installing runtime packages.
Preloading search tools.
Preparing IPython kernel.
Finalizing npm install."
		prometheus_run_quiet_with_animation_steps \
			"Installing Prometheus" \
			"Installing Prometheus" \
			"$npm_install_details" \
			env PROMETHEUS_BOOTSTRAP_TOOLS_ON_INSTALL=1 PROMETHEUS_BOOTSTRAP_KERNEL_ON_INSTALL=1 PROMETHEUS_INSTALL_UV=1 npm install -g --no-fund --no-audit --loglevel=error --progress=false "$tarball_path"
	else
		npm_install_details="Preparing global install.
Linking command binaries.
Installing runtime packages.
Preloading search tools.
Finalizing npm install."
		prometheus_run_quiet_with_animation_steps \
			"Installing Prometheus" \
			"Installing Prometheus" \
			"$npm_install_details" \
			env PROMETHEUS_BOOTSTRAP_TOOLS_ON_INSTALL=1 npm install -g --no-fund --no-audit --loglevel=error --progress=false "$tarball_path"
	fi
}

main "$@"

// Lucide icons (ISC) bundled as text so the extension stays offline and CSP-clean.

import i_circle_dot from 'lucide-static/icons/circle-dot.svg';
import i_circle from 'lucide-static/icons/circle.svg';
import i_video from 'lucide-static/icons/video.svg';
import i_camera from 'lucide-static/icons/camera.svg';
import i_flag from 'lucide-static/icons/flag.svg';
import i_pause from 'lucide-static/icons/pause.svg';
import i_play from 'lucide-static/icons/play.svg';
import i_square from 'lucide-static/icons/square.svg';
import i_zap from 'lucide-static/icons/zap.svg';
import i_shield_check from 'lucide-static/icons/shield-check.svg';
import i_lock from 'lucide-static/icons/lock.svg';
import i_clock from 'lucide-static/icons/clock.svg';
import i_timer from 'lucide-static/icons/timer.svg';
import i_trash_2 from 'lucide-static/icons/trash-2.svg';
import i_external_link from 'lucide-static/icons/external-link.svg';
import i_settings from 'lucide-static/icons/settings.svg';
import i_download from 'lucide-static/icons/download.svg';
import i_copy from 'lucide-static/icons/copy.svg';
import i_file_text from 'lucide-static/icons/file-text.svg';
import i_file_code_2 from 'lucide-static/icons/file-code-2.svg';
import i_file_spreadsheet from 'lucide-static/icons/file-spreadsheet.svg';
import i_file_type_2 from 'lucide-static/icons/file-type-2.svg';
import i_archive from 'lucide-static/icons/archive.svg';
import i_mouse_pointer_click from 'lucide-static/icons/mouse-pointer-click.svg';
import i_navigation from 'lucide-static/icons/navigation.svg';
import i_info from 'lucide-static/icons/info.svg';
import i_text_cursor_input from 'lucide-static/icons/text-cursor-input.svg';
import i_send from 'lucide-static/icons/send.svg';
import i_x from 'lucide-static/icons/x.svg';
import i_check from 'lucide-static/icons/check.svg';
import i_chevron_right from 'lucide-static/icons/chevron-right.svg';
import i_chevron_down from 'lucide-static/icons/chevron-down.svg';
import i_triangle_alert from 'lucide-static/icons/triangle-alert.svg';
import i_moon from 'lucide-static/icons/moon.svg';
import i_eye_off from 'lucide-static/icons/eye-off.svg';
import i_power from 'lucide-static/icons/power.svg';
import i_history from 'lucide-static/icons/history.svg';
import i_layers from 'lucide-static/icons/layers.svg';
import i_rewind from 'lucide-static/icons/rewind.svg';
import i_film from 'lucide-static/icons/film.svg';
import i_image from 'lucide-static/icons/image.svg';
import i_globe from 'lucide-static/icons/globe.svg';
import i_refresh_cw from 'lucide-static/icons/refresh-cw.svg';
import i_sparkles from 'lucide-static/icons/sparkles.svg';
import i_monitor from 'lucide-static/icons/monitor.svg';
import i_bookmark from 'lucide-static/icons/bookmark.svg';
import i_list_checks from 'lucide-static/icons/list-checks.svg';
import i_arrow_left from 'lucide-static/icons/arrow-left.svg';
import i_keyboard from 'lucide-static/icons/keyboard.svg';
import i_hard_drive from 'lucide-static/icons/hard-drive.svg';
import i_scan_eye from 'lucide-static/icons/scan-eye.svg';
import i_route from 'lucide-static/icons/route.svg';

const raw = {
  'circle-dot': i_circle_dot,
  'circle': i_circle,
  'video': i_video,
  'camera': i_camera,
  'flag': i_flag,
  'pause': i_pause,
  'play': i_play,
  'square': i_square,
  'zap': i_zap,
  'shield-check': i_shield_check,
  'lock': i_lock,
  'clock': i_clock,
  'timer': i_timer,
  'trash-2': i_trash_2,
  'external-link': i_external_link,
  'settings': i_settings,
  'download': i_download,
  'copy': i_copy,
  'file-text': i_file_text,
  'file-code-2': i_file_code_2,
  'file-spreadsheet': i_file_spreadsheet,
  'file-type-2': i_file_type_2,
  'archive': i_archive,
  'mouse-pointer-click': i_mouse_pointer_click,
  'navigation': i_navigation,
  'info': i_info,
  'text-cursor-input': i_text_cursor_input,
  'send': i_send,
  'x': i_x,
  'check': i_check,
  'chevron-right': i_chevron_right,
  'chevron-down': i_chevron_down,
  'triangle-alert': i_triangle_alert,
  'moon': i_moon,
  'eye-off': i_eye_off,
  'power': i_power,
  'history': i_history,
  'layers': i_layers,
  'rewind': i_rewind,
  'film': i_film,
  'image': i_image,
  'globe': i_globe,
  'refresh-cw': i_refresh_cw,
  'sparkles': i_sparkles,
  'monitor': i_monitor,
  'bookmark': i_bookmark,
  'list-checks': i_list_checks,
  'arrow-left': i_arrow_left,
  'keyboard': i_keyboard,
  'hard-drive': i_hard_drive,
  'scan-eye': i_scan_eye,
  'route': i_route,
} as const;

export type IconName = keyof typeof raw;

/** Inline SVG sized by CSS (1em), coloured by currentColor. */
export function icon(name: IconName, cls = ''): string {
  return raw[name]
    .replace(/<!--[\s\S]*?-->\s*/, '')
    .replace(/\s+class="[^"]*"/, '')
    .replace(/\s+width="24"\s+height="24"/, '')
    .replace('<svg', `<svg class="i ${cls}" aria-hidden="true" focusable="false"`);
}

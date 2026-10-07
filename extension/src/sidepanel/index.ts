import { loadSamples, sampleSessionIds } from '../demo/sample';
import { collecting, displayState, initialState } from '../shared/state';
import { getPolicy, getSettings, onPolicyChanged, saveSettings } from '../shared/settings';
import { NO_POLICY, lockedKeys, type Policy } from '../shared/policy';
import { formatClock } from '../shared/filename';
import { dbGet, dbGetAll, dbIndexAll, eventsOfSession } from '../storage/db';
import { storageEstimate } from '../storage/opfs';
import { sessionThumb } from '../report/thumb';
import type { CommandMessage } from '../shared/messages';
import type { CaptureState, DisplayCode, HealthSnapshot, ScreenshotItem, SessionRecord, Settings, TimelineEvent } from '../shared/types';
import { icon, type IconName } from '../ui/icons';
import { logo } from '../ui/brand';
import { ago, bytes, duration, esc, host } from '../ui/format';

const app = document.getElementById('app')!;
let state: CaptureState = initialState();
let settings: Settings;
let health: HealthSnapshot | null = null;
let notice: { text: string; level: string; at: number } | null = null;
let sessions: SessionRecord[] = [];
let sampleBusy = '';
let policy: Policy = NO_POLICY;
const isLocked = (k: keyof Settings) => lockedKeys(policy).includes(k);
const lk = (k: keyof Settings) => (isLocked(k) ? ` <span class="lockfx">${icon('lock')}set by your organization</span>` : '');
let codecInfo = '';
let storageInfo = '';
let remembered = false;
let swStarts = 0;
let view: 'main' | 'settings' = 'main';
let markerLabel = '';
let shotCount = 0;
const meta = new Map<string, { thumb: string | null; markers: number; shots: number }>();
let lastSig = '';

const HEAD: Record<DisplayCode, { icon: IconName; title: string; sub: string }> = {
  inactive: { icon: 'power', title: 'Ready when you are', sub: 'Not capturing anything' },
  armed: { icon: 'circle-dot', title: 'Rolling buffer is on', sub: 'Only this tab is recorded' },
  recording: { icon: 'video', title: 'Recording session', sub: 'Markers and screenshots on tap' },
  screenshot_only: { icon: 'camera', title: 'Screenshots only', sub: 'No video is being recorded' },
  privacy_paused: { icon: 'eye-off', title: 'Paused: left the target', sub: 'Nothing from other tabs is stored' },
  manual_paused: { icon: 'pause', title: 'Paused by you', sub: 'Resume when you are ready' },
  afk: { icon: 'moon', title: 'Away: capture suspended', sub: 'Resumes when you are back' },
  target_ended: { icon: 'square', title: 'Target ended', sub: 'Evidence so far is frozen' },
  error: { icon: 'triangle-alert', title: 'Not recording', sub: 'The capture pipeline needs attention' },
};

const cmd = (c: CommandMessage['cmd'], payload?: Record<string, unknown>) => chrome.runtime.sendMessage({ kind: 'cmd', cmd: c, payload } satisfies CommandMessage);

/** The panel never trusts button state: if the capture pipeline stops reporting, it says so (spec PRIV-03 / State trust). */
function effectiveDisplay() {
  const d = displayState(state);
  if (collecting(state) && state.mode !== 'screenshot_only' && (!health || Date.now() - health.at > 6000) && state.armedAt && Date.now() - state.armedAt > 8000) {
    return { code: 'error' as const, label: 'ERROR / NOT RECORDING - no capture heartbeat', badge: 'ERR' };
  }
  return d;
}

const kbds = (keys: string[]) => `<span class="kbd">${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</span>`;
function tile(c: string, ic: IconName, title: string, sub: string, opts: { primary?: boolean; danger?: boolean; keys?: string[]; compact?: boolean; disabled?: boolean } = {}): string {
  return `<button class="action ${opts.primary ? 'primary' : ''} ${opts.danger ? 'danger' : ''} ${opts.compact ? 'compact' : ''}"${opts.disabled ? ' disabled' : ''} data-c="${c}"${opts.keys ? ` title="Shortcut: ${opts.keys.join('+')}"` : ''}>
    <span class="action__icon">${icon(ic)}</span><span><div class="action__t">${title}</div><div class="action__s">${sub}</div></span>${opts.keys ? kbds(opts.keys) : ''}</button>`;
}

function statusBadge(s: SessionRecord): string {
  if (s.status === 'finished') return '<span class="badge ok">Saved</span>';
  if (s.status === 'active') return '<span class="badge live">Live</span>';
  if (s.status === 'target_ended') return '<span class="badge bad">Target ended</span>';
  return '<span class="badge warn">Recovered</span>';
}
const KIND: Record<string, { icon: IconName; name: string }> = { instant: { icon: 'history', name: 'Instant Replay' }, repro: { icon: 'video', name: 'Repro Session' }, screenshot: { icon: 'camera', name: 'Screenshots' } };

function render(): void {
  const d = effectiveDisplay();
  const head = HEAD[d.code];
  const active = state.mode !== 'inactive';
  const term = !!state.terminal;
  const repro = state.mode === 'repro';
  const shot = state.mode === 'screenshot_only';
  const elapsed = state.reproStartedAt && !term ? formatClock(Date.now() - state.reproStartedAt) : '';
  const ringSec = Math.min(settings.replaySec, (health?.ringSegments ?? 0) * 2);
  const ticks = 30;
  const on = Math.ceil((ringSec / settings.replaySec) * ticks);
  const recovered = sessions.filter((s) => s.status === 'recovered' && !s.reviewedAt);
  const sub = state.terminal && state.reason ? '' : head.sub;
  const active_ = document.activeElement as HTMLInputElement | null;
  const refocus = active_?.id === 'markerLabel' ? { start: active_.selectionStart, end: active_.selectionEnd } : null;

  let body = '';
  if (view === 'settings') body = settingsView();
  else {
    body += `<div class="hero" data-code="${d.code}" role="status" aria-live="polite">
      <div class="hero__row"><span class="hero__badge">${icon(head.icon)}</span>
        <div style="flex:1;min-width:0"><div class="hero__top"><div class="eyebrow">${esc(d.label)}</div><span class="hero__timer timer">${elapsed}</span></div><div class="hero__label">${head.title}</div><div class="hero__sub">${sub}</div></div></div>
      ${state.reason && term ? `<div class="hero__reason">${esc(state.reason)}</div>` : ''}
      ${active ? `<div class="hero__target">${icon('globe')}<span>Target</span><b>${esc(host(state.targetOrigin))}</b>${shot ? '<span class="pill accent" style="margin-left:auto">video off</span>' : ''}</div>` : ''}
      ${active && !shot && !repro && !term ? `<div class="meter"><div class="meter__head"><span>Rolling buffer</span><b>${ringSec}s of ${settings.replaySec}s</b></div><div class="meter__bar">${Array.from({ length: ticks }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div></div>` : ''}
      ${repro && !term ? `<div class="meter"><div class="meter__head"><span>This session</span><b>${state.markerCount} marker${state.markerCount === 1 ? '' : 's'} · ${shotCount} screenshot${shotCount === 1 ? '' : 's'}</b></div></div>` : ''}
    </div>
    <div class="trust"><span class="chip">${icon('shield-check')}Local only</span><span class="chip">${icon('keyboard')}No keystrokes</span><span class="chip">${icon('monitor')}This tab only</span></div>`;

    if (state.afk && state.afkNeedsResume) body += `<div class="section"><div class="actions">${tile('resumeFromAfk', 'play', 'Resume recording', 'You were away. The session does not restart on its own.', { primary: true })}</div></div>`;
    if (!active) {
      body += `<div class="section"><div class="card" style="padding:16px"><div style="display:flex;gap:12px;align-items:flex-start"><span class="action__icon" style="width:38px;height:38px">${icon('mouse-pointer-click')}</span><div><div class="action__t" style="font-size:14px">Arm it on the app you test</div><p class="muted" style="margin-top:4px">Open the web app, then <b>click the ReproDesk icon in the toolbar</b>. Chrome only allows tab capture after that explicit action, so nothing can start silently.${policy.allowedTargetOrigins ? ` <span class="faint">Your organization limits ReproDesk to: ${esc(policy.allowedTargetOrigins.join(', '))}.</span>` : ''}</p></div></div></div></div>`;
    } else if (term) {
      body += `<div class="section"><div class="actions"><button class="btn primary wide" data-c="ackTerminal" style="height:38px">Dismiss</button></div></div>`;
    } else if (repro) {
      body += `<div class="section"><h2>Session</h2><div class="markerline"><input class="input" id="markerLabel" placeholder="Name this marker (optional)" value="${esc(markerLabel)}" maxlength="80"></div>
        <div class="actions">${tile('marker', 'flag', 'Add marker', state.manual || state.privacy ? 'Unavailable while paused' : 'Flag this moment · screenshot included', { primary: true, keys: ['Alt', 'Shift', 'M'], disabled: state.manual || state.privacy })}
        <div class="actions two">${tile('screenshot', 'camera', 'Screenshot', 'Current view', { compact: true })}${state.manual ? tile('manualResume', 'play', 'Resume', 'Continue capture', { compact: true }) : tile('manualPause', 'pause', 'Pause', 'Stop collecting', { compact: true })}</div>
        ${tile('finishRepro', 'square', 'Finish & review', 'Stop and open the report', { danger: true })}</div></div>`;
    } else if (shot) {
      body += `<div class="section"><h2>Capture</h2><div class="actions">${tile('screenshot', 'camera', 'Take screenshot', 'With target, time and safe context', { primary: true, keys: ['Alt', 'Shift', 'S'] })}
        ${state.sessionId || state.shotSessionId ? tile(state.sessionId ? 'finishRepro' : 'finishShotSession', 'square', 'Finish screenshot session', 'Open the report', { danger: true }) : tile('startRepro', 'layers', 'Start screenshot session', 'Group screenshots into one report')}
        <button class="btn ghost wide" data-c="disarm">${icon('power')}Disarm</button></div></div>`;
    } else {
      body += `<div class="section"><h2>Capture</h2><div class="actions">
        ${tile('saveReplay', 'history', 'Save last replay', `Freeze the last ${settings.replaySec} s + ${settings.tailSec} s tail`, { primary: true, keys: ['Alt', 'Shift', 'R'] })}
        ${tile('startRepro', 'video', 'Start Repro Session', `Record the full path${settings.preSessionSec ? ` · keeps ${settings.preSessionSec} s before` : ''}`)}
        <div class="actions two">${tile('screenshot', 'camera', 'Screenshot', 'Current view', { compact: true })}${state.manual ? tile('manualResume', 'play', 'Resume', 'Continue capture', { compact: true }) : tile('manualPause', 'pause', 'Pause', 'Stop collecting', { compact: true })}</div>
        <button class="btn ghost wide" data-c="disarm">${icon('power')}Disarm</button></div></div>`;
      if (state.shotSessionId) body += `<div class="section"><button class="btn wide" data-c="finishShotSession">${icon('image')}Finish screenshot collection &amp; open report</button></div>`;
    }
    if (active && !term && !remembered) body += `<div class="remember">${icon('lock')}<span>Keep capturing across reloads &amp; SSO</span><button class="btn sm" id="remember">Remember site</button></div>`;
    body += recovered.map((s) => `<div class="recovered"><b>${icon('triangle-alert')}Recovered session</b><p class="small muted" style="margin:4px 0 9px">Recording ended unexpectedly. Last committed ${s.lastCommittedAt ? new Date(s.lastCommittedAt).toLocaleTimeString() : 'n/a'}.</p><div style="display:flex;gap:8px"><button class="btn sm primary" data-review="${s.id}">Review</button><button class="btn sm" data-del="${s.id}">Delete</button></div></div>`).join('');
    body += `<div class="section"><h2>Recent sessions <span class="count">${sessions.length ? `· ${sessions.length}` : ''}</span><span style="margin-left:auto;text-transform:none;letter-spacing:0"><button class="btn ghost sm" data-nav="all" style="height:22px;padding:0 6px">View all ${icon('external-link')}</button></span></h2>
      ${sessions.length ? `<div class="sessions">${sessions.slice(0, 4).map(sessionRow).join('')}</div>` : `<div class="empty">${icon('film')}<b>No sessions yet</b><span class="small">Saved replays and Repro Sessions appear here.</span>${policy.sampleSessions ? `<button class="btn sm" id="load-sample" style="margin-top:10px" ${sampleBusy ? 'disabled' : ''}>${icon('sparkles')}${sampleBusy || 'Try with sample sessions'}</button>` : ''}</div>`}</div>`;
  }
  const toast = notice && Date.now() - notice.at < 9000 ? `<div class="toast ${notice.level}">${icon(notice.level === 'info' ? 'info' : 'triangle-alert')}<span>${esc(notice.text)}</span></div>` : '';
  app.innerHTML = `<div class="panel">
    <div class="topbar"><div class="brand">${logo(26)}<h1>${view === 'settings' ? 'Settings' : 'Capture'}</h1><span class="pill accent">Phase 0</span></div>
      <button class="iconbtn ${view === 'settings' ? 'on' : ''}" data-nav="${view === 'settings' ? 'main' : 'settings'}" title="${view === 'settings' ? 'Back' : 'Settings & diagnostics'}" aria-label="Settings">${icon(view === 'settings' ? 'arrow-left' : 'settings')}</button></div>
    ${body}${toast}</div>`;
  if (refocus) {
    const el = document.getElementById('markerLabel') as HTMLInputElement | null;
    el?.focus();
    el?.setSelectionRange(refocus.start, refocus.end);
  }
}

function sessionRow(s: SessionRecord): string {
  const m = meta.get(s.id);
  const k = KIND[s.kind] ?? KIND.instant;
  const dur = s.endedAt ? duration(s.endedAt - s.startedAt) : 'live';
  const counts = `${m?.markers ? `<span>${icon('flag')}${m.markers}</span>` : ''}${m?.shots ? `<span>${icon('camera')}${m.shots}</span>` : ''}`;
  return `<div class="session"><div class="thumb ${s.kind}">${m?.thumb ? `<img src="${m.thumb}" alt="">` : icon(k.icon)}</div>
    <div class="session__body"><div class="session__t"><span>${k.name}</span>${statusBadge(s)}${s.sample ? '<span class="badge">Sample</span>' : ''}</div><div class="session__m"><span>${ago(s.createdAt)}</span><span class="dotsep">·</span><span class="num">${dur}</span>${counts}</div></div>
    <div class="session__act"><button class="iconbtn" data-review="${s.id}" title="Open report" aria-label="Open report">${icon('external-link')}</button><button class="iconbtn" data-del="${s.id}" title="Delete" aria-label="Delete">${icon('trash-2')}</button></div></div>`;
}

function seg(key: keyof Settings, values: Array<[number, string]>): string {
  return `<div class="seg" role="group">${values.map(([v, l]) => `<button data-seg="${key}" data-v="${v}" class="${Number(settings[key]) === v ? 'on' : ''}" ${isLocked(key) ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
}
const sw = (key: keyof Settings, name: string) => `<label class="switch"><input type="checkbox" aria-label="${name}" data-sb="${key}" ${settings[key] ? 'checked' : ''} ${isLocked(key) ? 'disabled' : ''}><span></span></label>`;
const row = (t: string, s: string, ctl: string) => `<div class="setrow"><div><div class="t">${t}</div><div class="s">${s}</div></div>${ctl}</div>`;

function managedRules(): string[] {
  const out: string[] = [];
  if (policy.allowedTargetOrigins) out.push(`ReproDesk can be armed only on: ${policy.allowedTargetOrigins.join(', ')}`);
  if (policy.blockedOrigins.length) out.push(`Never on: ${policy.blockedOrigins.join(', ')}`);
  if (policy.settings.captureVideo === false) out.push('Video capture is not allowed (Screenshot-only mode)');
  if (policy.allowedExportFormats) out.push(`Exports limited to: ${policy.allowedExportFormats.map((f) => f.toUpperCase()).join(', ') || 'none'}`);
  if (!policy.allowUnredactedOriginals) out.push('Unredacted original screenshots cannot be exported');
  if (policy.requireExportConfirmation) out.push('Every export asks for confirmation');
  if (policy.sessionRetentionDays) out.push(`Finished sessions are deleted after ${policy.sessionRetentionDays} days`);
  return out;
}

function managedBanner(): string {
  if (!policy.managed) return '';
  const rules = managedRules();
  return `<div class="callout managed" id="managed-banner">${icon('lock-keyhole')}<div><b>Managed by your organization.</b> Your administrator fixed some settings; they show a lock and cannot be changed here.${rules.length ? `<ul>${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div></div>`;
}

function settingsView(): string {
  const h = health;
  return `${managedBanner()}<div class="section" style="margin-top:4px"><h2>Capture</h2><div class="card drawer">
    ${row('Replay window', 'How much is kept while Armed' + lk('replaySec'), seg('replaySec', [[30, '30s'], [60, '60s'], [90, '90s'], [120, '120s']]))}
    ${row('Post-trigger tail', 'Recorded after you press Save' + lk('tailSec'), seg('tailSec', [[0, '0'], [3, '3s'], [5, '5s'], [10, '10s']]))}
    ${row('Pre-session context', 'Kept before a Repro Session starts' + lk('preSessionSec'), seg('preSessionSec', [[0, 'Off'], [30, '30s']]))}
    ${row('AFK suspend', 'After this idle time (locked = immediately)' + lk('afkMinutes'), seg('afkMinutes', [[0, 'Off'], [5, '5m'], [10, '10m'], [15, '15m'], [30, '30m']]))}
    ${row('Marker screenshots', 'Capture a screenshot with every marker' + lk('markerScreenshot'), sw('markerScreenshot', 'Marker screenshots'))}
    ${row('Video capture', (policy.settings.captureVideo === false ? 'Forbidden: Screenshot-only mode' : 'Off = Screenshot-only (applies when arming)') + lk('captureVideo'), sw('captureVideo', 'Video capture'))}
    ${row('Open report after saving', 'Jump straight to Review', sw('openReviewAfterSave', 'Open report after saving'))}</div></div>
    <div class="section"><h2>Target profile</h2><div class="card drawer">
    <div class="field" style="margin-top:10px"><label>Environment</label><input class="input" type="text" aria-label="Environment" data-s="environment" value="${esc(settings.environment)}" ${isLocked('environment') ? 'disabled' : ''}>${isLocked('environment') ? `<span class="hint">${icon('lock')}set by your organization</span>` : ''}</div>
    <div class="field"><label>Extra approved origins</label><input class="input" type="text" aria-label="Extra approved origins" data-s="approvedOrigins" value="${esc(settings.approvedOrigins.filter((o) => !policy.approvedOrigins.includes(o)).join(', '))}" placeholder="https://auth.example.com">${policy.approvedOrigins.length ? `<span class="hint">${icon('lock')}Added by your organization: ${esc(policy.approvedOrigins.join(', '))}</span>` : ''}<span class="hint">Comma separated. Same Target Profile, semantic scope only.</span></div></div></div>
    <div class="section"><h2>Quality</h2><div class="card drawer">
    ${row('Frame rate', 'Frames per second', seg('fps', [[5, '5'], [10, '10'], [15, '15'], [24, '24'], [30, '30']]))}
    ${row('Bitrate', 'Video quality vs. size', seg('bitrateKbps', [[600, '0.6'], [1000, '1'], [1500, '1.5'], [2500, '2.5'], [4000, '4']]))}</div></div>
    <div class="section"><h2>Shortcuts</h2><div class="card drawer">
    ${row('Save last replay', '', kbds(['Alt', 'Shift', 'R']))}${row('Add marker', '', kbds(['Alt', 'Shift', 'M']))}${row('Screenshot', '', kbds(['Alt', 'Shift', 'S']))}
    ${row('Start / finish session', 'Assign at chrome://extensions/shortcuts', '<span class="faint small">unassigned</span>')}</div></div>
    ${policy.sampleSessions ? `<div class="section"><h2>Sample data</h2><div class="card drawer"><p class="muted small" style="margin:0 0 10px">A pre-recorded run of a demo shop (promo code ignored, order fails with E-4021). Use it to try the Review page, the blur / redact tools and every export without recording anything. It is labelled <b>Sample</b>, stays on this device and can be removed at any time.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" id="load-sample" ${sampleBusy ? 'disabled' : ''}>${icon('sparkles')}${sampleBusy || (sessions.some((x) => x.sample) ? 'Reload sample sessions' : 'Load sample sessions')}</button>${sessions.some((x) => x.sample) ? `<button class="btn sm" id="remove-sample" ${sampleBusy ? 'disabled' : ''}>${icon('trash-2')}Remove sample sessions</button>` : ''}</div></div></div>` : ''}
    <div class="section"><h2>Diagnostics</h2><div class="card drawer"><div class="kv" style="margin-top:10px">
      <span>Frames encoded</span><span>${h?.framesEncoded ?? 0}</span><span>Dropped</span><span>${h?.framesDropped ?? 0}</span>
      <span>Stream</span><span>${h?.codec ? `${h.codec.startsWith('vp09') ? 'VP9' : h.codec} ${h.width}×${h.height}` : '-'}</span>
      <span>Media written</span><span>${bytes(h?.bytesWritten ?? 0)}</span><span>Offscreen heap</span><span>${h?.jsHeapMB ?? '-'} MB</span><span>Service worker starts</span><span>${swStarts}</span></div>
      <pre class="diag" id="diag" tabindex="0" aria-label="Diagnostics">${esc(diagText())}</pre><button class="btn sm" id="copydiag">${icon('copy')}Copy diagnostics JSON</button></div></div>`;
}

function diagText(): string {
  const h = health;
  return JSON.stringify({
    state: displayState(state).label, mode: state.mode, privacy: state.privacy, manual: state.manual, afk: state.afk,
    health: h ? { ...h, ageMs: Date.now() - h.at, ringBytesMB: +(h.ringBytes / 1048576).toFixed(2), writtenMB: +(h.bytesWritten / 1048576).toFixed(2) } : null,
    storage: storageInfo, encoders: codecInfo, serviceWorkerStarts: swStarts, chromeUA: navigator.userAgent,
    policy: policy.managed ? { managed: true, locked: lockedKeys(policy), allowedTargetOrigins: policy.allowedTargetOrigins, blockedOrigins: policy.blockedOrigins, approvedOrigins: policy.approvedOrigins, allowedExportFormats: policy.allowedExportFormats, allowUnredactedOriginals: policy.allowUnredactedOriginals, requireExportConfirmation: policy.requireExportConfirmation, sessionRetentionDays: policy.sessionRetentionDays, sampleSessions: policy.sampleSessions } : { managed: false },
  }, null, 2);
}

app.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-c],[data-review],[data-del],[data-nav],[data-seg],#remember,#copydiag,#load-sample,#remove-sample');
  if (!t) return;
  if (t.dataset.c) {
    if (t.dataset.c === 'marker') {
      void cmd('marker', { label: markerLabel });
      markerLabel = '';
      lastSig = '';
      render();
    } else void cmd(t.dataset.c as CommandMessage['cmd']);
  } else if (t.dataset.review) void cmd('openReview', { sessionId: t.dataset.review });
  else if (t.dataset.del) {
    if (confirm('Delete this session and its evidence from this browser?')) {
      await chrome.runtime.sendMessage({ kind: 'delete-session', id: t.dataset.del });
      await refreshSessions();
    }
  } else if (t.dataset.nav) {
    if (t.dataset.nav === 'all') void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    else {
      view = t.dataset.nav as 'main' | 'settings';
      lastSig = '';
      render();
    }
  } else if (t.dataset.seg) {
    settings = await saveSettings({ [t.dataset.seg]: Number(t.dataset.v) } as Partial<Settings>);
    lastSig = '';
    render();
  } else if (t.id === 'remember') {
    if (!state.targetOrigin) return;
    const ok = await chrome.permissions.request({ origins: [`${state.targetOrigin}/*`] });
    if (ok) {
      await cmd('siteRemembered', { origin: state.targetOrigin });
      remembered = true;
      lastSig = '';
      render();
    }
  } else if (t.id === 'copydiag') void navigator.clipboard.writeText(diagText());
  else if (t.id === 'load-sample' || t.id === 'remove-sample') {
    const removeOne = (id: string) => chrome.runtime.sendMessage({ kind: 'delete-session', id }).then(() => undefined);
    sampleBusy = t.id === 'load-sample' ? 'Loading…' : 'Removing…';
    lastSig = '';
    render();
    try {
      if (t.id === 'load-sample') await loadSamples(removeOne);
      else for (const id of await sampleSessionIds()) await removeOne(id);
    } catch (err) {
      notice = { text: `Sample data: ${err instanceof Error ? err.message : String(err)}`, level: 'error', at: Date.now() };
    } finally {
      sampleBusy = '';
      await refreshSessions();
      lastSig = '';
      render();
    }
  }
});
app.addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.s) {
    const k = el.dataset.s as keyof Settings;
    settings = await saveSettings({ [k]: k === 'approvedOrigins' ? el.value.split(',').map((x) => x.trim()).filter(Boolean) : el.value } as Partial<Settings>);
  } else if (el.dataset.sb) settings = await saveSettings({ [el.dataset.sb]: el.checked } as Partial<Settings>);
});
app.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === 'markerLabel') markerLabel = el.value;
});
app.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).id === 'markerLabel' && e.key === 'Enter') (app.querySelector('[data-c="marker"]') as HTMLElement | null)?.click();
});

async function loadMeta(s: SessionRecord): Promise<void> {
  if (meta.get(s.id)?.thumb && s.status !== 'active') return;
  const shots = (await dbIndexAll<ScreenshotItem>('shots', 'sessionId', s.id)).sort((a, b) => a.ts - b.ts);
  const evs = await eventsOfSession<TimelineEvent>(s.id);
  const thumb: string | null = meta.get(s.id)?.thumb ?? (s.status === 'active' ? null : await sessionThumb(s.id));
  meta.set(s.id, { thumb, markers: evs.filter((x) => x.type === 'marker').length, shots: shots.length });
}

async function refreshSessions(): Promise<void> {
  sessions = (await dbGetAll<SessionRecord>('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  await Promise.all(sessions.slice(0, 5).map(loadMeta));
  if (state.sessionId || state.shotSessionId) shotCount = (await dbIndexAll<ScreenshotItem>('shots', 'sessionId', state.sessionId ?? state.shotSessionId!)).length;
  else shotCount = 0;
  draw();
}

async function detectCodecs(): Promise<void> {
  const out: string[] = [];
  for (const [name, codec] of [['VP9', 'vp09.00.10.08'], ['VP8', 'vp8'], ['H.264', 'avc1.42001f'], ['AV1', 'av01.0.04M.08']] as const) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 1_500_000, framerate: 15 });
      out.push(`${name}:${r.supported ? 'yes' : 'no'}`);
    } catch {
      out.push(`${name}:err`);
    }
  }
  codecInfo = out.join(' ');
}

/** Re-render only when something visible changed, so hover, focus and scroll are never disturbed by the 1 s poll. */
function draw(): void {
  const d = effectiveDisplay();
  const sig = JSON.stringify([policy, state, d.code, view, Math.floor((health?.ringSegments ?? 0)), notice?.at, sessions.map((s) => [s.id, s.status, s.endedAt]), [...meta.entries()].map(([k, v]) => [k, v.markers, v.shots, !!v.thumb]), shotCount, remembered, settings, view === 'settings' ? [health?.framesEncoded, swStarts] : 0, notice && Date.now() - notice.at < 9000]);
  if (sig !== lastSig) {
    lastSig = sig;
    render();
  }
  const t = document.querySelector('.timer');
  if (t && state.reproStartedAt && !state.terminal) t.textContent = formatClock(Date.now() - state.reproStartedAt);
  const dg = document.getElementById('diag');
  if (dg) dg.textContent = diagText();
}

async function poll(): Promise<void> {
  health = (await dbGet<HealthSnapshot>('journal', 'health')) ?? null;
  swStarts = ((await chrome.storage.session.get('swStarts')).swStarts as number) ?? 0;
  const est = await storageEstimate().catch(() => null);
  if (est) storageInfo = `${est.usageMB.toFixed(1)} MB used of ${est.quotaMB.toFixed(0)} MB quota, persisted=${est.persisted}`;
  if (state.targetOrigin) remembered = (await chrome.permissions.contains({ origins: [`${state.targetOrigin}/*`] }).catch(() => false)) || remembered;
  draw();
}

async function main(): Promise<void> {
  settings = await getSettings();
  policy = await getPolicy();
  onPolicyChanged(() => void Promise.all([getSettings(), getPolicy()]).then(([st, po]) => { settings = st; policy = po; lastSig = ''; draw(); }));
  const r = await chrome.storage.session.get(['state', 'notice']);
  state = (r.state as CaptureState) ?? initialState();
  notice = (r.notice as typeof notice) ?? null;
  await detectCodecs();
  await refreshSessions();
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.state) state = (changes.state.newValue as CaptureState) ?? initialState();
    if (changes.notice) notice = (changes.notice.newValue as typeof notice) ?? null;
    void refreshSessions();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) {
      settings = { ...settings, ...(c.settings.newValue as Settings) };
      draw();
    }
  });
  setInterval(() => void poll(), 1000);
  setInterval(() => void refreshSessions(), 5000);
  setInterval(() => draw(), 500);
}
void main();

import { collecting, displayState, initialState } from '../shared/state';
import { getSettings, saveSettings } from '../shared/settings';
import { formatClock } from '../shared/filename';
import { dbGet, dbGetAll } from '../storage/db';
import { storageEstimate } from '../storage/opfs';
import type { CommandMessage } from '../shared/messages';
import type { CaptureState, HealthSnapshot, SessionRecord, Settings } from '../shared/types';

const app = document.getElementById('app')!;
let state: CaptureState = initialState();
let settings: Settings;
let health: HealthSnapshot | null = null;
let notice: { text: string; level: string; at: number } | null = null;
let sessions: SessionRecord[] = [];
let codecInfo = '';
let storageInfo = '';
let remembered = false;

const GLYPH: Record<string, string> = {
  inactive: '○', armed: '◉', recording: '●', screenshot_only: '▣', privacy_paused: '⏸', manual_paused: '⏸', afk: '☾', target_ended: '■', error: '⚠',
};

const cmd = (c: CommandMessage['cmd'], payload?: Record<string, unknown>) => chrome.runtime.sendMessage({ kind: 'cmd', cmd: c, payload } satisfies CommandMessage);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The panel never trusts button state: if the capture pipeline stops reporting, it says so (spec PRIV-03 / State trust). */
function effectiveDisplay() {
  const d = displayState(state);
  if (collecting(state) && state.mode !== 'screenshot_only' && (!health || Date.now() - health.at > 6000) && state.armedAt && Date.now() - state.armedAt > 8000) {
    return { code: 'error' as const, label: 'ERROR / NOT RECORDING - no capture heartbeat', badge: 'ERR' };
  }
  return d;
}

function render(): void {
  const d = effectiveDisplay();
  const active = state.mode !== 'inactive';
  const term = !!state.terminal;
  const repro = state.mode === 'repro';
  const shot = state.mode === 'screenshot_only';
  const elapsed = state.reproStartedAt && !term ? formatClock(Date.now() - state.reproStartedAt) : '';
  const o = (v: string | number, cur: string | number) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`;
  const recovered = sessions.filter((s) => s.status === 'recovered' && !s.reviewedAt);
  app.innerHTML = `
  <h1>ReproDesk <span class="muted small">Phase 0 spike</span></h1>
  <div class="status" data-code="${d.code}" role="status" aria-live="polite">
    <span class="glyph" aria-hidden="true">${GLYPH[d.code]}</span><span class="label">${esc(d.label)}</span><span class="timer">${elapsed}</span>
  </div>
  ${state.reason && term ? `<div class="notice error">${esc(state.reason)}</div>` : ''}
  ${active ? `<div class="muted small" style="margin-top:6px">Target: <b>${esc(state.targetOrigin ?? '?')}</b>${state.mode === 'screenshot_only' ? ' (video off)' : ''}</div>` : '<p class="muted">Not armed. Open the approved web app, then <b>click the ReproDesk toolbar icon</b> on that tab to arm it. Chrome only allows tab capture after that explicit user action.</p>'}
  ${notice && Date.now() - notice.at < 9000 ? `<div class="notice ${notice.level}">${esc(notice.text)}</div>` : ''}
  ${state.afk && state.afkNeedsResume ? '<div class="notice warn">You were away. The Repro Session does not restart on its own.</div>' : ''}
  <div class="grid">
    ${term ? '<button class="wide" data-c="ackTerminal">Dismiss / re-arm later</button>' : ''}
    ${active && !term && !repro && !shot ? '<button data-c="saveReplay">Save Last Replay</button><button data-c="startRepro">Start Repro Session</button>' : ''}
    ${repro && !term ? '<button data-c="marker">Add Marker</button><button class="danger" data-c="finishRepro">Finish</button>' : ''}
    ${shot && !term ? (state.sessionId ? '<button class="danger wide" data-c="finishRepro">Finish screenshot session</button>' : '<button class="wide" data-c="startRepro">Start screenshot session</button>') : ''}
    ${active && !term ? '<button data-c="screenshot" class="secondary">Screenshot</button>' : ''}
    ${active && !term && !shot ? (state.manual ? '<button data-c="manualResume">Resume</button>' : '<button class="secondary" data-c="manualPause">Pause</button>') : ''}
    ${state.afk && state.afkNeedsResume ? '<button class="wide" data-c="resumeFromAfk">Resume recording</button>' : ''}
    ${active && !term && !repro && state.shotSessionId ? '<button class="secondary wide" data-c="finishShotSession">Finish screenshot collection &amp; open Review</button>' : ''}
    ${active && !repro ? '<button class="secondary wide" data-c="disarm">Disarm</button>' : ''}
  </div>
  ${active && !term && !remembered ? '<div class="row small"><span class="muted">Navigations may need host access to keep capturing.</span><button class="secondary" id="remember">Remember this site</button></div>' : ''}
  ${recovered.map((s) => `<div class="card"><b>Recovered Session</b> - recording ended unexpectedly. Last committed: ${s.lastCommittedAt ? new Date(s.lastCommittedAt).toLocaleTimeString() : 'n/a'}<div class="grid"><button data-review="${s.id}">Review</button><button class="secondary" data-del="${s.id}">Delete</button></div></div>`).join('')}
  <h2>Sessions</h2>
  ${sessions.length ? sessions.slice(0, 8).map((s) => `<div class="sess"><div class="meta"><b>${esc(s.kind)} - ${esc(s.status)}</b><span class="muted small">${new Date(s.startedAt).toLocaleString()}</span></div><button class="secondary" data-review="${s.id}">Review</button><button class="secondary" data-del="${s.id}" title="Delete">✕</button></div>`).join('') : '<p class="muted small">No saved sessions yet.</p>'}
  <details><summary>Target Profile &amp; settings</summary>
    <label>Instant Replay window (s)</label><select data-s="replaySec">${[30, 60, 90, 120].map((v) => o(v, settings.replaySec)).join('')}</select>
    <label>Post-trigger tail (s)</label><select data-s="tailSec">${[0, 3, 5, 10].map((v) => o(v, settings.tailSec)).join('')}</select>
    <label>Pre-session context (s)</label><select data-s="preSessionSec">${[0, 30].map((v) => o(v, settings.preSessionSec)).join('')}</select>
    <label>AFK after idle (min, 0 = AFK off; locked screen is immediate)</label><select data-s="afkMinutes">${[0, 5, 10, 15, 30].map((v) => o(v, settings.afkMinutes)).join('')}</select>
    <label>Frame rate</label><select data-s="fps">${[5, 10, 15, 24, 30].map((v) => o(v, settings.fps)).join('')}</select>
    <label>Bitrate (kbps)</label><select data-s="bitrateKbps">${[600, 1000, 1500, 2500, 4000].map((v) => o(v, settings.bitrateKbps)).join('')}</select>
    <label>Environment</label><input type="text" data-s="environment" value="${esc(settings.environment)}">
    <label>Extra approved origins (comma separated, semantic scope)</label><input type="text" data-s="approvedOrigins" value="${esc(settings.approvedOrigins.join(', '))}" placeholder="https://auth.example.com">
    <div class="row"><span>Marker auto-screenshot</span><input type="checkbox" data-sb="markerScreenshot" ${settings.markerScreenshot ? 'checked' : ''}></div>
    <div class="row"><span>Video capture (off = Screenshot-only, applies when arming)</span><input type="checkbox" data-sb="captureVideo" ${settings.captureVideo ? 'checked' : ''}></div>
    <div class="row"><span>Open Review after saving</span><input type="checkbox" data-sb="openReviewAfterSave" ${settings.openReviewAfterSave ? 'checked' : ''}></div>
    <p class="muted small">Shortcuts: Alt+Shift+R save replay, Alt+Shift+M marker, Alt+Shift+S screenshot, Alt+Shift+P start/finish session (change at chrome://extensions/shortcuts).</p>
  </details>
  <details><summary>Diagnostics (Phase 0 measurements)</summary>
    <pre class="diag" id="diag">${esc(diagText())}</pre>
    <div class="row"><button class="secondary" id="copydiag">Copy diagnostics JSON</button></div>
  </details>`;
  bind();
}

function diagText(): string {
  const h = health;
  return JSON.stringify(
    {
      state: displayState(state).label, mode: state.mode, privacy: state.privacy, manual: state.manual, afk: state.afk,
      health: h ? { ...h, ageMs: Date.now() - h.at, ringBytesMB: +(h.ringBytes / 1048576).toFixed(2), writtenMB: +(h.bytesWritten / 1048576).toFixed(2), fpsEncoded: undefined } : null,
      storage: storageInfo, encoders: codecInfo, chromeUA: navigator.userAgent,
    },
    null,
    2,
  );
}

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => (b.onclick = () => void cmd(b.dataset.c as CommandMessage['cmd'])));
  app.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((b) => (b.onclick = () => void cmd('openReview', { sessionId: b.dataset.review })));
  app.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => (b.onclick = async () => {
    if (confirm('Delete this session and its evidence from this browser?')) {
      await chrome.runtime.sendMessage({ kind: 'delete-session', id: b.dataset.del });
      await refreshSessions();
    }
  }));
  app.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-s]').forEach((el) => (el.onchange = async () => {
    const k = el.dataset.s as keyof Settings;
    const raw = el.value;
    const val = k === 'approvedOrigins' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : k === 'environment' ? raw : Number(raw);
    settings = await saveSettings({ [k]: val } as Partial<Settings>);
  }));
  app.querySelectorAll<HTMLInputElement>('[data-sb]').forEach((el) => (el.onchange = async () => {
    settings = await saveSettings({ [el.dataset.sb as string]: el.checked } as Partial<Settings>);
  }));
  const rem = document.getElementById('remember');
  if (rem) rem.onclick = async () => {
    if (!state.targetOrigin) return;
    const ok = await chrome.permissions.request({ origins: [`${state.targetOrigin}/*`] });
    if (ok) {
      await cmd('siteRemembered', { origin: state.targetOrigin });
      remembered = true;
      render();
    }
  };
  const cd = document.getElementById('copydiag');
  if (cd) cd.onclick = () => void navigator.clipboard.writeText(diagText());
}

async function refreshSessions(): Promise<void> {
  sessions = (await dbGetAll<SessionRecord>('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  render();
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

async function poll(): Promise<void> {
  health = (await dbGet<HealthSnapshot>('journal', 'health')) ?? null;
  const est = await storageEstimate().catch(() => null);
  if (est) storageInfo = `${est.usageMB.toFixed(1)} MB used of ${est.quotaMB.toFixed(0)} MB quota, persisted=${est.persisted}`;
  if (state.targetOrigin) remembered = (await chrome.permissions.contains({ origins: [`${state.targetOrigin}/*`] }).catch(() => false)) || remembered;
  if (!document.querySelector('details[open]') ) render();
  else {
    const el = document.getElementById('diag');
    if (el) el.textContent = diagText();
    const t = document.querySelector('.timer');
    if (t && state.reproStartedAt) t.textContent = formatClock(Date.now() - state.reproStartedAt);
  }
}

async function main(): Promise<void> {
  settings = await getSettings();
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
    if (area === 'local' && c.settings) settings = { ...settings, ...(c.settings.newValue as Settings) };
  });
  setInterval(() => void poll(), 1000);
  setInterval(() => void refreshSessions(), 5000);
}
void main();

// Presentation rig: real headed Chromium under Xvfb, genuine toolbar click, scripted use of the Northwind Gear demo shop (two deliberate bugs).
// Produces the screenshots in docs/demo/. (The walkthrough videos come from scripts/film.mjs; --video here only makes a rough, uncaptioned screen capture.)
//   node scripts/shoot.mjs [--video] [--only=panel|review]
import { startDisplay, launchChrome, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, shot, keyInfo, browserCdp, exportZip, DISPLAY } from '../tests/real/lib.mjs';
import { makeProbe } from '../tests/real/probe.mjs';
import { startDemoSite } from './demo-site.mjs';
import path from 'node:path';
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/demo');
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.png')) rmSync(path.join(out, f)); // regenerate the whole set, no stale numbering
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 5173);
const W = 1500, H = 940;
const withVideo = process.argv.includes('--video');
const site = await startDemoSite(SITE);
const disp = await startDisplay('1600x1000x24');
const ud = tmpProfile();
const chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/`, width: W, height: H });
const S = (n) => { const f = path.join(out, n); shot(f); execFileSync('convert', [f, '-crop', `${W}x${H}+0+0`, '+repage', f]); console.log('shot', n); };
let rec = null;
const type = async (page, sel, text) => { await realClick(page, sel); xdo('type', '--delay', '55', text); await sleep(250); };
try {
  await sleep(3500);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 90, tailSec: 3, preSessionSec: 30, fps: 15, bitrateKbps: 2500, afkMinutes: 0, openReviewAfterSave: false, environment: 'QA · staging', markerScreenshot: true });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  if (withVideo) rec = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'x11grab', '-framerate', '25', '-video_size', `${W}x${H}`, '-i', `${DISPLAY}.0+0,0`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', path.join(out, 'demo-run.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
  await sleep(800);
  S('01-ready.png');
  await clickToolbarIcon();
  await probe.until(async () => (await probe.state())?.mode === 'armed', 10000);
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  const click = (c) => panel.eval(`document.querySelector('[data-c="${c}"]').click()`);
  const view = (v) => panel.eval(`document.querySelector('[data-nav="${v}"]').click()`);
  await sleep(1800);
  // browse like a user, while the rolling buffer fills
  await realClick(page, '[data-add="backpack"]'); await sleep(700);
  await realClick(page, '[data-add="tent"]'); await sleep(700);
  await realClick(page, '[data-add="lamp"]'); await sleep(2200);
  for (let i = 0; i < 6; i++) { xdo('click', '5'); await sleep(150); }
  await sleep(14000); // let the buffer fill up
  S('02-armed.png');
  // Instant Replay: "I just saw something odd" -> save the last replay
  await click('saveReplay'); await sleep(4500);
  S('03-replay-saved.png');
  // Repro Session
  await realClick(page, '#nav-cart'); await sleep(1200);
  await click('startRepro'); await sleep(2500);
  await type(page, '#promo', 'summer20'); await realClick(page, '#apply'); await sleep(1500);
  const label = (t) => panel.eval(`(() => { const i = document.getElementById('markerLabel'); i.focus(); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await label('Promo discount not applied to total'); await sleep(700);
  S('04-recording.png');
  await click('marker'); await sleep(2800);
  await realClick(page, '#checkout-btn'); await sleep(1500);
  await type(page, '#name', 'Alex Morgan'); await type(page, '#email', 'alex@example.com'); await type(page, '#card', '4242424242424242'); await type(page, '#exp', '1228'); await type(page, '#cvv', '123');
  await realClick(page, '#place'); await sleep(2600);
  // where the card field and the error sit, normalised to the viewport (= the captured frame), for the redaction scenes below
  const boxes = await page.eval(`(() => { const n = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x / innerWidth, r.y / innerHeight, (r.x + r.width) / innerWidth, (r.y + r.height) / innerHeight]; }; return { card: n('#card'), err: n('#error .err') }; })()`);
  await label('Order fails with E-4021'); await sleep(500); await click('marker'); await sleep(3000);
  S('05-bug-captured.png');
  // Privacy Pause: the tester glances at another tab
  const b = await browserCdp(PORT); const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' }); await sleep(2500);
  S('06-privacy-pause.png');
  await b.send('Target.closeTarget', { targetId });
  const fix = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${SITE}/`));
  await b.send('Target.activateTarget', { targetId: fix.id }); b.close(); await sleep(2500);
  await click('finishRepro'); await sleep(3500);
  S('07-sessions.png');
  await view('settings'); await sleep(900); S('08-settings.png'); await panel.eval(`document.getElementById('load-sample').scrollIntoView({ block: 'center' })`); await sleep(500); S('08b-sample-data.png'); await view('main'); await sleep(500);
  const sessions = await probe.dump('sessions');
  const repro = sessions.find((s) => s.kind === 'repro');
  const instant = sessions.find((s) => s.kind === 'instant');
  console.log('sessions', sessions.map((s) => s.kind + ':' + s.status).join(' '));
  // Review page (close the side panel first, like a presenter would)
  if (repro) {
    xdo('mousemove', '1472', '101'); await sleep(200); xdo('click', '1'); await sleep(800);
    const cdp = await browserCdp(PORT);
    await cdp.send('Target.createTarget', { url: `chrome-extension://${keyInfo.id}/review.html?session=${repro.id}` });
    cdp.close(); await sleep(5000);
    const rv = await findPage(PORT, `chrome-extension://${keyInfo.id}/review.html?session=`);
    // play the video a little so the live timeline highlight shows
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.muted = true; v.currentTime = 9; return v.play(); })()`).catch(() => undefined);
    await sleep(2500);
    S('09-review.png');
    await rv.eval(`window.scrollTo(0, 760)`); await sleep(700); S('10-review-lower.png');
    await rv.eval(`window.scrollTo(0, 0)`);

    // ---- privacy: hide the card number in a screenshot (editor) and in the video (privacy tools) before anything is exported
    const drag = async (pg, a, b) => {
      const ev = (type, x, y) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
      await ev('mouseMoved', a[0], a[1]); await ev('mousePressed', a[0], a[1]);
      for (let i = 1; i <= 10; i++) { await ev('mouseMoved', a[0] + ((b[0] - a[0]) * i) / 10, a[1] + ((b[1] - a[1]) * i) / 10); await sleep(25); }
      await ev('mouseReleased', b[0], b[1]);
    };
    const rectOf = (sel) => rv.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const pad = 0.012;
    // screenshot editor on the screenshot taken after the failed order (Marker 2): blur the card, ring the error
    await rv.eval(`document.querySelector('[data-edit="1"]').click()`); await sleep(1200);
    let c = await rectOf('#ed-canvas');
    const at = (r, fx, fy) => [r.x + r.w * fx, r.y + r.h * fy];
    await rv.eval(`document.querySelector('[data-tool="blur"]').click()`);
    await drag(rv, at(c, boxes.card[0] - pad, boxes.card[1] - pad * 1.4), at(c, boxes.card[2] + pad, boxes.card[3] + pad * 1.4));
    await rv.eval(`document.querySelector('[data-tool="rect"]').click()`);
    await drag(rv, at(c, boxes.err[0] - pad, boxes.err[1] - pad), at(c, boxes.err[2] + pad, boxes.err[3] + pad));
    await sleep(500); S('11-editor.png');
    await rv.eval(`document.getElementById('ed-save').click()`); await sleep(1200);
    // privacy tools on the replay: blur the card field for the whole recording
    await rv.eval(`window.scrollTo(0, 0)`); await sleep(300);
    await rv.eval(`document.getElementById('pt-mask').click()`); await sleep(500);
    const vr = await rv.eval(`(() => { const v = document.getElementById('vid'); v.scrollIntoView({ block: 'center' }); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight, dur: v.duration }; })()`);
    await sleep(400);
    const vr2 = await rv.eval(`(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
    const ar = vr.vw / vr.vh; let cw = vr.w, ch = vr.h; if (vr.w / vr.h > ar) cw = vr.h * ar; else ch = vr.w / ar;
    const vc = { x: vr2.x + (vr.w - cw) / 2, y: vr2.y + (vr.h - ch) / 2, w: cw, h: ch };
    await drag(rv, at(vc, boxes.card[0] - pad / 2, boxes.card[1] - pad), at(vc, boxes.card[2] + pad / 2, boxes.card[3] + pad));
    await sleep(500);
    await rv.eval(`(() => { document.getElementById('pt-from').value = '0:00'; document.getElementById('pt-to').value = '59:00'; document.getElementById('pt-add').click(); })()`); await sleep(800);
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = Math.max(0, v.duration - 5.5); })()`); await sleep(1200);
    S('12-video-privacy.png');
    await rv.eval(`document.getElementById('pt-preview').click()`);
    for (let i = 0; i < 120; i++) { if (await rv.eval(`!!document.querySelector('#pt-form .badge')`)) break; await sleep(500); }
    await sleep(800);
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = Math.max(0, v.duration - 5.5); })()`); await sleep(1500);
    S('13-redacted-preview.png');
    await rv.eval(`document.getElementById('pt-preview').click()`); await sleep(600);
    await rv.eval(`window.scrollTo(0, 0)`);
    const zipFile = await exportZip(PORT, repro.id, path.join(out, '.dlz'), 'zip');
    if (zipFile) {
      const z = unzipSync(new Uint8Array(readFileSync(zipFile)));
      const tmpWebm = path.join(out, '.dlz', 'replay.webm');
      writeFileSync(tmpWebm, z['replay.webm']);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-sseof', '-5.5', '-i', tmpWebm, '-frames:v', '1', path.join(out, '14-redacted-export-frame.png')]);
      console.log('shot 14-redacted-export-frame.png (frame from the exported replay.webm)');
    }
    await rv.eval(`document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = ['zip','html','docx'].includes(c.dataset.fmt)))`); await sleep(300);
    await rv.eval(`window.scrollTo(0, 1500)`); await sleep(500); S('15-review-export.png');
    const htmlFile = await exportZip(PORT, repro.id, path.join(out, '.dl'), 'html');
    if (htmlFile) {
      const c2 = await browserCdp(PORT);
      await c2.send('Target.createTarget', { url: 'file://' + htmlFile }); c2.close(); await sleep(2500);
      S('16-exported-report.png');
      const rp = await findPage(PORT, 'file://');
      await rp?.eval(`window.scrollTo(0, 650)`); await sleep(600); S('17-exported-report-2.png');
    }
    const c3 = await browserCdp(PORT);
    await c3.send('Target.createTarget', { url: `chrome-extension://${keyInfo.id}/review.html` }); c3.close(); await sleep(3000);
    S('18-all-sessions.png');
  }
  if (instant) console.log('instant session', instant.id);
} finally {
  if (rec) { rec.stdin.write('q'); await sleep(2500); rec.kill('SIGINT'); await sleep(800); }
  await chrome.close(); disp.stop(); site.close(); rmProfile(ud);
}

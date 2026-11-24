// Demo driver: node demo.mjs <name> <query> <seconds> [desktop|gpu|sw]
// Launches the patched Chrome (desktop Wayland window on the HYPR_OUT output, or
// headless), opens /demo.html?<query> in the IWA app window, waits until all
// tracks deliver, then records <seconds> of video:
//   desktop: grim screenshots of the HYPR_OUT output piped into ffmpeg (H.264)
//   headless: CDP Page.startScreencast of the app window into ffmpeg
// and saves stills + the readout to demo/.
import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {IWA_PORT, launch, evaluate, shutdown, sleep} from './lib.mjs';
import {iwaOriginFromProfile} from './lib.mjs';

const [name, query, secondsStr, mode = 'desktop'] = process.argv.slice(2);
const SECONDS = Number(secondsStr || 20);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'demo');
fs.mkdirSync(OUT, {recursive: true});
const logFile = path.join(OUT, `${name}.chrome.log`);
fs.writeFileSync(logFile, '');
const WENV = {...process.env, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-1'};
const grimOutput = () => (process.env.HYPR_OUT ? ['-o', process.env.HYPR_OUT] : []);
requireEnv();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const b = await launch(CHROME_BIN,
    `${PROFILE_DIR}/capture/demo-${name}`, logFile, mode,
    [`--install-isolated-web-app-from-url=http://127.0.0.1:${IWA_PORT}/`,
     '--js-flags=--expose-gc', 'about:blank']);
let m;
for (let i = 0; i < 240; i++) {
  const log = fs.readFileSync(logFile, 'utf8');
  m = log.match(/Install result of IWA ([a-z0-9]+):/);
  if (m) break;
  if (/command line installation successful/.test(log)) {
    const o = iwaOriginFromProfile(b.userDataDir);
    if (o) { m = [o, o.slice('isolated-app://'.length)]; break; }
  }
  await sleep(250);
}
if (!m) throw new Error('IWA not installed');
const origin = 'isolated-app://' + m[1];
const {targetId} = await b.cdp.send('Target.createTarget',
    {url: `${origin}/${process.env.PAGE || 'demo.html'}?${query}`, newWindow: true});
const {sessionId: s} = await b.cdp.send('Target.attachToTarget', {targetId, flatten: true});
// Close the initial about:blank browser window so only the app window shows.
for (const t of (await b.cdp.send('Target.getTargets')).targetInfos) {
  if (t.type === 'page' && t.url === 'about:blank') {
    await b.cdp.send('Target.closeTarget', {targetId: t.targetId}).catch(() => {});
  }
}
const ev = (e, ms) => evaluate(b.cdp, s, e, ms);
// Do not evaluate before the app document commits: Runtime.evaluate on a
// provisional frame hits a DevTools DCHECK in this build.
for (let i = 0; i < 300; i++) {
  const {targetInfo} = await b.cdp.send('Target.getTargetInfo', {targetId});
  if (targetInfo.url.includes('/' + (process.env.PAGE || 'demo.html'))) break;
  await sleep(200);
}
await sleep(1000);
const {windowId} = await b.cdp.send('Browser.getWindowForTarget', {targetId});
if (mode !== 'desktop') {
  await b.cdp.send('Browser.setWindowBounds', {windowId,
      bounds: {left: 0, top: 0, width: 2000, height: 1300}})
      .catch((e) => log('setWindowBounds failed', String(e)));
  log('window bounds', JSON.stringify(await b.cdp.send('Browser.getWindowBounds', {windowId})));
  // The headless app window's view did not follow its bounds (1912x593,
  // 1912x934, ...); Browser.setContentsSize sets the view itself.
  for (let i = 0; i < 3; i++) {
    await sleep(500);
    await b.cdp.send('Browser.setContentsSize', {windowId, width: 1920, height: 1080});
    await sleep(500);
    const vp = await ev('innerWidth + "x" + innerHeight').catch(() => '?');
    log('viewport after setContentsSize', vp);
    if (vp === '1920x1080') break;
  }
}
// Wait for the scene.
for (let i = 0; i < 600; i++) {
  const ok = await ev('!!(window.demoState && demoState.ready && demoState.trackFps && demoState.cards.filter(c => c.frames > 0).length === demoState.n)').catch(() => false);
  if (ok) break;
  await sleep(500);
}
await sleep(Number(process.env.SETTLE_MS || 2000));
const info = JSON.parse(await ev(`JSON.stringify({vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    gl: demoState.glRenderer, n: demoState.n, errors: demoState.errors})`));
log('scene ready', JSON.stringify(info));
await ev('typeof restartScript === "function" && restartScript(); 1');

const mp4 = path.join(OUT, `${name}.mp4`);
const readouts = [];
const stillTimes = (process.env.STILLS || '3,9,15').split(',').map(Number);
let stills = 0;
const t0 = Date.now();
const readoutTimer = setInterval(async () => {
  try {
    readouts.push(JSON.parse(await ev(`JSON.stringify({t: ${'Date.now()'}, mode: demoState.mode,
        caption: demoState.caption, sceneFps: demoState.sceneFps, trackFps: demoState.trackFps,
        size: demoState.cards[0] && demoState.cards[0].size,
        format: demoState.cards[0] && demoState.cards[0].format,
        text: document.getElementById('readout').textContent})`)));
  } catch {}
}, 1000);

if (mode === 'desktop' && process.env.OZONE === 'x11') {
  // Real X11 window (Xwayland): record the whole browser window, including
  // browser UI such as infobars, with ffmpeg x11grab; stills with `import`.
  const XENV = {...process.env, DISPLAY: ':0'};
  const ids = execFileSync('xprop', ['-root', '_NET_CLIENT_LIST'], {env: XENV}).toString()
      .match(/0x[0-9a-f]+/g) || [];
  let win = null;
  for (const id of ids) {
    const pid = execFileSync('xprop', ['-id', id, '_NET_WM_PID'], {env: XENV}).toString();
    if (pid.includes(String(b.child.pid))) win = id;
  }
  log('x11 window', win);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-window_id', win,
      '-framerate', '30', '-t', String(SECONDS), '-i', ':0', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', mp4], {env: XENV, stdio: ['ignore', 'inherit', 'inherit']});
  while (Date.now() - t0 < SECONDS * 1000) {
    const el = (Date.now() - t0) / 1000;
    if (stills < stillTimes.length && el >= stillTimes[stills]) {
      execFileSync('import', ['-window', win, path.join(OUT, `${name}_still${stills + 1}.png`)], {env: XENV});
      stills++;
    }
    await sleep(100);
  }
  await new Promise((r) => ff.on('close', r));
  fs.writeFileSync(path.join(OUT, `${name}.recording.json`),
      JSON.stringify({method: 'ffmpeg x11grab (30 fps) of the Chrome X11 window (Xwayland :0) on a temporary headless Hyprland output', window: win}, null, 1));
} else if (mode === 'desktop' && process.env.REC === 'grim') {
  // grim -> ppm frames -> ffmpeg; frame times recorded, video at the achieved rate.
  const framesDir = path.join(OUT, `${name}_frames`);
  fs.rmSync(framesDir, {recursive: true, force: true});
  fs.mkdirSync(framesDir);
  let k = 0;
  const times = [];
  while (Date.now() - t0 < SECONDS * 1000) {
    const f = path.join(framesDir, String(k).padStart(5, '0') + '.ppm');
    execFileSync('grim', [...grimOutput(), '-t', 'ppm', f], {env: WENV});
    times.push(Date.now() - t0);
    k++;
    const el = (Date.now() - t0) / 1000;
    if (stills < stillTimes.length && el >= stillTimes[stills]) {
      execFileSync('grim', [...grimOutput(), '-t', 'png',
          path.join(OUT, `${name}_still${stills + 1}.png`)], {env: WENV});
      stills++;
    }
  }
  const fps = k / ((times[times.length - 1] || 1) / 1000);
  log('grabbed', k, 'frames, capture rate', fps.toFixed(1));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps.toFixed(3),
      '-i', path.join(framesDir, '%05d.ppm'), '-c:v', 'libx264', '-preset', 'medium',
      '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart', mp4]);
  fs.rmSync(framesDir, {recursive: true, force: true});
  fs.writeFileSync(path.join(OUT, `${name}.recording.json`),
      JSON.stringify({method: 'grim screenshots of the Hyprland output piped to ffmpeg',
                      frames: k, captureFps: fps}, null, 1));
} else {
  // Headless: CDP screencast of the app window.
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe',
      '-use_wallclock_as_timestamps', '1', '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'vfr', '-movflags', '+faststart', mp4], {stdio: ['pipe', 'inherit', 'inherit']});
  let k = 0;
  b.cdp.on((msg) => {
    if (msg.method !== 'Page.screencastFrame' || msg.sessionId !== s) return;
    b.cdp.send('Page.screencastFrameAck', {sessionId: msg.params.sessionId}, s).catch(() => {});
    ff.stdin.write(Buffer.from(msg.params.data, 'base64'));
    k++;
  });
  await b.cdp.send('Page.startScreencast', {format: 'jpeg', quality: 85}, s);
  while (Date.now() - t0 < SECONDS * 1000) {
    const el = (Date.now() - t0) / 1000;
    if (stills < stillTimes.length && el >= stillTimes[stills]) {
      if (mode === 'desktop') {
        execFileSync('grim', [...grimOutput(), '-t', 'png',
            path.join(OUT, `${name}_still${stills + 1}.png`)], {env: WENV});
      } else {
        const {data: png} = await b.cdp.send('Page.captureScreenshot', {format: 'png'}, s);
        fs.writeFileSync(path.join(OUT, `${name}_still${stills + 1}.png`), Buffer.from(png, 'base64'));
      }
      stills++;
    }
    await sleep(50);
  }
  await b.cdp.send('Page.stopScreencast', {}, s).catch(() => {});
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  fs.writeFileSync(path.join(OUT, `${name}.recording.json`),
      JSON.stringify({method: 'CDP Page.startScreencast (JPEG q85) of the headless app window (view set to 1920x1080 with Browser.setContentsSize) piped to ffmpeg',
                      frames: k, captureFps: k / SECONDS}, null, 1));
}
clearInterval(readoutTimer);
fs.writeFileSync(path.join(OUT, `${name}.readout.json`), JSON.stringify({info, readouts}, null, 1));
log('last readout:\n' + (readouts[readouts.length - 1] || {}).text);
await shutdown(b);
const dlog = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /DCHECK|Check failed|FATAL/.test(l));
log('dcheck/fatal lines', dlog.length, dlog.slice(0, 3).join('\n'));

// Capture experiments: node harness.mjs <label> <chromeBin> <phases> [sw|gpu]
// Phases: A (content), N (negative/ownership), B (visibility), C (constraints),
// D (8 guests), E (consumption), F (cost), L (latency), H (destruction).
// Raw JSON -> raw/<label>-<phase>.json, Chrome log -> raw/<label>-<phase>.chrome.log
import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  IWA_PORT, GUEST_BASE, launch, evaluate, getTargets, cpuSnapshot, selfTicks,
  median, pct, shutdown, sleep,
} from './lib.mjs';
requireEnv({needBinary: false});

const [label, chromeBinArg, phases = 'A', gpuMode = 'sw'] = process.argv.slice(2);
const chromeBin = chromeBinArg || CHROME_BIN;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const RAW = path.join(HERE, 'raw');
fs.mkdirSync(RAW, {recursive: true});
const PROFILES = path.join(PROFILE_DIR, 'capture');

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
const J = (x) => JSON.stringify(x);

let seq = 0;
const gurl = (mode, extra = '') => `${GUEST_BASE}?mode=${mode}&id=${++seq}${extra}`;

async function waitForLog(file, re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = fs.readFileSync(file, 'utf8').match(re);
    if (m) return m;
    await sleep(250);
  }
  return null;
}

async function setup(phase, extraArgs = []) {
  const udd = path.join(PROFILES, `${label}-${phase}`);
  const logFile = path.join(RAW, `${label}-${phase}.chrome.log`);
  fs.writeFileSync(logFile, '');
  const b = await launch(chromeBin, udd, logFile, gpuMode,
      [`--install-isolated-web-app-from-url=http://127.0.0.1:${IWA_PORT}/`,
       ...extraArgs, 'about:blank']);
  const ok = await waitForLog(logFile,
      /Isolated Web App command line installation (successful|failed)[^\n]*/, 60000);
  if (!ok || ok[1] !== 'successful') {
    await shutdown(b);
    throw new Error('IWA install: ' + (ok ? ok[0] : 'no result in 60s'));
  }
  const idm = await waitForLog(logFile, /Install result of IWA ([a-z0-9]+):/, 5000);
  b.origin = 'isolated-app://' + idm[1];
  await openApp(b);
  return b;
}

async function openApp(b) {
  const {targetId} = await b.cdp.send('Target.createTarget',
      {url: b.origin + '/', newWindow: true});
  const {sessionId} = await b.cdp.send('Target.attachToTarget',
      {targetId, flatten: true});
  b.appTarget = targetId;
  b.s = sessionId;
  await b.cdp.send('Page.enable', {}, sessionId);
  await b.cdp.send('Runtime.enable', {}, sessionId);
  for (let i = 0; i < 100; i++) {
    const ok = await evaluate(b.cdp, b.s, 'typeof window.capture === "function" ' +
        '&& document.readyState === "complete"').catch(() => false);
    if (ok) break;
    await sleep(100);
  }
  // Collect console messages of the app for debugging.
  b.console = [];
  b.cdp.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.sessionId === b.s) {
      b.console.push(m.params.args.map((a) => a.value).join(' '));
    }
  });
}

const ev = (b, expr, ms) => evaluate(b.cdp, b.s, expr, ms);
const evj = async (b, expr, ms) => JSON.parse(await ev(b, expr, ms));

async function createFrames(b, n, mode, w, h, extra = '') {
  const urls = [];
  for (let i = 0; i < n; i++) {
    const u = gurl(mode, extra);
    urls.push(u);
    await ev(b, `createFrame(${i}, ${J(u)}, ${w}, ${h})`);
  }
  return urls;
}

// CDP session for the guest whose URL is `url`.
async function guestSession(b, url) {
  for (let i = 0; i < 50; i++) {
    const t = (await getTargets(b.cdp)).find((x) => x.url === url);
    if (t) {
      const {sessionId} = await b.cdp.send('Target.attachToTarget',
          {targetId: t.targetId, flatten: true});
      return {sessionId, targetId: t.targetId, type: t.type};
    }
    await sleep(100);
  }
  throw new Error('no guest target for ' + url);
}

async function guestInfo(b, gs) {
  return JSON.parse(await evaluate(b.cdp, gs.sessionId, `JSON.stringify({
      vis: document.visibilityState, w: innerWidth, h: innerHeight,
      dpr: devicePixelRatio, frames: guestFrames()})`, 10000));
}

// ---- Screencast helpers (CDP Page.startScreencast on the guest target, the
// harness forwards every frame to the app, which decodes it).
async function appWindowObject(b) {
  const r = await b.cdp.send('Runtime.evaluate', {expression: 'window'}, b.s);
  return r.result.objectId;
}
async function startScreencast(b, id, gs, opts, latency) {
  await ev(b, `scStart(${id}, ${!!latency})`);
  if (!b.winObj) b.winObj = await appWindowObject(b);
  const meta = {frames: 0, sizes: {}, deviceSizes: {}};
  const off = b.cdp.on((m) => {
    if (m.method !== 'Page.screencastFrame' || m.sessionId !== gs.sessionId) return;
    meta.frames++;
    const md = m.params.metadata;
    const k = `${md.deviceWidth}x${md.deviceHeight}`;
    meta.deviceSizes[k] = (meta.deviceSizes[k] || 0) + 1;
    b.cdp.send('Page.screencastFrameAck', {sessionId: m.params.sessionId},
               gs.sessionId).catch(() => {});
    b.cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function(id, d) { scFrame(id, d); }',
      objectId: b.winObj,
      arguments: [{value: id}, {value: m.params.data}],
    }, b.s).catch(() => {});
  });
  await b.cdp.send('Page.startScreencast', {format: 'jpeg', quality: 72,
      ...opts}, gs.sessionId);
  return {meta, stop: async () => {
    off();
    await b.cdp.send('Page.stopScreencast', {}, gs.sessionId).catch(() => {});
  }};
}

// ---- CPU per process role.
// Roles are found by burning ~300 ms of CPU in a known renderer.
async function identifyRenderer(b, sessionId) {
  const before = cpuSnapshot(b.child.pid);
  await evaluate(b.cdp, sessionId,
      '(() => { const e = performance.now() + 400; while (performance.now() < e); })()');
  const after = cpuSnapshot(b.child.pid);
  let best = null, bestD = 0;
  for (const pid in after) {
    if (after[pid].type !== 'renderer' || !before[pid]) continue;
    const d = after[pid].ticks - before[pid].ticks;
    if (d > bestD) { bestD = d; best = Number(pid); }
  }
  return best;
}

function cpuDelta(before, after, roles, seconds, nodeTicks) {
  const out = {};
  for (const pid in after) {
    if (!before[pid]) continue;
    const d = (after[pid].ticks - before[pid].ticks) / 100;  // seconds
    let role = roles[pid] || after[pid].type;
    out[role] = (out[role] || 0) + d;
  }
  for (const k in out) out[k] = +(100 * out[k] / seconds).toFixed(1);
  if (nodeTicks !== undefined) out['client(node)'] = +(100 * nodeTicks / 100 / seconds).toFixed(1);
  out.total = +Object.entries(out).filter(([k]) => k !== 'client(node)')
      .reduce((a, [, v]) => a + v, 0).toFixed(1);
  return out;
}

// ---------------------------------------------------------------- Phase A
async function phaseA(b) {
  const res = {};
  const [u] = await createFrames(b, 1, 'quad', 640, 360);
  res.capture = await evj(b, 'capture(0, {})');
  log('capture', J(res.capture));
  if (!res.capture.ok) return res;
  await sleep(1000);
  res.stats = await evj(b, 'stats(0)');
  res.video = await evj(b, 'checkVideo(0)');
  log('video', J(res.video));
  res.videoFrame = await evj(b, 'checkVideoFrame(0)');
  log('videoFrame', J(res.videoFrame));
  // Constraint equal to the layout size.
  res.capture2 = await evj(b, 'stopCapture(0), capture(0, {maxWidth: 640, maxHeight: 360})');
  await sleep(1000);
  res.video2 = await evj(b, 'checkVideo(0)');
  res.videoFrame2 = await evj(b, 'checkVideoFrame(0)');
  log('video2', J(res.video2), 'vf2', J(res.videoFrame2));
  return res;
}

// ------------------------------------------------- Phase N: ownership checks
async function phaseN(b) {
  const res = {};
  await createFrames(b, 1, 'quad', 320, 180);
  // Intercept the id: the element calls navigator.mediaDevices.getUserMedia in
  // the page's world, so the app can see its own id.
  await ev(b, `window.realGUM = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.lastConstraints = c;
      return Promise.reject(new Error('intercepted')); }; 'ok'`);
  res.intercept = await evj(b, 'capture(0, {})');
  const id = await ev(b, 'lastConstraints.video.mandatory.chromeMediaSourceId');
  res.idLength = id.length;
  await ev(b, 'navigator.mediaDevices.getUserMedia = realGUM; "ok"');
  const gum = (sid) => `navigator.mediaDevices.getUserMedia({video: {mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: ${J(id)}}}})
      .then(s => 'OK ' + s.getVideoTracks()[0].label, e => 'ERR ' + e.name + ': ' + e.message)`;
  // 1. Another origin (plain http tab) using the id.
  const {targetId: t2} = await b.cdp.send('Target.createTarget',
      {url: `http://127.0.0.1:8712/guest.html?mode=solid&c=00ffff`});
  const {sessionId: s2} = await b.cdp.send('Target.attachToTarget',
      {targetId: t2, flatten: true});
  await sleep(1000);
  res.otherOriginTab = await evaluate(b.cdp, s2, gum());
  // 2. A second window of the same app (same origin, different frame).
  const {targetId: t3} = await b.cdp.send('Target.createTarget',
      {url: b.origin + '/', newWindow: true});
  const {sessionId: s3} = await b.cdp.send('Target.attachToTarget',
      {targetId: t3, flatten: true});
  await sleep(1500);
  res.sameAppOtherWindow = await evaluate(b.cdp, s3, gum());
  // 3. The guest itself.
  const gs = await guestSession(b, (await getTargets(b.cdp)).find(
      (t) => t.type === 'webview')?.url);
  res.guestItself = await evaluate(b.cdp, gs.sessionId, gum());
  // 4. The owner, after the others tried (id is single-use: the registry
  // drops it on a matching request only).
  res.ownerAfter = await ev(b, gum());
  // 5. Owner again with the same id (single use).
  res.ownerReuse = await ev(b, gum());
  // 6. The second app window trying to capture a guest it does not own
  // through the element API with a forged instance id is not possible from
  // page JS (webViewInternal is not exposed); covered by the browser test.
  log('N', J(res));
  return res;
}

// ------------------------------------------------- Phase B: visibility
const STATES = [
  ['visible', ''],
  ['opacity:0', 'opacity: 0'],
  ['scale(0.05)', 'transform: scale(0.05); transform-origin: 0 0'],
  ['half scrolled out (top 180px of 360 off-screen)', 'SCROLLHALF'],
  ['just scrolled out (element 40px above viewport)', 'SCROLLJUST'],
  ['scrolled out', 'SCROLL'],
  ['visibility:hidden', 'visibility: hidden'],
  ['display:none', 'display: none'],
  ['other window active', 'OTHERWIN'],
  ['app window minimized', 'MINIMIZE'],
];
async function applyState(b, st) {
  if (st === '') return;
  if (st === 'SCROLL') return ev(b, 'scrollTo_(3000)');
  if (st === 'SCROLLHALF') return ev(b, 'scrollTo_(180)');
  if (st === 'SCROLLJUST') return ev(b, 'scrollTo_(400)');
  if (st === 'OTHERWIN') {
    const {targetId} = await b.cdp.send('Target.createTarget',
        {url: 'about:blank', newWindow: true});
    await b.cdp.send('Target.activateTarget', {targetId});
    b.otherWin = targetId;
    return;
  }
  if (st === 'MINIMIZE') {
    const {windowId} = await b.cdp.send('Browser.getWindowForTarget',
        {targetId: b.appTarget});
    await b.cdp.send('Browser.setWindowBounds', {windowId,
        bounds: {windowState: 'minimized'}});
    return;
  }
  return ev(b, `setStyle(0, ${J(st)})`);
}
async function resetState(b, st) {
  if (st.startsWith('SCROLL')) return ev(b, 'scrollTo_(0)');
  if (st === 'OTHERWIN') {
    await b.cdp.send('Target.closeTarget', {targetId: b.otherWin});
    await b.cdp.send('Target.activateTarget', {targetId: b.appTarget});
    return;
  }
  if (st === 'MINIMIZE') {
    const {windowId} = await b.cdp.send('Browser.getWindowForTarget',
        {targetId: b.appTarget});
    await b.cdp.send('Browser.setWindowBounds', {windowId,
        bounds: {windowState: 'normal'}});
    return;
  }
  return ev(b, `frames.get(0).el.style.cssText = 'width:640px;height:360px'; 'ok'`);
}

async function phaseB(b) {
  const rows = [];
  const [u] = await createFrames(b, 1, 'anim', 640, 360);
  const gs = await guestSession(b, u);
  const W = 2000;
  for (const [name, st] of STATES) {
    const row = {state: name};
    // (a) no capture at all: does the guest render?
    await applyState(b, st);
    await sleep(500);
    let g0 = await guestInfo(b, gs);
    await sleep(W);
    let g1 = await guestInfo(b, gs);
    row.noCapture = {vis: g1.vis, guestRafPerS: +((g1.frames - g0.frames) / (W / 1000)).toFixed(1),
                     guestSize: `${g1.w}x${g1.h}`};
    // (b) track
    await resetState(b, st);
    const cap = await evj(b, 'capture(0, {})');
    await sleep(700);
    await applyState(b, st);
    await sleep(500);
    await ev(b, 'stats(0)');
    g0 = await guestInfo(b, gs);
    await sleep(W);
    const s = await evj(b, 'stats(0)');
    g1 = await guestInfo(b, gs);
    row.track = {ok: cap.ok, fps: +(s.frames / (W / 1000)).toFixed(1), sizes: s.sizes,
                 vis: g1.vis, guestRafPerS: +((g1.frames - g0.frames) / (W / 1000)).toFixed(1),
                 readyState: s.readyState};
    await ev(b, 'stopCapture(0)');
    await resetState(b, st);
    await sleep(500);
    // (c) screencast
    const sc = await startScreencast(b, 0, gs, {});
    await sleep(700);
    await applyState(b, st);
    await sleep(500);
    await ev(b, 'scStats(0)');
    const m0 = sc.meta.frames;
    g0 = await guestInfo(b, gs);
    await sleep(W);
    const ss = await evj(b, 'scStats(0)');
    g1 = await guestInfo(b, gs);
    row.screencast = {fps: +((sc.meta.frames - m0) / (W / 1000)).toFixed(1),
                      decodedFps: +(ss.frames / (W / 1000)).toFixed(1),
                      sizes: ss.sizes, vis: g1.vis,
                      guestRafPerS: +((g1.frames - g0.frames) / (W / 1000)).toFixed(1)};
    await sc.stop();
    await resetState(b, st);
    await sleep(500);
    log('B', J(row));
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------- Phase C: constraints
async function phaseC(b) {
  const rows = [];
  const [ua] = await createFrames(b, 1, 'anim', 640, 360);
  await ev(b, `createFrame(1, ${J(gurl('quad'))}, 640, 360)`);
  const cases = [
    ['anim', 0, {}],
    ['anim', 0, {maxWidth: 640, maxHeight: 360}],
    ['anim', 0, {maxWidth: 320, maxHeight: 180}],
    ['anim', 0, {maxWidth: 320, maxHeight: 320}],
    ['anim', 0, {maxWidth: 1280, maxHeight: 720}],
    ['anim', 0, {maxWidth: 1280, maxHeight: 720, minWidth: 1280, minHeight: 720}],
    ['anim', 0, {maxFrameRate: 10}],
    ['anim', 0, {maxFrameRate: 5, maxWidth: 320, maxHeight: 180}],
    ['static', 1, {}],
  ];
  for (const [kind, id, opts] of cases) {
    const cap = await evj(b, `capture(${id}, ${J(opts)})`);
    await sleep(1000);
    const first = await evj(b, `stats(${id})`);
    const secs = [];
    for (let i = 0; i < 3; i++) {
      await sleep(1000);
      secs.push((await evj(b, `stats(${id})`)));
    }
    await ev(b, `stopCapture(${id})`);
    const row = {kind, opts, ok: cap.ok, error: cap.error, settings: cap.settings,
                 firstSecondFrames: first.frames,
                 fpsPerSecond: secs.map((s) => s.frames),
                 sizes: Object.assign({}, first.sizes, ...secs.map((s) => s.sizes))};
    log('C', J(row));
    rows.push(row);
    await sleep(300);
  }
  return rows;
}

// ------------------------------------------------- Phase D: 8 guests
async function phaseD(b) {
  const N = 8;
  const urls = [];
  for (let i = 0; i < N; i++) {
    const c = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
               'ffffff', '808000'][i];
    const u = gurl('solid', '&c=' + c);
    urls.push(u);
    await ev(b, `createFrame(${i}, ${J(u)}, 240, 160)`);
  }
  const caps = [];
  for (let i = 0; i < N; i++) caps.push(await evj(b, `capture(${i}, {})`));
  await sleep(1500);
  const px = [];
  for (let i = 0; i < N; i++) px.push((await evj(b, `checkVideoFrame(${i})`)).px.TL);
  const st = [];
  for (let i = 0; i < N; i++) st.push(await evj(b, `stats(${i})`));
  // Also animated guests: fps per track with 8 concurrent captures.
  for (let i = 0; i < N; i++) await ev(b, `stopCapture(${i}); removeFrame(${i})`);
  await sleep(500);
  const anim = [];
  for (let i = 0; i < N; i++) {
    await ev(b, `createFrame(${100 + i}, ${J(gurl('anim'))}, 320, 180)`);
  }
  for (let i = 0; i < N; i++) await evj(b, `capture(${100 + i}, {})`);
  await sleep(1000);
  for (let i = 0; i < N; i++) await ev(b, `stats(${100 + i})`);
  await sleep(3000);
  for (let i = 0; i < N; i++) {
    const s = await evj(b, `stats(${100 + i})`);
    anim.push({fps: +(s.frames / 3).toFixed(1), sizes: s.sizes});
  }
  const res = {caps: caps.map((c) => c.ok), expected: urls.map((u) => u.split('c=')[1]),
               topLeftPixel: px, stats: st.map((s) => ({frames: s.frames, sizes: s.sizes})),
               anim};
  log('D', J(res));
  return res;
}

// ------------------------------------------------- Phase E: consumption
async function phaseE(b) {
  const res = {};
  await createFrames(b, 1, 'quad', 640, 360);
  const cap = await evj(b, 'capture(0, {maxWidth: 640, maxHeight: 360})');
  await sleep(1000);
  res.stats = await evj(b, 'stats(0)');
  for (const [k, fn] of [['webgl', 'checkWebGL(0)'], ['webgpu', 'checkWebGPU(0)'],
                         ['worker', 'checkWorker(0, 20)'],
                         ['videoFrame', 'checkVideoFrame(0)']]) {
    try { res[k] = await evj(b, fn, 60000); }
    catch (e) { res[k] = {ok: false, error: String(e).slice(0, 400)}; }
    log('E', k, J(res[k]));
  }
  // chrome://gpu summary of the configuration.
  res.gpu = await gpuInfo(b);
  return res;
}

async function gpuInfo(b) {
  try {
    const r = await b.cdp.send('SystemInfo.getInfo', {});
    const g = r.gpu;
    return {devices: g.devices.map((d) => ({vendor: d.vendorString || d.vendorId,
            device: d.deviceString || d.deviceId, driver: d.driverVersion})),
            featureStatus: g.featureStatus,
            glRenderer: (g.auxAttributes || {}).glRenderer,
            glImpl: (g.auxAttributes || {}).glImplementationParts,
            videoDecoding: g.videoDecoding?.length,
            driverBugWorkarounds: (g.driverBugWorkarounds || []).length};
  } catch (e) { return {error: String(e)}; }
}

// ------------------------------------------------- Phase F: cost
async function measureWindow(b, roles, seconds, ids, mode) {
  await sleep(1500);  // warm-up
  for (const id of ids) await ev(b, mode === 'track' ? `stats(${id})` : `scStats(${id})`);
  const c0 = cpuSnapshot(b.child.pid);
  const n0 = selfTicks();
  await sleep(seconds * 1000);
  const c1 = cpuSnapshot(b.child.pid);
  const n1 = selfTicks();
  const per = [];
  for (const id of ids) {
    per.push(await evj(b, mode === 'track' ? `stats(${id})` : `scStats(${id})`));
  }
  return {cpu: cpuDelta(c0, c1, roles, seconds, mode === 'screencast' ? n1 - n0 : undefined),
          fps: per.map((s) => +(s.frames / seconds).toFixed(1)),
          sizes: per.map((s) => s.sizes),
          lat: per.flatMap((s) => s.lat)};
}

async function phaseF(b) {
  const SECONDS = Number(process.env.F_SECONDS || 10);
  const out = [];
  for (const N of [1, 8]) {
    const W = 640, H = 360;
    await ev(b, `document.getElementById('frames').replaceChildren(); 'ok'`);
    const base = N * 1000;
    const urls = [];
    for (let i = 0; i < N; i++) {
      const u = gurl('anim');
      urls.push(u);
      await ev(b, `createFrame(${base + i}, ${J(u)}, ${W}, ${H})`);
    }
    // Map processes to roles.
    const roles = {};
    const app = await identifyRenderer(b, b.s);
    roles[app] = 'embedder renderer';
    const gss = [];
    for (const u of urls) {
      const gs = await guestSession(b, u);
      gss.push(gs);
      const p = await identifyRenderer(b, gs.sessionId);
      if (p && p !== app) roles[p] = 'guest renderer(s)';
    }
    const ids = urls.map((_, i) => base + i);
    // Idle (no capture) baseline, after letting start-up work settle.
    await sleep(8000);
    const idle = await measureWindow(b, roles, SECONDS, [], 'track');
    // Track.
    for (const id of ids) await evj(b, `capture(${id}, {maxWidth: ${W}, maxHeight: ${H}})`);
    const track = await measureWindow(b, roles, SECONDS, ids, 'track');
    for (const id of ids) await ev(b, `stopCapture(${id})`);
    await sleep(1000);
    // Track at up to 60 fps (the default frame rate for this source is 30).
    for (const id of ids) {
      await evj(b, `capture(${id}, {maxWidth: ${W}, maxHeight: ${H}, maxFrameRate: 60})`);
    }
    const track60 = await measureWindow(b, roles, SECONDS, ids, 'track');
    for (const id of ids) await ev(b, `stopCapture(${id})`);
    await sleep(1000);
    // Screencast.
    const scs = [];
    for (let i = 0; i < N; i++) {
      scs.push(await startScreencast(b, ids[i], gss[i], {maxWidth: W, maxHeight: H}));
    }
    const sc = await measureWindow(b, roles, SECONDS, ids, 'screencast');
    sc.cdpFps = scs.map((s) => s.meta.frames);
    for (const s of scs) await s.stop();
    // Idle again at the end (no capture), as a check on the baseline.
    const idleEnd = await measureWindow(b, roles, SECONDS, [], 'track');
    const viewport = await ev(b, 'innerWidth + "x" + innerHeight');
    const row = {N, W, H, viewport, seconds: SECONDS, roles: Object.values(roles), idle, idleEnd, track, track60, screencast: sc};
    delete row.idle.lat; delete row.idleEnd.lat; delete row.track.lat; delete row.track60.lat; delete row.screencast.lat;
    log('F', J(row));
    out.push(row);
    for (const gs of gss) {
      await b.cdp.send('Target.detachFromTarget', {sessionId: gs.sessionId}).catch(() => {});
    }
  }
  return out;
}

// ------------------------------------------------- Phase L: latency
async function phaseL(b) {
  const out = {};
  const [u] = await createFrames(b, 1, 'anim', 640, 360);
  const gs = await guestSession(b, u);
  await evj(b, 'capture(0, {maxWidth: 640, maxHeight: 360, maxFrameRate: 60}, true)');
  await sleep(1500);
  await ev(b, 'stats(0)');
  await sleep(5000);
  const t = await evj(b, 'stats(0)');
  await ev(b, 'stopCapture(0)');
  await sleep(500);
  const sc = await startScreencast(b, 0, gs, {maxWidth: 640, maxHeight: 360}, true);
  await sleep(1500);
  await ev(b, 'scStats(0)');
  await sleep(5000);
  const s = await evj(b, 'scStats(0)');
  await sc.stop();
  const summ = (l) => ({n: l.length, median: median(l), p90: pct(l, 0.9),
                        min: Math.min(...l), max: Math.max(...l)});
  out.track = summ(t.lat);
  out.track.frames = t.frames;
  out.screencast = summ(s.lat);
  out.screencast.frames = s.frames;
  log('L', J(out));
  return out;
}

// ------------------------------------------------- Phase H: destruction etc.
async function phaseH(b) {
  const res = {};
  // 1. Remove the element mid-capture.
  let [u] = await createFrames(b, 1, 'anim', 320, 180);
  await evj(b, 'capture(0, {})');
  await sleep(800);
  await ev(b, 'removeFrame(0)');
  await sleep(1500);
  res.removeElement = await evj(b, 'trackState(0)');
  log('H remove', J(res.removeElement));
  // 2. Navigate the guest mid-capture (same site and cross site).
  await ev(b, `createFrame(1, ${J(gurl('solid', '&c=ff0000'))}, 320, 180)`);
  await evj(b, 'capture(1, {})');
  await sleep(800);
  const before = (await evj(b, 'checkVideoFrame(1)')).px.TL;
  await ev(b, `new Promise(r => { const f = frames.get(1).el;
      f.addEventListener('loadstop', () => r('ok'), {once: true});
      f.src = ${J(gurl('solid', '&c=00ff00'))}; })`);
  await sleep(1000);
  const afterSame = (await evj(b, 'checkVideoFrame(1)')).px.TL;
  const s1 = await evj(b, 'stats(1)');
  // Cross-site (different host: localhost vs 127.0.0.1 -> new process).
  await ev(b, `new Promise(r => { const f = frames.get(1).el;
      f.addEventListener('loadstop', () => r('ok'), {once: true});
      f.src = ${J(gurl('solid', '&c=0000ff').replace('127.0.0.1', 'localhost'))}; })`);
  await sleep(1500);
  let afterCross;
  try { afterCross = (await evj(b, 'checkVideoFrame(1)')).px.TL; }
  catch (e) { afterCross = String(e).slice(0, 200); }
  res.navigate = {before, afterSameSite: afterSame, afterCrossSite: afterCross,
                  track: await evj(b, 'trackState(1)'), framesDuring: s1.frames};
  log('H nav', J(res.navigate));
  // 3. Guest renderer crash mid-capture (kill guest process via CDP crash).
  const gs = await guestSession(b, (await getTargets(b.cdp)).find(
      (t) => t.type === 'webview')?.url);
  await b.cdp.send('Page.crash', {}, gs.sessionId).catch(() => {});
  await sleep(1500);
  res.guestCrash = await evj(b, 'trackState(1)');
  log('H crash', J(res.guestCrash));
  // 4. Capture, then close the app window while capturing.
  await ev(b, `createFrame(2, ${J(gurl('anim'))}, 320, 180)`);
  await evj(b, 'capture(2, {})');
  await ev(b, `createFrame(3, ${J(gurl('anim'))}, 320, 180)`);
  await evj(b, 'capture(3, {})');
  await sleep(800);
  // 5. Two tracks of the same guest (capture twice).
  res.secondCaptureSameGuest = await evj(b, `(async () => {
      const f = frames.get(2); const s = await f.el.captureStream({});
      const t = s.getVideoTracks()[0];
      const r = new MediaStreamTrackProcessor({track: t}).readable.getReader();
      const v = await r.read(); const out = {ok: true, w: v.value.displayWidth};
      v.value.close(); r.cancel(); t.stop(); return JSON.stringify(out); })()
      .catch(e => JSON.stringify({ok: false, error: String(e)}))`);
  // 6. Reload the app page while capturing.
  await b.cdp.send('Page.reload', {}, b.s);
  await sleep(2000);
  await ev(b, `createFrame(4, ${J(gurl('anim'))}, 320, 180)`);
  await evj(b, 'capture(4, {})');
  await sleep(500);
  await b.cdp.send('Target.closeTarget', {targetId: b.appTarget});
  await sleep(1500);
  res.closedWindow = 'done';
  return res;
}

const PH = {A: phaseA, N: phaseN, B: phaseB, C: phaseC, D: phaseD, E: phaseE,
            F: phaseF, L: phaseL, H: phaseH};
for (const ph of phases) {
  log('phase', ph, label, gpuMode);
  const b = await setup(ph);
  let res;
  try {
    res = await PH[ph](b);
    if (!['H'].includes(ph)) res = {result: res, gpu: await gpuInfo(b)};
  } catch (e) {
    res = {error: String(e.stack || e)};
    log('ERROR', res.error);
  }
  res.console = b.console;
  await sleep(500);
  await shutdown(b);
  const chromeLog = fs.readFileSync(b.logFile, 'utf8');
  res.dchecks = chromeLog.split('\n').filter((l) =>
      /DCHECK|Check failed|FATAL|Received signal|crash/i.test(l)).slice(0, 30);
  fs.writeFileSync(path.join(RAW, `${label}-${ph}.json`), JSON.stringify(res, null, 1));
  log('phase', ph, 'done; dcheck/fatal lines:', res.dchecks.length);
}

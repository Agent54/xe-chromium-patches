// Scaling run: node stress.mjs <label> <N> <track|screencast> <fps> [animated]
// Headless GPU Chrome; demo.html with N guests of 640x360 (scaled down on the
// left, still fully composited), each captured into the WebGL2 wall scene.
// Measures a 10 s window. Writes raw/stress-<label>.json.
import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {IWA_PORT, launch, evaluate, getTargets, cpuSnapshot, processTree, median,
        shutdown, sleep} from './lib.mjs';
import {iwaOriginFromProfile} from './lib.mjs';
requireEnv({needBinary: true});

const [label, nStr, src, fpsStr, animStr] = process.argv.slice(2);
const N = Number(nStr), FPS = Number(fpsStr || 60), ANIM = Number(animStr || 0);
const SECONDS = Number(process.env.SECONDS_WIN || 10);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), label, ...a);
const memAvailGB = () => Number(fs.readFileSync('/proc/meminfo', 'utf8')
    .match(/MemAvailable:\s+(\d+)/)[1]) / 1048576;
const swapUsedGB = () => {
  const m = fs.readFileSync('/proc/meminfo', 'utf8');
  return (Number(m.match(/SwapTotal:\s+(\d+)/)[1]) - Number(m.match(/SwapFree:\s+(\d+)/)[1])) / 1048576;
};
const swap0 = swapUsedGB();
if (memAvailGB() < 8) { log('not starting: MemAvailable', memAvailGB().toFixed(1)); process.exit(2); }

const logFile = path.join(HERE, 'raw', `stress-${label}.chrome.log`);
if (process.env.EXTRA_ARGS) process.env.GPU_FLAGS = ((process.env.GPU_FLAGS || '') + ' ' + process.env.EXTRA_ARGS).trim();
fs.writeFileSync(logFile, '');
const b = await launch(CHROME_BIN,
    `${PROFILE_DIR}/stress-${label}`, logFile,
    process.env.MODE || 'gpu',
    [`--install-isolated-web-app-from-url=http://127.0.0.1:${IWA_PORT}/`, 'about:blank']);
const res = {label, N, src, requestedFps: FPS, animated: ANIM || N, guestSize: '640x360', guestPage: process.env.GUEST_PAGE || 'demo_guest.html', features: process.env.GPU_FEATURES || ''};
let aborted = null;
try {
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
  const q = `n=${N}&gw=${process.env.GW || 640}&gh=${process.env.GH || 360}&cols=8&leftw=420&fps=${FPS}&script=stage3` +
      (src !== 'track' ? '&src=' + src : '') + (ANIM ? `&animated=${ANIM}` : '') +
      (process.env.GUEST_PAGE ? `&guest=${encodeURIComponent('http://127.0.0.1:8712/' + process.env.GUEST_PAGE)}` : '') +
      (process.env.EXTRA_Q ? '&' + process.env.EXTRA_Q : '');
  const {targetId} = await b.cdp.send('Target.createTarget',
      {url: `isolated-app://${m[1]}/${process.env.PAGE || 'demo.html'}?${q}`, newWindow: true});
  for (let i = 0; i < 300; i++) {
    const {targetInfo} = await b.cdp.send('Target.getTargetInfo', {targetId});
    if (targetInfo.url.includes('/' + (process.env.PAGE || 'demo.html'))) break;
    await sleep(200);
  }
  await sleep(1000);
  const {sessionId: s} = await b.cdp.send('Target.attachToTarget', {targetId, flatten: true});
  const ev = (e, ms) => evaluate(b.cdp, s, e, ms);
  if ((process.env.MODE || 'gpu') !== 'desktop') {
    const {windowId} = await b.cdp.send('Browser.getWindowForTarget', {targetId});
    await b.cdp.send('Browser.setWindowBounds', {windowId, bounds: {left: 0, top: 0, width: 2000, height: 1300}});
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      await b.cdp.send('Browser.setContentsSize', {windowId, width: 1920, height: 1080});
      await sleep(500);
      if (await ev('innerWidth + "x" + innerHeight') === '1920x1080') break;
    }
  }
  const t0 = Date.now();
  for (let i = 0; i < 600; i++) {
    if (await ev('demoState.ready').catch(() => false)) break;
    await sleep(250);
  }
  res.startupSeconds = (Date.now() - t0) / 1000;
  res.debugState = await ev('JSON.stringify({href: location.href, n: demoState.n, cards: demoState.cards.length, ready: demoState.ready})').catch((e) => String(e));
  res.viewport = await ev('innerWidth + "x" + innerHeight');
  res.errors = await ev('demoState.errors');
  // Guest sessions (for screencast source and guest rAF sampling).
  const targets = (await getTargets(b.cdp)).filter((t) => t.type === 'webview' && t.url.includes('/demo_guest'));
  const guests = [];
  for (const t of targets) {
    const i = Number(new URL(t.url).searchParams.get('i'));
    const {sessionId} = await b.cdp.send('Target.attachToTarget', {targetId: t.targetId, flatten: true});
    guests.push({i, sessionId});
  }
  res.guestTargets = guests.length;
  if (src === 'screencast') {
    const win = (await b.cdp.send('Runtime.evaluate', {expression: 'window'}, s)).result.objectId;
    const byS = new Map(guests.map((g) => [g.sessionId, g.i]));
    b.cdp.on((msg) => {
      if (msg.method !== 'Page.screencastFrame' || !byS.has(msg.sessionId)) return;
      b.cdp.send('Page.screencastFrameAck', {sessionId: msg.params.sessionId}, msg.sessionId).catch(() => {});
      b.cdp.send('Runtime.callFunctionOn', {functionDeclaration: 'function(i, d) { scFrame(i, d); }',
          objectId: win, arguments: [{value: byS.get(msg.sessionId)}, {value: msg.params.data}]}, s).catch(() => {});
    });
    for (const g of guests) {
      await b.cdp.send('Page.startScreencast', {format: 'jpeg', quality: 72, maxWidth: 640, maxHeight: 360}, g.sessionId);
    }
  }
  // Embedder renderer pid (burn 400 ms there).
  const c0x = cpuSnapshot(b.child.pid);
  await ev('(() => { const e = performance.now() + 400; while (performance.now() < e); })()');
  const c1x = cpuSnapshot(b.child.pid);
  let emb = null, best = 0;
  for (const pid in c1x) {
    if (c1x[pid].type === 'renderer' && c0x[pid] && c1x[pid].ticks - c0x[pid].ticks > best) {
      best = c1x[pid].ticks - c0x[pid].ticks; emb = pid;
    }
  }
  await sleep(Number(process.env.SETTLE_MS || 4000));  // settle
  const thrK = process.env.THR ? Number(process.env.THR.split(':')[0]) : null;
  const sample = thrK !== null ? guests.filter((g) => g.i < 4 || (g.i >= thrK && g.i < thrK + 4))
      : guests.filter((g, k) => k % Math.max(1, Math.floor(guests.length / 8)) === 0).slice(0, 8);
  const gf = async () => Promise.all(sample.map((g) => evaluate(b.cdp, g.sessionId, 'guestFrames()', 5000).catch(() => null)));
  if (process.env.TRACE) {
    // Trace a few seconds of steady state, then measure the normal window.
    const events = [];
    const off = b.cdp.on((msg) => { if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value); });
    const done = new Promise((r) => { const o = b.cdp.on((msg) => { if (msg.method === 'Tracing.tracingComplete') { o(); r(); } }); });
    const f0 = await ev('demoState.cards.map((c) => c.frames)');
    const tt0 = Date.now();
    await b.cdp.send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {recordMode: 'recordAsMuchAsPossible',
        includedCategories: (process.env.TRACE_CATS || 'toplevel,gpu,viz,gpu.capture,media,skia,gpu.angle,cc,disabled-by-default-gpu.service,mojom').split(',')}});
    await sleep(Number(process.env.TRACE_SECONDS || 3) * 1000);
    await b.cdp.send('Tracing.end');
    await done; off();
    const f1 = await ev('demoState.cards.map((c) => c.frames)');
    res.traceFrames = f1.reduce((a, x, k) => a + x - f0[k], 0);
    res.traceSeconds = (Date.now() - tt0) / 1000;
    fs.writeFileSync(path.join(HERE, 'raw', `trace-${label}.json`), JSON.stringify({traceEvents: events}));
    await sleep(2000);
  }
  const frames0 = await ev('demoState.cards.map((c) => c.frames)');
  await ev('demoState.lat = []');
  await ev('typeof startWindow === "function" && startWindow(); 1').catch(() => null);
  const g0 = await gf();
  const cpu0 = cpuSnapshot(b.child.pid);
  const tw0 = Date.now();
  const sceneSamples = [], gpuSamples = [];
  const gpuPid = Object.keys(cpu0).find((p) => cpu0[p].type === 'gpu-process');
  // Per-thread CPU of the GPU process (to see whether one thread is pegged).
  const threadTicks = (pid) => {
    const out = {};
    try {
      for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
        const st = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
        const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
        out[tid] = {name, ticks: Number(f[11]) + Number(f[12])};
      }
    } catch {}
    return out;
  };
  const thr0 = {gpu: threadTicks(gpuPid), browser: threadTicks(b.child.pid), emb: threadTicks(emb)};
  while (Date.now() - tw0 < SECONDS * 1000) {
    await sleep(1000);
    sceneSamples.push(await ev('demoState.sceneFps').catch(() => null));
    try {
      const o = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits']).toString().trim().split(',').map(Number);
      gpuSamples.push(o);
    } catch {}
    if (memAvailGB() < 6 || swapUsedGB() - swap0 > 0.5) { aborted = `memory: avail ${memAvailGB().toFixed(1)} GB, swap +${(swapUsedGB() - swap0).toFixed(2)} GB`; break; }
  }
  const secs = (Date.now() - tw0) / 1000;
  const cpu1 = cpuSnapshot(b.child.pid);
  const thr1 = {gpu: threadTicks(gpuPid), browser: threadTicks(b.child.pid), emb: threadTicks(emb)};
  const frames1 = await ev('demoState.cards.map((c) => c.frames)');
  const lat = await ev('demoState.lat').catch(() => []);
  res.window = JSON.parse(await ev('JSON.stringify(typeof endWindow === "function" ? endWindow() : null)').catch(() => 'null'));
  res.latencyMs = lat.length ? {n: lat.length, median: median(lat), p90: [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.9)]} : null;
  res.frameInfo = await ev('JSON.stringify({size: demoState.cards[0].size, format: demoState.cards[0].format, extra: demoState.frameInfo || null})').catch(() => null);
  res.glRenderer = await ev('demoState.glRenderer').catch(() => null);
  const g1 = await gf();
  const fps = frames1.map((f, k) => (f - frames0[k]) / secs);
  const anim = ANIM ? fps.slice(0, ANIM) : fps;
  const stat = (xs) => ({median: +median(xs).toFixed(1), min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1)});
  res.trackFps = stat(anim);
  res.fpsPerCard = fps.map((x) => +x.toFixed(2));
  {
    const kinds = await ev('demoState.cards.map((c) => c.kind || "synthetic")').catch(() => null);
    if (kinds) {
      res.kinds = kinds;
      const by = {};
      kinds.forEach((k, i) => { (by[k] = by[k] || []).push(fps[i]); });
      res.fpsByKind = Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, stat(xs)]));
      if (process.env.THR) {
        const kk = Number(process.env.THR.split(':')[0]);
        const animKinds = new Set(['video', 'webgl', 'css', 'clock', 'scroll', 'synthetic']);
        const focusAnim = fps.slice(0, kk).filter((_, i) => animKinds.has(kinds[i]));
        const restAnim = fps.slice(kk).filter((_, i) => animKinds.has(kinds[i + kk]));
        res.focusAnimFps = focusAnim.length ? stat(focusAnim) : null;
        res.restAnimFps = restAnim.length ? stat(restAnim) : null;
      }
    }
    res.errorsAtEnd = await ev('demoState.errors').catch(() => null);
  }
  if (ANIM) res.staticTrackFps = stat(fps.slice(ANIM));
  const gr = sample.map((g, k) => g0[k] !== null && g1[k] !== null ? (g1[k] - g0[k]) / secs : null).filter((x) => x !== null);
  res.guestRafPerS = gr.length ? stat(gr) : null;
  res.guestRafByIndex = Object.fromEntries(sample.map((g, k) => [g.i, g0[k] !== null && g1[k] !== null ? +((g1[k] - g0[k]) / secs).toFixed(1) : null]));
  if (process.env.THR) {
    const k = Number(process.env.THR.split(':')[0]);
    res.trackFpsFull = stat(fps.slice(0, k));
    res.trackFpsThrottled = fps.length > k ? stat(fps.slice(k)) : null;
  }
  res.sceneFps = stat(sceneSamples.filter((x) => x !== null));
  res.gpuUtilPct = gpuSamples.length ? stat(gpuSamples.map((x) => x[0])) : null;
  res.gpuMemUsedMiB = gpuSamples.length ? Math.max(...gpuSamples.map((x) => x[1])) : null;
  const groups = {};
  for (const pid in cpu1) {
    if (!cpu0[pid]) continue;
    let g = cpu1[pid].type;
    if (pid === emb) g = 'embedder renderer';
    else if (g === 'renderer') g = 'other renderers (guests)';
    groups[g] = (groups[g] || 0) + (cpu1[pid].ticks - cpu0[pid].ticks) / secs;  // % of one core
  }
  for (const k in groups) groups[k] = +groups[k].toFixed(1);
  groups.total = +Object.values(groups).reduce((a, x) => a + x, 0).toFixed(1);
  res.cpuPct = groups;
  const topThreads = (a, bb, k = 6) => Object.entries(bb).map(([tid, v]) => ({name: v.name,
      pct: +(((v.ticks - (a[tid] ? a[tid].ticks : v.ticks)) / secs)).toFixed(1)}))
      .sort((x, y) => y.pct - x.pct).slice(0, k);
  res.topThreads = {gpu: topThreads(thr0.gpu, thr1.gpu), browser: topThreads(thr0.browser, thr1.browser),
                    embedder: topThreads(thr0.emb, thr1.emb)};
  // Processes and PSS.
  {
    const g = res.topThreads.gpu;
    res.gpuMainPct = (g.find((x) => x.name === 'chrome' || x.name === 'CrGpuMain') || {pct: 0}).pct;
    res.vizCompositorPct = (g.find((x) => x.name.startsWith('VizCompositor')) || {pct: 0}).pct;
  }
  const pids = processTree(b.child.pid);
  let pss = 0;
  for (const p of pids) {
    try { pss += Number(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)[1]); } catch {}
  }
  res.processes = pids.length;
  res.renderers = Object.values(cpu1).filter((x) => x.type === 'renderer').length;
  res.pssMB = Math.round(pss / 1024);
  res.memAvailGB = +memAvailGB().toFixed(1);
  res.swapDeltaGB = +(swapUsedGB() - swap0).toFixed(2);
  res.readout = await ev('document.getElementById("readout").textContent');
  if (process.env.STILL) {
    const {data} = await b.cdp.send('Page.captureScreenshot', {format: 'png'}, s);
    fs.writeFileSync(path.join(HERE, 'demo', `stress-${label}.png`), Buffer.from(data, 'base64'));
  }
} catch (e) {
  res.error = String(e.stack || e).slice(0, 800);
}
res.aborted = aborted;
await shutdown(b);
const clog = fs.readFileSync(logFile, 'utf8');
res.dchecks = clog.split('\n').filter((l) => /FATAL|Check failed/.test(l)).slice(0, 5);
res.gpuProcessCrashes = (clog.match(/GPU process exited unexpectedly/g) || []).length;
fs.writeFileSync(path.join(HERE, 'raw', `stress-${label}.json`), JSON.stringify(res, null, 1));
log(JSON.stringify({lat: res.latencyMs, gpuMain: res.gpuMainPct, viz: res.vizCompositorPct, fmt: res.frameInfo, trackFps: res.trackFps, guestRaf: res.guestRafPerS, scene: res.sceneFps, cpu: res.cpuPct,
                    gpu: res.gpuUtilPct, pss: res.pssMB, procs: res.processes, err: res.error, aborted, dchecks: res.dchecks.length}));

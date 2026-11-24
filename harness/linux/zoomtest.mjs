// node zoomtest.mjs <label> <n> : strict zoom test on native cards (see native.js zoomtest).
// Env: CHROME_BIN, PROFILE_DIR, GPU_FEATURES, GPU_FLAGS, SET (real|synthetic), CW (480).
import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {IWA_PORT, launch, evaluate, shutdown, sleep, iwaOriginFromProfile} from './lib.mjs';
requireEnv({needBinary: true});
const [label, nStr] = process.argv.slice(2);
const N = Number(nStr);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const logFile = path.join(HERE, 'raw', `zoom-${label}.chrome.log`);
fs.writeFileSync(logFile, '');
const b = await launch(CHROME_BIN,
    `${PROFILE_DIR}/zoom-${label}`, logFile, 'desktop',
    [`--install-isolated-web-app-from-url=http://127.0.0.1:${IWA_PORT}/`, 'about:blank']);
const res = {label, N, features: process.env.GPU_FEATURES || '', flags: process.env.GPU_FLAGS || '', zooms: [], sharp: []};
try {
  let origin = null;
  for (let i = 0; i < 240 && !origin; i++) {
    if (/command line installation successful/.test(fs.readFileSync(logFile, 'utf8'))) origin = iwaOriginFromProfile(b.userDataDir);
    await sleep(250);
  }
  const q = `n=${N}&gw=1280&gh=800&cw=${process.env.CW || 480}&mode=zoomtest` + (process.env.SET === 'synthetic' ? '&set=synthetic' : '');
  const {targetId} = await b.cdp.send('Target.createTarget', {url: `${origin}/native.html?${q}`, newWindow: true});
  for (const t of (await b.cdp.send('Target.getTargets')).targetInfos) {
    if (t.type === 'page' && t.url === 'about:blank') await b.cdp.send('Target.closeTarget', {targetId: t.targetId}).catch(() => {});
  }
  const {sessionId: s} = await b.cdp.send('Target.attachToTarget', {targetId, flatten: true});
  const ev = (e, ms) => evaluate(b.cdp, s, e, ms);
  for (let i = 0; i < 600; i++) { if (await ev('demoState.ready').catch(() => false)) break; await sleep(250); }
  res.viewport = await ev('innerWidth + "x" + innerHeight');
  await sleep(10000);  // settle after load
  for (const ms of (process.env.ZOOMS === '0' ? [] : [400, 120])) {
    for (let k = 0; k < 20; k++) {
      const traced = k < Number(process.env.TRACED || 5);
      let events = null, done = null, off = null;
      if (traced) {
        events = [];
        off = b.cdp.on((m) => { if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); });
        done = new Promise((r) => { const o = b.cdp.on((m) => { if (m.method === 'Tracing.tracingComplete') { o(); r(); } }); });
        await b.cdp.send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {recordMode: 'recordAsMuchAsPossible',
            includedCategories: process.env.TRACE_FULL ? ['toplevel', 'viz', 'gpu', 'cc', 'blink', 'benchmark', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'mojom', 'ipc', 'renderer.scheduler', '__metadata'] : ['cc', 'devtools.timeline', '__metadata']}});
        await sleep(500);
      }
      const r = JSON.parse(await ev(`runZoom(${ms})`, 10000));
      r.traced = traced;
      res.zooms.push(r);
      await sleep(1400);
      if (traced) {
        await b.cdp.send('Tracing.end'); await done; off();
        if (process.env.TRACE_FULL && r.gt33 > 0) {
          fs.writeFileSync(path.join(HERE, 'raw', `zoomtrace-${label}-${ms}-${k}.json`), JSON.stringify({traceEvents: events, zoom: r}));
        }
        const pname = {};
        for (const e of events) if (e.ph === 'M' && e.name === 'process_name') pname[e.pid] = e.args.name;
        const stamp = (msg) => events.filter((e) => e.name === 'TimeStamp' && e.args && e.args.data && e.args.data.message === msg).map((e) => e.ts);
        const zs = stamp('zoomstart')[0], ze = stamp('zoomend')[0];
        const embPid = (events.find((e) => e.name === 'TimeStamp') || {}).pid;
        const rasters = events.filter((e) => e.name === 'RasterizerTaskImpl::RunOnWorkerThread' && e.ph === 'X' && /Renderer/.test(pname[e.pid] || '') && e.pid !== embPid);
        const busyBefore = new Set(rasters.filter((e) => e.ts < zs && e.ts > zs - 450000).map((e) => e.pid));
        const after = rasters.filter((e) => e.ts >= ze && !busyBefore.has(e.pid));
        // Per guest: the end of its last raster before a gap of >= 300 ms
        // (settled). A guest that never pauses that long until the trace ends
        // is animating, not re-rastering for the zoom: excluded.
        const traceEnd = events.reduce((m, e) => (e.ts && e.ts > m ? e.ts : m), 0);
        const byPid = {};
        for (const e of after) (byPid[e.pid] = byPid[e.pid] || []).push(e);
        let lastEnd = ze, settled = 0, animating = 0;
        for (const pid in byPid) {
          const xs = byPid[pid].sort((a, c) => a.ts - c.ts);
          let end = null;
          for (let i = 0; i < xs.length; i++) {
            const e1 = xs[i].ts + (xs[i].dur || 0);
            const next = i + 1 < xs.length ? xs[i + 1].ts : traceEnd;
            if (next - e1 >= 300000) { end = e1; break; }
          }
          if (end === null) { animating++; continue; }
          settled++;
          lastEnd = Math.max(lastEnd, end);
        }
        res.sharp.push({ms, timeToLastRasterMs: +((lastEnd - ze) / 1000).toFixed(1), guestsSettled: settled,
                        excludedAnimating: busyBefore.size + animating});
        await sleep(300);
      }
    }
  }
  // "open": a card from its card scale (0.3 at world zoom 0.8) to 1:1.
  res.opens = [];
  if (process.env.OPENS !== '0') {
    await ev('setZoom(0.8); 1');
    await sleep(3000);
    const cards = [0, 1, 2, 3, 8, 9, 10, 11, 16, 17];
    for (const ms of [100, 150]) {
      for (const k of cards) {
        const events = [];
        const off = b.cdp.on((m) => { if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); });
        const done = new Promise((r) => { const o = b.cdp.on((m) => { if (m.method === 'Tracing.tracingComplete') { o(); r(); } }); });
        await b.cdp.send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {recordMode: 'recordAsMuchAsPossible',
            includedCategories: ['cc', 'devtools.timeline', '__metadata']}});
        await sleep(500);
        const r = JSON.parse(await ev(`runOpen(${k}, ${ms})`, 10000));
        r.card = k;
        await sleep(1100);
        await b.cdp.send('Tracing.end'); await done; off();
        const pname = {};
        for (const e of events) if (e.ph === 'M' && e.name === 'process_name') pname[e.pid] = e.args.name;
        const stamp = (msg) => events.filter((e) => e.name === 'TimeStamp' && e.args && e.args.data && e.args.data.message === msg).map((e) => e.ts);
        const zs = stamp('zoomstart')[0], ze = stamp('zoomend')[0];
        const embPid = (events.find((e) => e.name === 'TimeStamp') || {}).pid;
        const rasters = events.filter((e) => e.name === 'RasterizerTaskImpl::RunOnWorkerThread' && e.ph === 'X' && /Renderer/.test(pname[e.pid] || '') && e.pid !== embPid);
        const busyBefore = new Set(rasters.filter((e) => e.ts < zs && e.ts > zs - 450000).map((e) => e.pid));
        const byPid = {};
        for (const e of rasters) if (e.ts >= zs && !busyBefore.has(e.pid)) (byPid[e.pid] = byPid[e.pid] || []).push(e);
        // The opened guest: the most raster time from the open's start on.
        let best = null, bestT = 0;
        for (const pid in byPid) {
          const t = byPid[pid].reduce((a, e) => a + (e.dur || 0), 0);
          if (t > bestT) { bestT = t; best = pid; }
        }
        if (best) {
          const xs = byPid[best].sort((a, c) => a.ts - c.ts);
          const traceEnd = events.reduce((m, e) => (e.ts && e.ts > m ? e.ts : m), 0);
          let end = null;
          for (let i = 0; i < xs.length; i++) {
            const e1 = xs[i].ts + (xs[i].dur || 0);
            const next = i + 1 < xs.length ? xs[i + 1].ts : traceEnd;
            if (next - e1 >= 300000) { end = e1; break; }
          }
          r.landingToSharpMs = end === null ? null : +((end - ze) / 1000).toFixed(1);
          r.firstRasterAfterStartMs = +((xs[0].ts - zs) / 1000).toFixed(1);
        }
        res.opens.push(r);
        await sleep(1200);
      }
    }
  }
} catch (e) { res.error = String(e.stack || e).slice(0, 600); }
await shutdown(b);
fs.writeFileSync(path.join(HERE, 'raw', `zoom-${label}.json`), JSON.stringify(res, null, 1));
const untraced = res.zooms.filter((z) => !z.traced);
const by = (ms) => untraced.filter((z) => z.ms === ms);
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
for (const ms of [100, 150]) {
  const o = res.opens.filter((x) => x.ms === ms);
  if (!o.length) continue;
  const sharp = o.map((x) => x.landingToSharpMs).filter((x) => x !== null && x !== undefined).sort((a, c) => a - c);
  console.log(label, 'open ' + ms + 'ms', 'opens', o.length, 'gt20/open', (sum(o, (x) => x.gt20) / o.length).toFixed(2),
      'gt33/open', (sum(o, (x) => x.gt33) / o.length).toFixed(2), 'worst max', Math.max(...o.map((x) => x.worst)),
      'landing->sharp ms median', sharp[sharp.length >> 1], 'p90', sharp[Math.floor(sharp.length * 0.9)], JSON.stringify(sharp));
}
for (const ms of (process.env.ZOOMS === '0' ? [] : [400, 120])) {
  const z = by(ms), sh = res.sharp.filter((x) => x.ms === ms);
  console.log(label, ms + 'ms', 'zooms', z.length, 'gt20/zoom', (sum(z, (x) => x.gt20) / z.length).toFixed(2),
      'gt33/zoom', (sum(z, (x) => x.gt33) / z.length).toFixed(2), 'worst max', Math.max(...z.map((x) => x.worst)),
      'worst median', z.map((x) => x.worst).sort((a, b) => a - b)[z.length >> 1],
      'sharp ms', JSON.stringify(sh.map((x) => x.timeToLastRasterMs)), res.error || '');
}

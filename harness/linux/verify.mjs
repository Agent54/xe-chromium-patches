// node verify.mjs <label> <src> [w h]  -> raw/verify-<label>.json
import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import fs from 'node:fs';
import {launch, evaluate, shutdown, sleep, iwaOriginFromProfile} from './lib.mjs';
requireEnv({needBinary: true});
const [label, src, w = 640, h = 360] = process.argv.slice(2);
const logFile = `raw/verify-${label}.chrome.log`;
fs.writeFileSync(logFile, '');
const b = await launch(CHROME_BIN,
  `${PROFILE_DIR}/verify-${label}`, logFile, process.env.MODE || 'desktop',
  ['--install-isolated-web-app-from-url=http://127.0.0.1:8711/', 'about:blank']);
let origin = null;
for (let i = 0; i < 240 && !origin; i++) {
  if (/command line installation successful/.test(fs.readFileSync(logFile, 'utf8'))) origin = iwaOriginFromProfile(b.userDataDir);
  await sleep(250);
}
const {targetId} = await b.cdp.send('Target.createTarget', {url: `${origin}/verify.html?src=${src}&w=${w}&h=${h}&delay=3000`, newWindow: true});
await sleep(1500);
const {sessionId} = await b.cdp.send('Target.attachToTarget', {targetId, flatten: true});
{
  const {windowId} = await b.cdp.send('Browser.getWindowForTarget', {targetId});
  await b.cdp.send('Browser.setWindowBounds', {windowId, bounds: {left: 0, top: 0, width: 1400, height: 900}}).catch(() => {});
  await sleep(500);
  await b.cdp.send('Browser.setContentsSize', {windowId, width: 1280, height: 800}).catch(() => {});
}
let r = null;
for (let i = 0; i < 60; i++) {
  r = await evaluate(b.cdp, sessionId, 'JSON.stringify(window.verifyResult || null)').catch((e) => JSON.stringify({evalError: String(e)}));
  if (r && JSON.parse(r)?.done) break;
  await sleep(500);
}
await shutdown(b);
fs.writeFileSync(`raw/verify-${label}.json`, r);
console.log(r);

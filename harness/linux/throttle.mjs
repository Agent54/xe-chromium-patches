import {CHROME_BIN, PROFILE_DIR, requireEnv} from './env.mjs';
import fs from 'node:fs';
import {launch, evaluate, shutdown, sleep, iwaOriginFromProfile} from './lib.mjs';
requireEnv({needBinary: true});
const logFile = `raw/throttle.chrome.log`;
fs.writeFileSync(logFile, '');
const b = await launch(CHROME_BIN, `${PROFILE_DIR}/throttle`, logFile, 'desktop',
  ['--install-isolated-web-app-from-url=http://127.0.0.1:8711/', 'about:blank']);
let origin = null;
for (let i = 0; i < 240 && !origin; i++) {
  if (/command line installation successful/.test(fs.readFileSync(logFile, 'utf8'))) origin = iwaOriginFromProfile(b.userDataDir);
  await sleep(250);
}
const {targetId} = await b.cdp.send('Target.createTarget', {url: `${origin}/hidden.html`, newWindow: true});
await sleep(1500);
const {sessionId} = await b.cdp.send('Target.attachToTarget', {targetId, flatten: true});
for (let i = 0; i < 50; i++) { if (await evaluate(b.cdp, sessionId, '!!window.hiddenReady').catch(() => false)) break; await sleep(200); }
const r = await evaluate(b.cdp, sessionId, "runThrottle(5)", 170000);
fs.writeFileSync('raw/throttle.json', r);
console.log(r);
await shutdown(b);

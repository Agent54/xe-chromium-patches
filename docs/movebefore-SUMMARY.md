# controlledframe / guest view `moveBefore()` fix — test run summary

All work local on this machine; nothing uploaded, pushed or filed.

## Checkout and build

- Chromium `9ce695914d1ace26f7e75683c8769feb6347b6a1` ("Roll Chrome Win64 PGO
  Profile"), `chrome/VERSION` 160.0.8176.0 (patch was written against
  d99206f697e3 / 160.0.8175.0; it applied unchanged with `git apply`).
- `fetch --nohooks --no-history chromium`, `gclient runhooks`; later
  `target_os = ['chromeos']` appended to `.gclient` and
  `gclient sync --nohooks --no-history --revision src@9ce695914d1a…` +
  `gclient runhooks` (for F; src stayed at the same commit).
- `out/Default/args.gn`:
  ```
  is_debug = false
  dcheck_always_on = true
  symbol_level = 0
  is_component_build = true
  ```
- `out/cros/args.gn`: same plus `target_os = "chromeos"`.
- Builds (`autoninja -j N -C out/<dir> <targets>`, siso local):
  - `out/Default` `browser_tests`: 35 min at -j 20 (interrupted to raise -j),
    then `browser_tests chrome` 46.6 min at -j 24 → ~82 min wall.
  - JS-only toggles afterwards: 3–12 s.
  - `out/Default` `blink_tests` (content_shell): 39.9 min at -j 8 (concurrent
    with the cros build).
  - `out/cros` `browser_tests`: see F.
- Tests run with `env -u DISPLAY -u WAYLAND_DISPLAY ./browser_tests
  --ozone-platform=headless --test-launcher-jobs=N
  --test-launcher-summary-output=… [--test-launcher-retry-limit=0]` (script:
  `runtests.sh`). No GPU used (headless ozone, software compositing;
  measurement Chrome with `--disable-gpu --disable-features=Vulkan`,
  `VK_ICD_FILENAMES=/nonexistent.json`).

## Changes made to the proposed patch

1. **Test did not compile as given**: in
   `R"( … code: "document.documentElement.getAttribute('data-marker')" … )"`
   the sequence `)"` ends the C++ raw string early. Swapped the inner JS
   quotes: `code: 'document.documentElement.getAttribute("data-marker")'`.
2. **Hardening (item I)**: without the fix the test failed only because Oilpan
   GC destroyed the never-settled `executeScript` promise (a GC-timing
   dependency; otherwise it would hit the launcher timeout). Now the test
   compares `frame.contentWindow` identity right after each `moveBefore()`
   (without the fix the element's `disconnectedCallback` drops the guest
   synchronously, so `contentWindow` becomes `null` inside the call), and only
   awaits `executeScript` while the binding is intact. `EXPECT_EQ` → `ASSERT_EQ`
   so a failure cannot fall through to `WaitForAllGuestsDeleted()` (which would
   hang on an orphan guest).
3. Added `<webview>` regression test `WebViewTest.Shim_TestMoveBeforeKeepsGuest`
   (shim JS + C++), item F.
4. Added `<extensionoptions>` check
   `ExtensionWebUIEmbeddedOptionsTest.MoveBeforeKeepsGuest`, item G.
5. JS fix itself unchanged.

Full diff: `fix.final.diff`.

## E. Tests (browser_tests, out/Default)

| run | result | duration per run | DCHECK/crash |
|---|---|---|---|
| original new test (quote fix only), with fix, ×1 | PASS | 1667 ms | none |
| same, with fix, ×20 (`--gtest_repeat=20`, 4 jobs) | 20/20 PASS | median 1632 (1577–1679) ms | none |
| same, without JS fix, ×1 | FAIL (line 589: EvalJs → "JavaScriptExecuteRequestForTestsHandler was destroyed without running the callback…"; line 594: num_guests_created 2 ≠ 1) | 2361 ms | none |
| same, without fix, ×20 | 20/20 FAIL same way, no timeout | median 2529 (2475–2664) ms | none |
| hardened test, with fix, ×20 (2 jobs, machine loaded by cros build) | 20/20 PASS | median 4546 (3346–5803) ms | none |
| hardened test, with fix, ×20, idle machine | 20/20 PASS | median 1479 (1451–1917) ms | none |
| hardened test, without fix, ×20 | 20/20 FAIL at line 597, `Which is: "contentWindow changed"` | median 2492 (2204–2773) ms | none |
| neighbours `ControlledFrame*:*/ControlledFrame*:WebView*:*/WebView*` (237 tests, 10 jobs), patched | 216 pass / 21 fail | 79 s | none |
| same, unpatched | 215 pass / 22 fail; only diff = new test | 79 s | none |
| the 21 failures re-run serially (patched) | still 16 FAIL + 5 TIMEOUT | | none |

The 21 pre-existing failures: all `ControlledFrame*Clipboard*` /
`ClipboardReadWrite/*` / `ClipboardSanitizedWrite/*` time out in
`FocusControlledFrame` (window focus not available with headless ozone), and
`ControlledFrameDisabledPermissionFileSystemAccessTest.FileSystemAccess/IwaSucceedsButControlledFrameFails`
returns "error" (file chooser). Identical on both builds.

`WebViewTest.*`/`WebViewInteractiveTest.*`/`AppViewTest.*`/`WebViewAPITest.*`
are not built on Linux desktop (sources under `if (is_chromeos)`); see F.

## A–D. Measurements (real DCHECK build, headless Chrome over CDP)

Harness: `measure/harness.mjs` (+ `cdp.mjs`, `server.py`, `analyze.py`), repro
IWA in `repro/iwa`, guest pages in `repro/guest_site`. Chrome command line:
`out/Default/chrome --headless=new --remote-debugging-port=0
--user-data-dir=$PROFILE_DIR/<label>-<phase>
--enable-features=IsolatedWebApps,IsolatedWebAppDevMode
--disable-features=Vulkan --disable-gpu --no-first-run
--no-default-browser-check --password-store=basic --enable-logging=stderr
--window-size=1000,800 --install-isolated-web-app-from-url=http://127.0.0.1:8701/
about:blank`; app opened with CDP `Target.createTarget({url:
'isolated-app://<id>/', newWindow:true})` (creates an app window;
`PWA.launch` and `--app-id` do not work in `--headless=new`). The IWA manifest
needs `"cross-origin-isolated": ["self"]` in addition to
`"controlled-frame": ["self"]` (without it `crossOriginIsolated` is false and
`guestViewInternal.createGuest` is denied; the test `ManifestBuilder` adds it by
default). Guest "on-screen" identity: each guest document paints a colour
derived from (sessionStorage token, URL); the harness screenshots the pixel at
the element's centre and reads every guest target over CDP.

See `measure/tables_AD.md` (copied below).

## A

**unpatched**

| operation | same doc via API (timeOrigin+token) | API reaches on-screen doc | innerWidth via API before→after | on-screen guest innerWidth before→after (expected) | contentWindow after | load events on element after op | back() acts on on-screen page | src nav acts on on-screen page | guest targets after (by type) |
|---|---|---|---|---|---|---|---|---|---|
| control (nothing) | yes | yes | 300→300 | 300→300 (300) | non-null | none | yes | yes | tab:1, webview:1 |
| CSS transform | yes | yes | 300→300 | 300→300 (300) | non-null | none | yes | yes | tab:1, webview:1 |
| moveBefore same parent | no | no | 300→0 | 300→300 (300) | null | none | no | no | other:1, tab:2, webview:1 |
| moveBefore other parent | no | no | 300→0 | 300→500 (500) | null | none | no | no | other:2, tab:3, webview:1 |
| moveBefore of ancestor | no | no | 300→0 | 300→500 (500) | null | none | no | no | other:3, tab:4, webview:1 |
| same element moved 5x | no | no | 300→0 | 300→500 (500) | null | none | no | no | other:4, tab:5, webview:1 |
| appendChild to other parent | no | yes | 300→500 | 300→500 (500) | non-null | loadstart, loadcommit, loadstop | no | yes | other:4, tab:5, webview:1 |
| remove + re-append | no | yes | 300→300 | 300→300 (300) | non-null | loadstart, loadcommit, loadstop | no | yes | other:4, tab:5, webview:1 |

**patched**

| operation | same doc via API (timeOrigin+token) | API reaches on-screen doc | innerWidth via API before→after | on-screen guest innerWidth before→after (expected) | contentWindow after | load events on element after op | back() acts on on-screen page | src nav acts on on-screen page | guest targets after (by type) |
|---|---|---|---|---|---|---|---|---|---|
| control (nothing) | yes | yes | 300→300 | 300→300 (300) | non-null | none | yes | yes | tab:1, webview:1 |
| CSS transform | yes | yes | 300→300 | 300→300 (300) | non-null | none | yes | yes | tab:1, webview:1 |
| moveBefore same parent | yes | yes | 300→300 | 300→300 (300) | non-null | none | yes | yes | tab:1, webview:1 |
| moveBefore other parent | yes | yes | 300→500 | 300→500 (500) | non-null | none | yes | yes | tab:1, webview:1 |
| moveBefore of ancestor | yes | yes | 300→500 | 300→500 (500) | non-null | none | yes | yes | tab:1, webview:1 |
| same element moved 5x | yes | yes | 300→500 | 300→500 (500) | non-null | none | yes | yes | tab:1, webview:1 |
| appendChild to other parent | no | yes | 300→500 | 300→500 (500) | non-null | loadstart, loadcommit, loadstop | no | yes | tab:1, webview:1 |
| remove + re-append | no | yes | 300→300 | 300→300 (300) | non-null | loadstart, loadcommit, loadstop | no | yes | tab:1, webview:1 |

## B

**unpatched** (median (min–max) of 3 runs; each run a fresh browser and profile)

| N | mode | guest targets: webview | other | tab | total deduped targets | renderer processes | PSS MB (tree) | ΔPSS vs no-move, MB (median) | Δ"other" targets vs no-move |
|---|---|---|---|---|---|---|---|---|---|
| 0 | nomove | 0 (0–0) | 0 (0–0) | 0 (0–0) | 6 (6–6) | 11 (11–11) | 880.3 (879.6–883.9) | +0.0 | +0 |
| 0 | move | 0 (0–0) | 0 (0–0) | 0 (0–0) | 6 (6–6) | 11 (11–11) | 880.6 (879.9–881.6) | +0.3 | +0 |
| 1 | nomove | 1 (1–1) | 0 (0–0) | 1 (1–1) | 8 (8–8) | 12 (12–12) | 908.6 (903.3–913.5) | +0.0 | +0 |
| 1 | move | 1 (1–1) | 1 (1–1) | 2 (2–2) | 10 (10–10) | 12 (12–12) | 897.2 (895.3–900.2) | -11.4 | +1 |
| 5 | nomove | 5 (5–5) | 0 (0–0) | 5 (5–5) | 16 (16–16) | 12 (12–12) | 918.1 (917.1–921.7) | +0.0 | +0 |
| 5 | move | 5 (5–5) | 5 (5–5) | 10 (10–10) | 26 (26–26) | 12 (12–12) | 918.4 (916.4–921.0) | +0.3 | +5 |
| 20 | nomove | 20 (20–20) | 0 (0–0) | 20 (20–20) | 46 (46–46) | 12 (12–12) | 959.8 (954.7–960.4) | +0.0 | +0 |
| 20 | move | 20 (20–20) | 20 (20–20) | 40 (40–40) | 86 (86–86) | 12 (12–12) | 1001.7 (1001.0–1004.5) | +41.9 | +20 |
| 50 | nomove | 50 (50–50) | 0 (0–0) | 50 (50–50) | 106 (106–106) | 12 (12–12) | 1061.2 (1059.1–1063.0) | +0.0 | +0 |
| 50 | move | 50 (50–50) | 50 (50–50) | 100 (100–100) | 206 (206–206) | 12 (12–12) | 1174.6 (1170.6–1175.5) | +113.4 | +50 |

Slope (least squares over N of median move−no-move): +2.43 MB PSS per moved element; +1.00 extra "other" guest targets per moved element.

**patched** (median (min–max) of 3 runs; each run a fresh browser and profile)

| N | mode | guest targets: webview | other | tab | total deduped targets | renderer processes | PSS MB (tree) | ΔPSS vs no-move, MB (median) | Δ"other" targets vs no-move |
|---|---|---|---|---|---|---|---|---|---|
| 0 | nomove | 0 (0–0) | 0 (0–0) | 0 (0–0) | 6 (6–6) | 11 (11–11) | 882.9 (879.4–883.2) | +0.0 | +0 |
| 0 | move | 0 (0–0) | 0 (0–0) | 0 (0–0) | 6 (6–6) | 11 (11–11) | 881.4 (879.1–888.9) | -1.5 | +0 |
| 1 | nomove | 1 (1–1) | 0 (0–0) | 1 (1–1) | 8 (8–8) | 12 (12–12) | 911.0 (904.4–912.9) | +0.0 | +0 |
| 1 | move | 1 (1–1) | 0 (0–0) | 1 (1–1) | 8 (8–8) | 12 (12–12) | 896.6 (893.3–898.0) | -14.4 | +0 |
| 5 | nomove | 5 (5–5) | 0 (0–0) | 5 (5–5) | 16 (16–16) | 12 (12–12) | 930.1 (921.8–932.5) | +0.0 | +0 |
| 5 | move | 5 (5–5) | 0 (0–0) | 5 (5–5) | 16 (16–16) | 12 (12–12) | 912.1 (912.0–913.5) | -18.0 | +0 |
| 20 | nomove | 20 (20–20) | 0 (0–0) | 20 (20–20) | 46 (46–46) | 12 (12–12) | 957.7 (956.8–962.0) | +0.0 | +0 |
| 20 | move | 20 (20–20) | 0 (0–0) | 20 (20–20) | 46 (46–46) | 12 (12–12) | 968.1 (961.5–969.5) | +10.4 | +0 |
| 50 | nomove | 50 (50–50) | 0 (0–0) | 50 (50–50) | 106 (106–106) | 12 (12–12) | 1062.6 (1060.8–1065.3) | +0.0 | +0 |
| 50 | move | 50 (50–50) | 0 (0–0) | 50 (50–50) | 106 (106–106) | 12 (12–12) | 1072.6 (1071.5–1076.9) | +10.0 | +0 |

Slope (least squares over N of median move−no-move): +0.46 MB PSS per moved element; +0.00 extra "other" guest targets per moved element.

## C
| build | stage | guest targets webview/other/tab (median) | total targets | renderers | PSS MB median (min–max) |
|---|---|---|---|---|---|
| unpatched | baseline | 0/0/0 | 6 (6–6) | 11 (11–11) | 871.3 (867.9–872.2) |
| unpatched | after20Moves | 20/20/40 | 86 (86–86) | 12 (12–12) | 1001.5 (997.3–1004.4) |
| unpatched | afterRemoveAll | 0/20/20 | 46 (46–46) | 12 (12–12) | 1012.4 (1010.2–1013.8) |
| unpatched | afterReload | 0/20/20 | 46 (46–46) | 12 (12–12) | 1011.3 (1002.9–1011.9) |
| unpatched | afterCloseWindow | 0/0/0 | 4 (4–4) | 12 (12–12) | 998.6 (997.1–1001.6) |
| patched | baseline | 0/0/0 | 6 (6–6) | 11 (11–11) | 872.6 (870.2–875.3) |
| patched | after20Moves | 20/0/20 | 46 (46–46) | 12 (12–12) | 966.0 (963.1–969.3) |
| patched | afterRemoveAll | 0/0/0 | 6 (6–6) | 12 (12–12) | 979.4 (974.8–981.9) |
| patched | afterReload | 0/0/0 | 6 (6–6) | 12 (12–12) | 973.4 (968.7–977.8) |
| patched | afterCloseWindow | 0/0/0 | 4 (4–4) | 12 (12–12) | 964.3 (960.1–967.1) |

## D
| build | measurement | n | median ms | min ms | max ms | failures |
|---|---|---|---|---|---|---|
| unpatched | executeScript, no move (baseline) | 20 | 0.86 | 0.73 | 8.10 | 0 |
| unpatched | moveBefore() call | 20 | 0.38 | 0.21 | 2.81 | – |
| unpatched | move → next executeScript settles | 20 | 17.34 | 3.46 | 5001.77 | 12 (timeout 5000ms: 1; The tab was closed.: 11) |
| patched | executeScript, no move (baseline) | 20 | 0.82 | 0.76 | 6.24 | 0 |
| patched | moveBefore() call | 20 | 0.04 | 0.03 | 0.34 | – |
| patched | move → next executeScript settles | 20 | 0.80 | 0.73 | 3.50 | 0 (none) |

## DCHECK scan
unpatched A: browsers=1 dcheck/fatal lines=0 harness errors=0
unpatched B: browsers=30 dcheck/fatal lines=0 harness errors=0
unpatched C: browsers=3 dcheck/fatal lines=0 harness errors=0
unpatched D: browsers=1 dcheck/fatal lines=0 harness errors=0
patched A: browsers=1 dcheck/fatal lines=0 harness errors=0
patched B: browsers=30 dcheck/fatal lines=0 harness errors=0
patched C: browsers=3 dcheck/fatal lines=0 harness errors=0
patched D: browsers=1 dcheck/fatal lines=0 harness errors=0


## F. `<webview>` (linux-chromeos)

- Option 1 (`extensions_browsertests` / app_shell `WebViewAPITest`): not
  available — `WebViewAPITest`/`AppViewApiTest` live in
  `chrome/browser/extensions/BUILD.gn` under `if (is_chromeos)`; no app_shell
  web view tests exist on Linux in this checkout.
- Option 2 used: linux-chromeos per `docs/chromeos_build_instructions.md`
  (needs only `target_os = ['chromeos']` in `.gclient` + `gclient sync`; no
  sudo, no system packages). `out/cros/args.gn` = `target_os = "chromeos"`,
  `is_debug = false`, `dcheck_always_on = true`, `symbol_level = 0`,
  `is_component_build = true`. `browser_tests` build: 63 min at -j 16 (while
  other work ran) + 40 min at -j 24 = ~104 min. Tests run with
  `--ozone-platform=headless` (works for linux-chromeos browser_tests here).
- New regression test `WebViewTest.Shim_TestMoveBeforeKeepsGuest/{InnerWebContents,MPArch}`
  (shim JS `testMoveBeforeKeepsGuest` in
  `chrome/test/data/extensions/platform_apps/web_view/shim/main.js`, C++ in
  `chrome/browser/apps/guest_view/web_view_browsertest.cc`): moves within
  parent, to other parent, and the ancestor; checks `contentWindow` identity
  and an `executeScript` marker after each move; C++ checks 1 guest created,
  1 current, and that removal destroys it.

| run | result | notes |
|---|---|---|
| new webview test, patched, ×20 (2 variants, 2 jobs) | 40/40 PASS (29 s total) | no DCHECK |
| new webview test, unpatched, ×20 | 40/40 FAIL — console `contentWindow changed after moveBefore()`, `TEST_FAILED` at web_view_browsertest.cc:792 (ASSERT_NO_FATAL_FAILURE stops the test; no hang) | 30 s total, no DCHECK |

Wide run on `out/cros` browser_tests, filter
`*GuestView*:*WebView*:*ControlledFrame*:*AppView*:*ExtensionOptions*:*MimeHandlerView*:*IsolatedWebApp*:ExtensionWebUI*:*/ExtensionWebUI*`
(1787 run, 49 disabled, 12 jobs; patched 433 s, unpatched 435 s):

| suite group | patched pass/fail/crash/timeout | unpatched pass/fail/crash/timeout | differing tests |
|---|---|---|---|
| WebViewTest (incl. Shim_*) (462) | 456/0/6/0 | 454/2/6/0 | WebViewTest.Shim_TestMoveBeforeKeepsGuest/InnerWebContents, …/MPArch |
| WebViewNewWindowTest (60) | 60/0/0/0 | 60/0/0/0 | — |
| WebViewAPITest* (80) | 79/0/1/0 | 79/0/1/0 | — |
| Other WebView* / */WebView* suites (360) | 357/0/3/0 | 357/0/3/0 | — |
| AppViewTest (22) | 22/0/0/0 | 22/0/0/0 | — |
| AppViewApiTest (10) | 10/0/0/0 | 10/0/0/0 | — |
| ExtensionWebUI* / ExtensionOptions* (25) | 25/0/0/0 | 23/2/0/0 | ExtensionWebUIEmbeddedOptionsTest.MoveBeforeKeepsGuest/InnerWebContents, …/MPArch |
| ControlledFrame* (238) | 237/0/1/0 | 235/2/1/0 | ControlledFrameMoveBeforeTest.MoveBeforeKeepsGuest; ControlledFramePEPC/…Microphone/FailsBecauseNotAllow (flake: 10/10 pass when re-run serially on the unpatched build) |
| IsolatedWebApp* (464) | 451/12/1/0 | 451/12/1/0 | — |
| GuestView* / MimeHandlerView* / other (66) | 66/0/0/0 | 66/0/0/0 | — |

Pre-existing (identical on both builds), `F/cros_preexisting_nonpass.txt`:
- 11 context-menu crashes (`WebViewTest.TestContextMenu/*`,
  `ContextMenusAPI_PreventDefault/*`, `BlockOpenImageInNewTab/*`,
  `WebViewAPITest.TestContextMenu`, `ControlledFrameContextMenusTest.ShowEvent`,
  `ContextualTasks*WebViewTest.*`): SIGSEGV in
  `ash::MakoBubbleCoordinator::CacheContextCaretBounds()` from
  `RenderViewContextMenuViews::Show()` (no text input client in headless ash).
- **DCHECK (pre-existing, both builds):**
  `UnframedIsolatedWebAppBrowserTest.PopupResize_CanSubceedMinimumWindowSize_And_InnerAndOuterSizesAreCorrect`
  → `cc/layers/nine_patch_generator.cc:75 DCHECK failed: output_bounds_.width() >= border_.width() (53 vs. 72)`.
- 12 IWA failures (`IsolatedWebAppsWindowOpenPermissionService*` ×9,
  `ChromeDirectSocketsUdpIsolatedWebAppMulticastTest` ×2 (no multicast in this
  VM), `IsolatedWebAppRunOnOsLoginManagerBrowserTest`).


## G. Other elements registered via `registerElement()`

- `chrome/renderer/resources/controlled_frame/html_controlled_frame_element.js:189` — `<controlledframe>`
- `chrome/renderer/resources/extensions/web_view/chrome_web_view_element.js:40` — Chrome `<webview>` (ChromeWebViewElement)
- `extensions/renderer/resources/guest_view/web_view/extensions_web_view_element.js:39` — extensions `<webview>`
- `extensions/renderer/resources/guest_view/app_view/app_view_element.js:24` — `<appview>`
- `extensions/renderer/resources/guest_view/extension_options/extension_options_element.js:25` — `<extensionoptions>`

`<extensionoptions>` (Linux, out/Default browser_tests,
`ExtensionWebUI*:*/ExtensionWebUI*:ExtensionOptions*`, 4 jobs):

| build | result | new move check |
|---|---|---|
| patched | 21/21 pass | `MoveBeforeKeepsGuest/{InnerWebContents,MPArch}` ×20 each: 40/40 pass, median 3728 (3130–6191) ms (loaded machine) |
| unpatched | 19 pass / 2 fail (only the new check) | 40/40 FAIL: `num_guests_created()` 5 ≠ 2 (3 extra guests for 3 moves) and the original guest no longer exists; median 2579 (2266–3057) ms; no hang |

`<appview>`: tests are ChromeOS-only (see F).

On linux-chromeos (wide run above): `AppViewTest` 22/22 and `AppViewApiTest`
10/10 pass on both builds; `ExtensionWebUI*`/`ExtensionOptions*` 25/25
patched, 23/25 unpatched (only the new move check). No `<appview>` move check
was added: `<appview>` exposes no API to probe after `connect()` (no
`contentWindow`/`executeScript`), and a check needs the two-app embed
handshake plus browser-side guest counting — not cheap; whether a move breaks
`<appview>` without the fix is **unverified**.

## H. Blink side

- `run_web_tests.py` could not be used as-is: ports 8001/8443/8444 are held by
  other services on this host (worked around with a private
  `unshare --user --map-current-user --net` namespace), and then content_shell
  under the blinkpy driver aborts with
  `FATAL: widget_base.cc:769 Web tests require gpu compositing in single thread mode, but it is disabled`
  (headless ozone, no Xvfb on this host, no GPU allowed). Not solved; logs in
  `H/webtests_unpatched*`.
- Proof the fix cannot affect content_shell: after applying the JS fix and
  rebuilding `blink_tests`, `content_shell` and `content_shell.pak` are
  byte-identical (md5 `a7ba5e0c…`, `54ac9f19…`; only Chrome's `resources.pak`
  changed) — `H/md5_*.txt`.
- Instead, the WPT files were run in the real `chrome` (headless, CDP,
  static server for `external/wpt`; `H/wpt_in_chrome.mjs`), patched and
  unpatched: all `dom/nodes/moveBefore/*.html` (incl.
  `custom-element-move-reactions.html`, `moveBefore-subframe-count-crash.html`,
  `Node-moveBefore.html`), all `custom-elements/reactions/*.html`, and
  `container-timing/…/containertiming-root-moved-with-movebefore.html`
  (113 files; the 2 `.window.js` tests need wptserve and were skipped).

| build | files OK | harness timeout (no testharness: crash/ref tests) | renderer crash | subtests PASS/FAIL | DCHECK/FATAL |
|---|---|---|---|---|---|
| unpatched | 93 | 20 | 0 | 500 / 15 | 0 |
| patched | 93 | 20 | 0 | 500 / 15 | 0 |

0 files differ. The 15 failing subtests (identical in both) need input/
testdriver/wptserve features (hover, pointer capture, selection, fullscreen,
nonce header, aria-owns reactions, container timing).
- `blink_unittests` not built (time box).

## I. Hardened tests

See E (controlled frame), F (webview), G (extensionoptions). All three detect
the bug deterministically: controlled frame/webview via synchronous
`contentWindow` identity, extensionoptions via an ordered probe guest
(`createGuest` requests from one frame are handled in order).

## J. Wider run (out/Default browser_tests, 8 jobs)

Filter `*GuestView*:*WebView*:*ControlledFrame*:*AppView*:*ExtensionOptions*:*MimeHandlerView*:*IsolatedWebApp*`
(818 tests run, 28 disabled):

| build | pass | fail | crash | timeout | time |
|---|---|---|---|---|---|
| patched | 718 | 78 | 15 | 7 | 552 s |
| unpatched | 717 | 79 | 15 | 7 | 523 s |

Only difference: `ControlledFrameMoveBeforeTest.MoveBeforeKeepsGuest`
(pass patched, fail unpatched). The 100 identical non-passes are listed in
`J/preexisting_nonpass.txt`; likely causes: no window focus / no real window
manager with headless ozone (`IsolatedWebAppFocusBrowserTest` 28,
`UnframedIsolatedWebAppBrowserTest`, `IsolatedWebAppsWindowOpenPermission*`,
`IsolatedWebAppLinkCapturing*` — CHECKs `ui_test_utils.cc:1188 browser_` ×8 and
`ui_test_utils.cc:1104 web_contents_.size() >= 1u` ×3 when no browser window
appears), clipboard focus timeouts (`ControlledFrame*Clipboard*`), and
`lock.cc:39 Check failed: !app_id.empty()` ×2 in `All/IsolatedWebAppDevToolsTest`
— all CHECK (not DCHECK) and identical on both builds.

## Not exercised / caveats

- `<appview>` under `moveBefore` without the fix: not measured (see G).
- `blink_unittests` (e.g. `NodeTest`/`AccessibilityTest` moveBefore cases) not
  built; `run_web_tests.py`/content_shell could not run here (GPU compositing
  FATAL under the blinkpy driver with headless ozone; no Xvfb); WPT files ran
  in Chrome instead. content_shell is byte-identical with/without the fix.
- `WebViewInteractiveTest` (interactive_ui_tests) not built/run (needs a real
  focused display).
- ESLint: no `eslint.config.*` covers the touched JS paths (ESLint errors the
  same way on the unmodified files); only `node --check` was run. `git cl
  presubmit` not run (needs an upstream branch / network auth). `git cl format`
  run on all touched C++ (clean).
- Timings of I/G "patched" ×20 runs were taken while the cros build loaded the
  machine (except `I/cf_hardened_patched_x20_idle`: median 1479 ms, 1451–1917).
- PSS noise between identical configurations is about ±10–15 MB (B: N=1/5
  patched move vs no-move −14/−18 MB), so only the N=20/50 unpatched deltas
  (+42/+113 MB) are clearly above noise.
- After closing the app window, PSS stays ~90–130 MB above baseline in both
  builds (renderer/spare processes are kept); not investigated.


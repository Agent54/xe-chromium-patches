# `<controlledframe>.captureStream()` — prototype and measurements

All work was done locally (Linux VM, 30 cores, RTX 5090); nothing was pushed,
uploaded, filed or posted. Chromium 160.0.8176.0 (`9ce695914d1a`).

## State of the checkout

- Branch `movebefore-fix`: commit `29861dcac8` = the earlier uncommitted
  `connectedMoveCallback` fix + tests (identical to `results/fix.final.diff`).
- Branch `cf-capture-stream` (checked out, clean, all committed locally) on top:
  1. `3c0096d593` prototype: `webViewInternal.getCaptureStreamId` +
     `HTMLControlledFrameElement.captureStream()` + browser test.
  2. `a727c8e951` no "Sharing … to this tab" infobar for captures of an
     embedded guest (+ test assertion).
  3. `feb9033949` experiment: keep a captured guest rendering and aggregated
     while hidden (content/).
  4. `16c0006e9c` experiment: feature `ContentCaptureLetCapturerPickFormat`
     (default off) letting the capturer choose NV12.
- `capture.diff` = `git diff --src-prefix=a/ --dst-prefix=b/ movebefore-fix`
  (all four commits; 13 files, +442/−3).
- `keepalive_experiment.diff`: an earlier (superseded) version of commit 3.
- Builds: `out/Default` (is_debug=false, dcheck_always_on=true, symbol_level=0,
  component) and `out/Release` (same, dcheck_always_on=false) are both built at
  HEAD of `cf-capture-stream`.

## How things were run

- Tests: `runtests_cap.sh <name> <filter> <jobs> [args]`
  (`env -u DISPLAY -u WAYLAND_DISPLAY ./browser_tests --ozone-platform=headless …`).
- Static server: `python3 server.py 8711 8712` (IWA dev-mode proxy on 8711,
  guest pages on 8712). Demo/measurement IWA in `iwa/` (`main.js` measurement
  page, `demo.html/js` WebGL scene, `three.html/js` three-API page,
  `worker.js`), guest pages in `guest_site/`.
- Measurement harness: `node harness.mjs <label> <chrome> <phases> <sw|gpu|desktop>`
  (phases A N B C D E F L H), scaling: `node stress.mjs <label> <N> <track|screencast|none> <fps> [animated]`,
  demo recorder: `node demo.mjs <name> <query> <seconds> <gpu|desktop>`;
  `analyze.py` → `tables.md`; raw JSON and Chrome logs in `raw/`.
- Configurations (each table says which):
  - **sw**: `chrome --headless=new --disable-gpu` (software compositing).
  - **headless GPU**: `--headless=new --use-angle=gl-egl` → GPU compositing on
    the RTX 5090 (`ANGLE (NVIDIA … OpenGL ES 3.2)`), WebGPU = SwiftShader
    fallback adapter.
  - **headless Vulkan**: features `Vulkan` + `--use-angle=vulkan
    --disable-vulkan-surface` → real NVIDIA WebGPU adapter (blackwell) but
    software display compositing (only used for the WebGPU import check).
  - **real window**: `--ozone-platform=x11` on the session's Xwayland
    (`DISPLAY=:0`) on a temporary Hyprland headless output
    1920×1080@60, `--force-device-scale-factor=1`; GPU compositing via ANGLE on
    OpenGL 4.5 (NVIDIA). This is the primary configuration for the stress
    numbers and the videos.
  - Wayland (`--ozone-platform=wayland`) in the DCHECK build dies with a browser
    DCHECK `cc/trees/presentation_time_callback_buffer.cc:135 (61 vs. 60)` on a
    Hyprland headless output (no presentation feedback); not used.
  - `grim` returns black for Hyprland headless outputs; window video/stills were
    taken with ffmpeg `x11grab` / ImageMagick `import` of the Chrome X11 window.

## Design chosen and why

**Route 1, via `content::DesktopStreamsRegistry` + `DesktopCaptureAccessHandler`.**

- New `webViewInternal.getCaptureStreamId(instanceId)` (extensions function,
  next to `captureVisibleRegion`). Browser side it:
  1. resolves the guest with the existing `WebViewInternalExtensionFunction`
     prevalidation (`WebViewGuest::FromInstanceID(source_process_id, id)`: the
     guest's owner must be in the caller's process; otherwise the guest view
     manager kills the caller as a bad renderer, existing behaviour);
  2. requires `guest.owner_rfh() == render_frame_host()` (the calling frame is
     the frame that owns the guest; a same-process sibling frame is refused);
  3. refuses if the guest main frame's WebContents is the embedder's own
     WebContents (that is the `GuestViewMPArch` case, where a WebContents
     capture would capture the whole app);
  4. registers `DesktopMediaID(TYPE_WEB_CONTENTS, WebContentsMediaCaptureId(guest
     main frame process id, routing id))` in `DesktopStreamsRegistry`, bound to
     the embedder's primary main frame (process + routing id — this is what
     `DesktopCaptureAccessHandler` checks against) and the caller's origin,
     type `kRegistryStreamTypeDesktop`. The registry makes the id single-use and
     expires it after 10 s.
- `HTMLControlledFrameElement.prototype.captureStream(options)` (JS, in
  `chrome/renderer/resources/controlled_frame/html_controlled_frame_element.js`)
  calls it and then `navigator.mediaDevices.getUserMedia({audio: false, video:
  {mandatory: {chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth,
  maxHeight, maxFrameRate, ...}}})`, resolving to the `MediaStream`.
- Content then does what it already does for `chrome.desktopCapture` ids of
  type WEB_CONTENTS: `WebContentsVideoCaptureDevice` → `WebContentsFrameTracker`
  (finds the guest `WebContents` from the RFH id, increments its capturer
  count, targets its `RenderWidgetHostViewChildFrame` frame sink) →
  `FrameSinkVideoCapturer` in viz.

Why this route:
- `DesktopCaptureAccessHandler` is the only existing no-picker path that
  accepts a pre-registered id from **any** origin, including non-extension
  origins (`isolated-app://`): with a non-empty `chromeMediaSourceId` it calls
  `DesktopStreamsRegistry::RequestMediaForStreamId(id, main frame process,
  main frame routing id, request origin)` and accepts without UI. The
  "approval" is whatever the registering code decided — here, ownership of the
  guest. It also already handles `TYPE_WEB_CONTENTS` and checks the captured
  WebContents still exists.
- `chrome.tabCapture.getMediaStreamId` / `TabCaptureAccessHandler` were not
  usable: `TabCaptureRegistry` lives in `//chrome` (the `webViewInternal`
  functions live in `//extensions`, which cannot depend on it), its requests
  are keyed by an extension id (`AddRequest(target, extension_id, ...)`) and
  `getMediaStreamId` itself requires an extension with `tabCapture`
  permission; IWAs are not extensions.
- `getDisplayMedia` / `DisplayMediaAccessHandler` always shows a picker (or
  needs policy) — excluded by the requirements.
- Element/Region Capture (`RestrictionTarget.fromElement(controlledframe)`)
  works on a capture of the app's own tab, which itself needs
  `getDisplayMedia` + a prompt, and captures what is composited on screen.
- No new Mojo interface, no new access handler, no change in content for the
  basic prototype. The only new browser code is the ~40-line extension function.

Files touched (prototype, commit `3c0096d593` on `cf-capture-stream`):
- `extensions/common/api/web_view_internal.json` — schema for
  `getCaptureStreamId`.
- `extensions/browser/api/guest_view/web_view/web_view_internal_api.{h,cc}` —
  `WebViewInternalGetCaptureStreamIdFunction`.
- `extensions/browser/extension_function_histogram_value.h`,
  `tools/metrics/histograms/metadata/extensions/enums.xml` — new function
  histogram value `WEBVIEWINTERNAL_GETCAPTURESTREAMID = 1997`.
- `chrome/renderer/resources/controlled_frame/html_controlled_frame_element.js`
  — `captureStream()`.
- `chrome/test/data/controlled_frame/resources/expected_properties.json` —
  new property `captureStream` (keeps `ElementHasExpectedProperties` passing).
- `chrome/browser/controlled_frame/controlled_frame_apitest.cc` — new test
  `ControlledFrameCaptureStreamTest.CaptureStream`.

## A. Does it work?

Yes. In every configuration tried (headless software, headless GPU, real X11
window with GPU), `frame.captureStream()` resolves in ~35–60 ms to a
`MediaStream` with one video track whose frames show the guest's pixels.

Content check (guest paints four quadrants: TL red, TR green, BL blue,
BR yellow; samples at the quadrant centres, 640×360 guest):

| config | path | TL | TR | BL | BR | frame |
|---|---|---|---|---|---|---|
| headless, software compositing | `<video>` → 2D canvas | 255,26,1 | 0,215,1 | 0,14,251 | 255,241,2 | 640×360 |
| headless, software compositing | MSTP → VideoFrame → OffscreenCanvas | 255,26,1 | 0,215,1 | 0,14,251 | 255,241,2 | I420 640×360, BT.709 limited range |
| headless, GPU compositing (gl-egl) | `<video>` → 2D canvas | 255,1,0 | 0,255,1 | 1,0,255 | 254,255,0 | 640×360 |
| headless, GPU compositing (gl-egl) | MSTP → VideoFrame → OffscreenCanvas | 255,1,3 | 0,255,11 | 1,0,243 | 254,255,12 | I420 640×360 |

All four quadrants are recognisably right in every case. Under software
compositing the green/red channels are visibly off (215 instead of 255 for
green): the RGB→I420 conversion in the software capture path does not
round-trip exactly; not investigated further (it is not specific to this patch:
it is the same `FrameSinkVideoCapturer` path tab capture uses).

`VideoFrame.copyTo()` works (I420, 3 planes, 345 600 bytes for 640×360).

Two things in the harness needed care (not bugs in the patch):
- a detached `<video>` or one started with `play()` without `autoplay` drew
  black into a canvas in these headless app windows; with `autoplay` and the
  element in the DOM it works. In the IWA app window `video.play()` never
  settles (also with `canvas.captureStream()`, i.e. without this patch), and
  when such a never-settled play promise is garbage-collected the DCHECK
  `ScriptPromiseResolverBase was not properly detached` (created in
  `HTMLMediaElement::playForBindings`) fires — see H.
- dedicated workers do not start in the dev-mode (proxy) IWA at all (no
  error, no target), with or without capture; the same `worker.js` works on a
  normal http page. So "VideoFrame in a worker" is **unverified** (E).

Ownership (also covered by the browser test, G):

| who uses the id | result |
|---|---|
| the owning app frame (first use) | OK, live track |
| the owning app frame, same id again | `AbortError: Error starting tab capture` (single-use) |
| a second window of the same app (same origin, other frame) | `AbortError: Error starting tab capture` |
| a page of another origin (http://127.0.0.1:8712 tab) | `AbortError: Error starting tab capture` |
| the guest itself | `NotAllowedError: Invalid state` |
| browser-side `getCaptureStreamId` from a same-process non-owner frame (iframe of the app) | error "Only the embedder of the guest can capture it" |
| browser-side `getCaptureStreamId` from another process naming the guest | existing guest-view check kills that renderer (`GVM_EMBEDDER_FORBIDDEN_ACCESS_TO_GUEST`), error "Could not find guest" |

Page JS can see its own id (the element calls `navigator.mediaDevices.getUserMedia`
in the page's world, so a page can intercept it), which is harmless: it is the
owner's id, single-use, bound to the owner's main frame and origin, and expires
after 10 s. A production version should call getUserMedia from the bindings'
private copy instead.

## C. Constraints

| guest | constraints | delivered | fps |
|---|---|---|---|
| animated | none | 640×360 (layout size) | 30 (default frame rate of this source) |
| animated | maxWidth/maxHeight 640×360 | 640×360 | 30 |
| animated | 320×180 | 320×180 | 30 |
| animated | 320×320 | 320×180 (aspect kept, no letterbox) | 30 |
| animated | max 1280×720 | 640×360 (no upscaling) | 30 |
| animated | min=max 1280×720 | 1280×720 (upscaled) | 30 |
| animated | maxFrameRate 10 | 640×360 | 10 |
| animated | maxFrameRate 5, 320×180 | 320×180 | 5 |
| animated | maxFrameRate 60 | 640×360 | 60 |
| animated | maxFrameRate 120 | 640×360 | 60 (the begin-frame rate here) |
| static | none | one frame on start, then 0/s | damage-driven |

Constraints work as for tab capture. Delivery is damage-driven: a static guest
sends one frame (plus a refresh frame for each new sink, e.g. a cloned track)
and nothing after. `getSettings()` right after the promise resolves sometimes
reports 800×600 (the capturer's default before the first frame) and settles to
the real size later.

## D. Several at once

8 guests, each painting a different solid colour, captured simultaneously into
8 tracks: every track's first frame has its own guest's colour (red, green,
blue, yellow, magenta, cyan, white, olive), no mix-ups. 8 animated guests at
320×180: 30 fps on every track (default), 60 fps with `maxFrameRate: 60`.
Two simultaneous tracks of the same guest also work. Scaling to 64: see the
stress section.


## B. Visibility

Per state: 2 s windows; the guest is a 640×360 animated canvas page. "guest
rAF" = the guest page's own requestAnimationFrame rate. Prototype without the
content experiment (commits 1–2) first, then with it (commit 3).

Summary:
- **Prototype only**: frames keep coming at full layout size (640×360) when the
  element is visible, `opacity:0`, scaled to 5 % with a transform, half
  scrolled out, or just (40 px) off-screen. They stop (0 fps) when the element
  is scrolled far out, `visibility:hidden`, `display:none`, or the app window is
  minimised (headless). CDP screencast stops in every state where the guest is
  hidden (it does not make the guest visible).
- **Capturing makes a hidden guest keep rendering**: the capturer count
  (`IncrementCapturerCount(stay_hidden=false)`) makes the guest
  `visibilityState: visible` with rAF at 60/s even where no frames are
  delivered (wasted work in the prototype).
- **Why no frames when hidden**: the embedder stops referencing/drawing the
  guest surface, and for an off-screen remote frame the embedder sends an empty
  `compositor_viewport` (and `display:none` a zero size), so Viz never
  aggregates the guest surface and the guest rasters nothing new.
  Also: a remote frame larger than the embedder viewport is only rastered for
  the viewport + 15 % margins (`RemoteFrameView::ComputeCompositingRect`): in
  the browser test's 500×42 app window a 320×240 guest was captured as 320×56.
- **Delivered size** = the guest's layout size (scaled down to fit
  maxWidth/maxHeight with aspect kept, upscaled only with min constraints), not
  the on-screen (transformed) size.
- **Experiment (commit 3)**: while an inner WebContents is captured, (a) keep its
  current surface referenced from the outermost root compositor with
  `ui::Compositor::TakeScopedKeepSurfaceAliveCallback` (the same mechanism
  `SurfaceEmbedConnectorImpl::UpdateKeepSurfaceAlive` already uses), refreshed
  when the capturer count or the guest's LocalSurfaceId changes, and (b) give
  the captured guest its full frame as `compositor_viewport`. With (a) alone,
  `visibility:hidden` delivered; with (a)+(b) the track delivers 30 fps at
  640×360 in **every** state tested, including far scrolled out and
  `display:none` (real X11 window; "minimised" is not meaningful there because
  Hyprland/Xwayland did not hide the minimised window). Frame counts only;
  pixels in hidden states were not separately verified.

### B. Visibility — software compositing (--disable-gpu)

| state | no capture: guest visibilityState / rAF per s | track: fps / frame size / guest rAF per s | CDP screencast: fps / frame size / guest visibilityState / rAF per s |
|---|---|---|---|
| visible | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60.5 / 640x360 / visible / 60 |
| opacity:0 | visible / 1 | 30 / 640x360 / 60 (guest visible) | 60.5 / 640x360 / visible / 60 |
| scale(0.05) | visible / 60.5 | 30.5 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| half scrolled out (top 180px of 360 off-screen) | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| just scrolled out (element 40px above viewport) | hidden / 0 | 30 / 640x360 / 60.5 (guest visible) | 0 / – / hidden / 0 |
| scrolled out | hidden / 0 | 0 / – / 60.5 (guest visible) | 0 / – / hidden / 0 |
| visibility:hidden | hidden / 0 | 0 / – / 1 (guest visible) | 0 / – / hidden / 0 |
| display:none | hidden / 0 | 0 / – / 60.5 (guest visible) | 0 / – / hidden / 0 |
| other window active | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| app window minimized | hidden / 0 | 0 / – / 0 (guest visible) | 0 / – / hidden / 0 |

### B. Visibility — GPU compositing (NVIDIA, --use-angle=gl-egl)

| state | no capture: guest visibilityState / rAF per s | track: fps / frame size / guest rAF per s | CDP screencast: fps / frame size / guest visibilityState / rAF per s |
|---|---|---|---|
| visible | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| opacity:0 | visible / 1 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| scale(0.05) | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| half scrolled out (top 180px of 360 off-screen) | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| just scrolled out (element 40px above viewport) | hidden / 0 | 30 / 640x360 / 60.5 (guest visible) | 0 / – / hidden / 0 |
| scrolled out | hidden / 0 | 0 / – / 60.5 (guest visible) | 0 / – / hidden / 0 |
| visibility:hidden | hidden / 0 | 0 / – / 1 (guest visible) | 0 / – / hidden / 0 |
| display:none | hidden / 0 | 0 / – / 60.5 (guest visible) | 0 / – / hidden / 0 |
| other window active | visible / 60 | 30.5 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| app window minimized | hidden / 0 | 0 / – / 0 (guest visible) | 0 / – / hidden / 0 |

### B. Visibility — real X11 window, + keep-alive of the guest surface (experiment, part 1)

| state | no capture: guest visibilityState / rAF per s | track: fps / frame size / guest rAF per s | CDP screencast: fps / frame size / guest visibilityState / rAF per s |
|---|---|---|---|
| visible | visible / 60 | 30.5 / 640x360 / 60.5 (guest visible) | 60.5 / 640x360 / visible / 60 |
| opacity:0 | visible / 1 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| scale(0.05) | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| half scrolled out (top 180px of 360 off-screen) | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| just scrolled out (element 40px above viewport) | hidden / 0 | 30 / 640x360 / 60 (guest visible) | 0 / – / hidden / 0 |
| scrolled out | hidden / 0 | 0 / – / 60 (guest visible) | 0 / – / hidden / 0 |
| visibility:hidden | hidden / 0 | 30 / 640x360 / 60 (guest visible) | 0 / – / hidden / 0 |
| display:none | hidden / 0 | 0 / – / 60 (guest visible) | 0 / – / hidden / 0 |
| other window active | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60.5 / 640x360 / visible / 60 |
| app window minimized | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |

### B. Visibility — real X11 window, + keep-alive + full compositor viewport for captured guests (both experiments)

| state | no capture: guest visibilityState / rAF per s | track: fps / frame size / guest rAF per s | CDP screencast: fps / frame size / guest visibilityState / rAF per s |
|---|---|---|---|
| visible | visible / 60 | 30.5 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| opacity:0 | visible / 1 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |
| scale(0.05) | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60.5 / 640x360 / visible / 60 |
| half scrolled out (top 180px of 360 off-screen) | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60 / 640x360 / visible / 60 |
| just scrolled out (element 40px above viewport) | hidden / 0 | 30 / 640x360 / 60.5 (guest visible) | 0 / – / hidden / 0 |
| scrolled out | hidden / 0 | 30 / 640x360 / 60 (guest visible) | 0 / – / hidden / 0 |
| visibility:hidden | hidden / 0 | 30 / 640x360 / 60 (guest visible) | 0 / – / hidden / 0 |
| display:none | hidden / 0 | 30.5 / 640x360 / 60 (guest visible) | 0 / – / hidden / 0 |
| other window active | visible / 60 | 30 / 640x360 / 60 (guest visible) | 60.5 / 640x360 / visible / 60 |
| app window minimized | visible / 60 | 30 / 640x360 / 60.5 (guest visible) | 60 / 640x360 / visible / 60 |

#### C tables (raw)

### C. Constraints — software compositing (guest layout size 640x360)

| guest | constraints | getSettings() w×h@fps | delivered sizes | frames in 1st s | frames/s in s 2–4 |
|---|---|---|---|---|---|
| anim | `{}` | 800×600@30 | 640x360 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 640, "maxHeight": 360}` | 640×360@30 | 640x360 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 320, "maxHeight": 180}` | 320×180@30 | 320x180 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 320, "maxHeight": 320}` | 320×320@30 | 320x180 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 1280, "maxHeight": 720}` | 1280×720@30 | 640x360 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 1280, "maxHeight": 720, "minWidth": 1280, "minHeight": 720}` | 1280×720@30 | 1280x720 | 30 | [30, 30, 30] |
| anim | `{"maxFrameRate": 10}` | 800×600@10 | 640x360 | 10 | [10, 10, 10] |
| anim | `{"maxFrameRate": 5, "maxWidth": 320, "maxHeight": 180}` | 320×180@5 | 320x180 | 5 | [5, 5, 5] |
| static | `{}` | 800×600@30 | 640x360 | 1 | [0, 0, 0] |

### C. Constraints — real X11 window, final build (guest layout size 640x360)

| guest | constraints | getSettings() w×h@fps | delivered sizes | frames in 1st s | frames/s in s 2–4 |
|---|---|---|---|---|---|
| anim | `{}` | 640×360@30 | 640x360 | 30 | [30, 31, 29] |
| anim | `{"maxWidth": 640, "maxHeight": 360}` | 640×360@30 | 640x360 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 320, "maxHeight": 180}` | 320×180@30 | 320x180 | 31 | [30, 30, 30] |
| anim | `{"maxWidth": 320, "maxHeight": 320}` | 320×320@30 | 320x180 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 1280, "maxHeight": 720}` | 1280×720@30 | 640x360 | 30 | [30, 30, 30] |
| anim | `{"maxWidth": 1280, "maxHeight": 720, "minWidth": 1280, "minHeight": 720}` | 1280×720@30 | 1280x720 | 31 | [30, 31, 30] |
| anim | `{"maxFrameRate": 10}` | 1920×1080@10 | 640x360 | 10 | [10, 10, 10] |
| anim | `{"maxFrameRate": 5, "maxWidth": 320, "maxHeight": 180}` | 320×180@5 | 320x180 | 5 | [5, 5, 5] |
| static | `{}` | 1920×1080@30 | 640x360 | 1 | [0, 0, 0] |

## E. Consumption, pixel format, storage

| config | `VideoFrame.format` / storage | `texImage2D(video)` WebGL2 | WebGPU `importExternalTexture(VideoFrame)` | `<video>`→2D canvas |
|---|---|---|---|---|
| headless sw (`--disable-gpu`) | I420, shared memory (`copyTo` works) | no WebGL (GPU disabled) | no adapter | OK |
| headless GPU (gl-egl, NVIDIA) | I420, shared memory | OK, correct colours; upload 640×360 median 0.13 ms | OK on the SwiftShader fallback adapter, correct colours | OK |
| headless Vulkan (NVIDIA WebGPU, software compositing) | I420 | OK (ANGLE/Vulkan NVIDIA) | OK on the **real NVIDIA adapter** (blackwell, not fallback), correct colours | OK |
| real X11 window (GPU) | I420 | OK (NVIDIA OpenGL 4.5) | OK on SwiftShader fallback (ANGLE/Vulkan in the window crashes the GPU process: ANGLE `DmaBufImageSiblingVkLinux.cpp:612` unreachable) | OK |
| worker: `MediaStreamTrackProcessor` readable transferred to a dedicated worker | **unverified**: dedicated workers do not start in the dev-mode IWA at all (no error, no target; also without capture); the same worker.js works on a plain http page | | | |

Three-API clip (`demo/stage4-three-apis.mp4`, real window): the same 4 live
tracks through 2D `drawImage(<video>)`, WebGL2 `texImage2D(VideoFrame)` and
WebGPU `importExternalTexture(VideoFrame)` side by side: 49–50 fps per panel,
~49–50 frames/s delivered per track per panel.

The frames are **never GPU-backed in this path**: Blink requests I420 for every
content-capture track, and viz delivers I420 only from a shared-memory pool
(GPU→CPU readback per frame under GPU compositing; CPU conversion under
software compositing). Details and the NV12 experiment below.

### NV12 / GPU-backed experiment (commit 4)

With `--enable-features=ContentCaptureLetCapturerPickFormat` the track asks for
`PIXEL_FORMAT_UNKNOWN`; under GPU compositing `FrameSinkVideoCaptureDevice`
then does pick NV12 (`texture_rg` available on ANGLE/NVIDIA) and viz tries to
allocate a `MappableSharedImageVideoFramePool` frame. On this machine that
allocation fails in every configuration tried, so `getUserMedia` rejects with
"Could not start video source":

| config | result | log |
|---|---|---|
| real X11 window (Xwayland) | fails | `gbm_support_x11.cc:48 dri3 extension not supported`, `Can't create buffer -- gbm device is missing`, `ozone_image_backing_factory.cc:107 Failed to create pixmap 380x214 (Y_UV, 420, 8unorm) usage SCANOUT_CPU_READ_WRITE`, `renderable_mappable_shared_image_video_frame_pool.cc:264 Failed to allocate shared image`, `frame_sink_video_capturer_impl.cc:952 Unable to allocate frame for first frame capture: OOM?` |
| real X11 window + `--enable-native-gpu-memory-buffers` | same | same |
| headless GPU (gl-egl) | same (no GBM device in headless ozone) | same pool error |
| real **Wayland** window, out/Release (Wayland works there; the presentation DCHECK only kills the DCHECK build) | NV12 pixmap (dmabuf) is allocated, but importing it fails; tracks reject with "Timeout starting video source" | `native_pixmap_egl_binding.cc:96 Unable to initialize binding from pixmap` (NVIDIA EGL import of the NV12 dmabuf) |
| real Wayland window, out/Release, feature off (I420) | works: 8 tracks at 59 fps | – |

So the NV12 path needs native pixmaps (GBM/DMA-BUF) on Linux that the GPU
driver can also import: Xwayland here has no DRI3 (no GBM device at all), and
on Wayland the NVIDIA driver allocates the NV12 dmabuf but EGL cannot bind it. On macOS the same pool allocates IOSurfaces, on
Windows D3D textures; that is where this one-line request change would give
GPU-backed NV12 frames. Not measured here (no N = 8…64 NV12 table): the
allocation failure is the blocker. A fallback worth considering in a real
patch: request NV12 only when the GPU process reports native NV12 GMB support,
otherwise keep I420.

## "Doesn't Chromium have a way to keep it on the GPU?" — source findings

What decides the frame storage for this track:

1. Blink builds the capture params for every content-capture track
   (tab/desktop/`chromeMediaSource`) in
   `third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_video_content.cc`
   (`SelectResultFromCandidates` → `media::VideoCaptureParams`) with a hard-coded
   `media::PIXEL_FORMAT_I420`.
2. `content/browser/media/capture/frame_sink_video_capture_device.cc`:
   `GetDesiredVideoPixelFormat()` returns the requested format if it is not
   `PIXEL_FORMAT_UNKNOWN`. Only for UNKNOWN does it pick NV12, and only when
   `CanSupportNV12Format()`: GPU compositing enabled, not SwiftShader, GPU
   capabilities known and `texture_rg` supported.
3. The buffer preference defaults to `kPreferMappableSharedImage` for tab
   capture (`in_process_video_capture_device_launcher.cc`,
   `DoStartTabCaptureOnDeviceThread`), unless the launcher was created with
   `SetPreferSharedMemoryBuffers()` (DevTools display capture).
4. viz, `frame_sink_video_capturer_impl.cc` `GetVideoFramePoolForFormat()`:
   `PIXEL_FORMAT_I420` → always `SharedMemoryVideoFramePool` (the
   CopyOutputRequest result `I420_PLANES` is read back from the GPU into shared
   memory); `PIXEL_FORMAT_NV12` → `MappableSharedImageVideoFramePool`
   (CopyOutputRequest `NV12` written into a mappable SharedImage, i.e. a
   GpuMemoryBuffer: a native pixmap/DMA-BUF on Linux, an IOSurface on macOS,
   a D3D texture on Windows). ARGB with a shared-image preference also goes to
   the mappable pool.

So no flag in this checkout makes a `getUserMedia` content-capture track
GPU-backed: the I420 request comes from Blink. Paths that do get NV12 shared
images are those that pass UNKNOWN or NV12 (e.g. `desktop_capture_device_mac.cc`
sets NV12 for its own ScreenCaptureKit capturer; the WebContents/FrameSink
devices only when asked with UNKNOWN). On macOS the same Blink request applies,
so a `<controlledframe>` track would be I420 in shared memory there too, with a
GPU→CPU readback per frame, unless the request changes.

Experiment (see table E-NV12): a local, disabled-by-default feature
`ContentCaptureLetCapturerPickFormat` that makes Blink request
`PIXEL_FORMAT_UNKNOWN` instead of I420.

## A direct route without the media capture device (sketch, not implemented)

What exists:
- `texElementSubImage2D` (WebGL), `drawElementImage` (2D) and
  `GPUQueue.drawElementImageToTexture` (WebGPU) are built and enabled
  (`CanvasDrawElement`, status stable in this checkout) for children of
  `<canvas layoutsubtree content=drawable>` that have the `drawable`
  attribute. Tested here: a same-document `<div>` draws correctly; a
  cross-origin `<iframe>` and a `<controlledframe>` draw as fully transparent
  pixels (no error). The element is painted in the embedder renderer into a
  paint record; a remote frame is only a `SurfaceLayer`/foreign layer there,
  its pixels live in viz and are never available to the embedder renderer.

What a direct route would need:
1. Browser/viz: a per-guest "copy surface to texture" request: issue a
   `viz::CopyOutputRequest` on the guest's frame sink (the guest's
   `RenderWidgetHostViewChildFrame::GetFrameSinkId()`) with
   `ResultFormat::RGBA` and `ResultDestination::kNativeTextures`, so the result
   is a SharedImage in the GPU process (no readback).
   Files: `content/browser/renderer_host/render_widget_host_view_child_frame.cc`
   (it already has `CopyFromSurface` for bitmaps), a texture variant next to it.
2. A way to hand that SharedImage to the embedder renderer: a new Mojo method
   (e.g. on a guest-view or WebView interface bound for the embedder frame)
   returning an `ExportedSharedImage` + sync token, with ownership/lifetime
   rules (who destroys it, how many in flight), and only for the owning
   embedder (same check as `getCaptureStreamId`).
3. Blink: accept a `<controlledframe>` (or an opaque handle obtained from it)
   in `texElementSubImage2D` / `drawElementImageToTexture`, and import the
   SharedImage into the WebGL/WebGPU context
   (`third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`,
   `.../webgpu/gpu_queue.cc`; the same kind of import already exists for
   `AcceleratedStaticBitmapImage` and for VideoFrames backed by SharedImages).
4. Scheduling: a pull model (one copy per call) is a GPU blit per frame per
   guest, cheaper than the capture path's readback but still a copy; true
   zero-copy (sampling the guest's own surface texture) is not possible
   across viz clients without new viz support.
Main obstacles: new cross-process API surface (Mojo + security review),
SharedImage lifetime/sync across three processes, MPArch guests (frame sink
lookup differs), and the privacy rules of HTML-in-canvas (which deliberately
excludes cross-origin content; here the embedder owns the guest, so a
guest-only exception is defensible, but it is a spec/security discussion).

A much cheaper step that keeps the current design: make the capture track
request NV12/UNKNOWN (experiment above). Then frames are GPU SharedImages
(NV12) and WebGL/WebGPU can import them without a CPU copy
(`importExternalTexture`, `texImage2D(VideoFrame)` on a GPU-backed frame);
what remains is one GPU-side RGB→NV12 conversion per frame.

## F. Cost

Caveat that applies to everything here: this VM's GPU path is Linux/NVIDIA
(ANGLE on GL), headless or an X11 window on Xwayland. The captured frames are
I420 in shared memory with a GPU→CPU readback in the GPU process per frame. On
macOS the same Blink request (I420) applies, so the same readback would
happen; the numbers here therefore do cover encode/transport/decode savings
versus the screencast (JPEG encode in the browser, base64 + JSON over CDP, JS
base64 decode and JPEG decode in the app), but **not** a zero-copy
IOSurface/NV12 path, which this prototype does not use on any platform. What
would carry over to macOS: the relative cost of screencast vs track (browser +
embedder CPU), the damage-driven delivery, the visibility behaviour. What would
not: absolute GPU-process cost and the ~530 frames/s ceiling (depends on the
readback cost of the GPU/driver), software-compositing numbers.

### F1. N = 1 and 8 guests, 640×360, CDP screencast vs track (3 runs each, median)

### F. Cost — software compositing (--disable-gpu) (3 runs, median per cell; CPU in % of one core, 10 s windows)

Viewport 2592x1468; each guest 640×360, animated (rAF canvas + 42-bit timestamp strip); track constraints maxWidth 640 / maxHeight 360; screencast `format: jpeg, quality: 72, maxWidth: 640, maxHeight: 360`, each frame acked and forwarded by the CDP client (node) to the app with `Runtime.callFunctionOn`, decoded there with `createImageBitmap`. "renderer" = other renderer processes (spare/about:blank).


**N = 1**

| mode | delivered fps per guest (median) | browser | gpu-process | embedder renderer | guest renderer(s) | utility:NetworkService | renderer | other | total | client(node) |
|---|---|---|---|---|---|---|---|---|---|---|
| idle (guests animating, no capture) | – | 21.2 | 3.6 | 0.1 | 8.6 | 9.8 | 1.1 | 0.2 | 44.7 | – |
| track (default 30 fps) | 30.1 | 1.7 | 6.3 | 1.5 | 9.0 | 0.0 | 0.0 | 0.0 | 18.4 | – |
| track, maxFrameRate 60 | 60.1 | 3.7 | 7.4 | 3.0 | 9.2 | 0.1 | 1.7 | 0.0 | 25.0 | – |
| CDP screencast | 60.1 | 25.0 | 8.0 | 18.1 | 10.7 | 0.0 | 0.0 | 0.0 | 61.8 | 3.9 |

**N = 8**

| mode | delivered fps per guest (median) | browser | gpu-process | embedder renderer | guest renderer(s) | utility:NetworkService | renderer | other | total | client(node) |
|---|---|---|---|---|---|---|---|---|---|---|
| idle (guests animating, no capture) | – | 5.1 | 14.1 | 0.7 | 80.5 | 1.9 | 0.2 | 0.5 | 102.1 | – |
| track (default 30 fps) | 30.1 | 10.2 | 37.5 | 7.2 | 89.0 | 0.6 | 0.1 | 0.4 | 145.1 | – |
| track, maxFrameRate 60 | 60.1 | 12.9 | 46.3 | 11.0 | 91.1 | 0.0 | 0.0 | 0.0 | 160.9 | – |
| CDP screencast | 60.1 | 206.5 | 56.4 | 170.3 | 122.0 | 0.0 | 0.0 | 0.0 | 555.8 | 24.8 |

### F. Cost — GPU compositing (NVIDIA RTX 5090, ANGLE on GL/EGL) (3 runs, median per cell; CPU in % of one core, 10 s windows)

Viewport 2592x1468; each guest 640×360, animated (rAF canvas + 42-bit timestamp strip); track constraints maxWidth 640 / maxHeight 360; screencast `format: jpeg, quality: 72, maxWidth: 640, maxHeight: 360`, each frame acked and forwarded by the CDP client (node) to the app with `Runtime.callFunctionOn`, decoded there with `createImageBitmap`. "renderer" = other renderer processes (spare/about:blank).


**N = 1**

| mode | delivered fps per guest (median) | browser | gpu-process | embedder renderer | guest renderer(s) | utility:NetworkService | renderer | other | total | client(node) |
|---|---|---|---|---|---|---|---|---|---|---|
| idle (guests animating, no capture) | – | 14.8 | 36.4 | 0.0 | 8.6 | 6.4 | 0.0 | 0.0 | 68.7 | – |
| idle again at the end | – | 5.7 | 37.1 | 0.1 | 9.0 | 1.9 | 0.1 | 0.8 | 54.5 | – |
| track (default 30 fps) | 30 | 2.5 | 38.7 | 1.8 | 9.0 | 0.0 | 1.5 | 0.0 | 53.5 | – |
| track, maxFrameRate 60 | 60.1 | 3.0 | 40.4 | 2.5 | 8.7 | 0.0 | 0.1 | 0.0 | 54.9 | – |
| CDP screencast | 60.1 | 24.9 | 40.4 | 17.3 | 9.1 | 0.0 | 0.0 | 0.0 | 91.7 | 3.9 |

**N = 8**

| mode | delivered fps per guest (median) | browser | gpu-process | embedder renderer | guest renderer(s) | utility:NetworkService | renderer | other | total | client(node) |
|---|---|---|---|---|---|---|---|---|---|---|
| idle (guests animating, no capture) | – | 0.2 | 60.6 | 0.0 | 69.7 | 0.1 | 0.1 | 0.1 | 131.1 | – |
| idle again at the end | – | 0.0 | 61.6 | 0.9 | 73.7 | 0.0 | 0.0 | 0.0 | 136.1 | – |
| track (default 30 fps) | 30.0 | 7.3 | 64.3 | 6.6 | 74.5 | 0.0 | 0.0 | 0.0 | 153.1 | – |
| track, maxFrameRate 60 | 60.1 | 12.2 | 68.1 | 10.6 | 75.3 | 0.0 | 0.0 | 0.0 | 165.4 | – |
| CDP screencast | 60.2 | 210.2 | 82.4 | 160.2 | 102.0 | 0.1 | 0.0 | 0.0 | 554.8 | 24.5 |

### F0. Headline: out/Release (no DCHECKs), real X11 window, N = 8 guests 640×360 at 60 fps

| source | fps per track | browser | GPU process | embedder renderer | guests (sum) | total CPU | PSS |
|---|---|---|---|---|---|---|---|
| no capture (pages only) | – | 4.5 | 26.7 | 6.1 | 44.7 | 83 | 1032 MB |
| **captureStream() track** | **60.1** | 32.1 | 70.4 | 12.7 | 49.0 | **174** | 1046 MB |
| CDP screencast (JPEG q72, decode with createImageBitmap) | 60.0 | 209 | 58.1 | 133 | 69.9 | **470** (+ CDP client) | 1672 MB |

Track adds ~91 % of one core over the pages themselves for 8×60 frames/s
(mostly GPU process readback + browser); screencast adds ~387 %. In the DCHECK
build the same comparison is 271 % vs 687 % (window) — DCHECKs inflate the
absolute numbers by roughly 1.5×; the ratio stays at ~2.5×.


### F0b. Scaling, HEADLINE: real X11 window, NVIDIA RTX 5090, out/Release (no DCHECKs), no compile running

Guests 640×360 each (laid out at full size, shown scaled down on the left), every guest animating unless noted; scene = WebGL2 wall of all tracks with a ripple shader. 10 s window after 4 s settle. CPU in % of one core.

| run | N | source | requested fps | delivered fps/track median (min) | guest rAF/s median (min) | scene fps | browser | GPU proc | embedder | guests (sum) | total CPU | GPU util % | VRAM MiB | procs | PSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| track 60 | 8 | track | 60 | 60.1 (60.1) | 60 (60) | 60 | 32.1 | 70.4 | 12.7 | 49 | 174 | 11 | 809 | 28 | 1046 |
| CDP screencast | 8 | screencast | – | 60 (59.9) | 60.1 (60.1) | 60 | 209 | 58.1 | 133 | 69.9 | 470 | 10 | 773 | 27 | 1672 |
| no capture | 8 | none | – | 0 (0) | 60.1 (60) | 60 | 4.5 | 26.7 | 6.1 | 44.7 | 83.3 | 6 | 776 | 28 | 1032 |
| track 60 | 16 | track | 60 | 49.9 (49.8) | 49.8 (49.8) | 50 | 21.8 | 114.2 | 20.6 | 95.1 | 254.8 | 17 | 882 | 36 | 1261 |
| track 60 | 32 | track | 60 | 24.1 (24) | 24 (24) | 24 | 35.3 | 114.5 | 18.1 | 113.5 | 289.6 | 16 | 972 | 52 | 1583 |
| track 60 | 64 | track | 60 | 11.1 (11.1) | 11.1 (11.1) | 11 | 33.1 | 114.6 | 15.9 | 122.2 | 291 | 15 | 1178 | 84 | 2324 |
| no capture | 32 | none | – | 0 (0) | 60.1 (60.1) | 60 | 7.5 | 80.5 | 9.3 | 277.8 | 379 | 11 | 840 | 52 | 1582 |
| no capture | 64 | none | – | 0 (0) | 56.8 (56.8) | 57 | 6.7 | 159.5 | 12.1 | 487 | 668.1 | 18 | 1019 | 84 | 2472 |

GPU-process threads (Release, window):

| run | GPU main % | VizCompositor % |
|---|---|---|
| r8 | 51.7 | 11.8 |
| r16 | 87.1 | 17.2 |
| r32 | 87 | 18.9 |
| r64 | 87.2 | 19.1 |
| r8none | 15.1 | 7.6 |
| r32none | 44.8 | 22.5 |
| r64none | 0.1 | 40.4 |
| r8sc | 33.8 | 18.2 |


With Release the capture ceiling is ~700–800 captured frames/s in total
(16 × 50, 32 × 24, 64 × 11) with the GPU process main thread at ~87 %; without
capture the same 64 pages run at 57 fps.

### F2. Scaling to 64 pages (stress)

Headline: **real X11 window**, then headless GPU for comparison. Every N run
in a fresh browser, one at a time, memory never below 33 GB available, no
swap growth, no DCHECKs.

Where it falls off: above 8 animated 640×360 guests at 60 fps, i.e. at about
**500–530 captured frames per second in total**, independent of N (16 → 32–35
fps, 32 → 16–17, 64 → 7.5–8). The saturated core is the **GPU process main
thread** (~90 % with capture, see F3), and the guests' own rAF drops with the
tracks (they share the GPU main thread). Without capture the same pages run at
60 fps up to N=16 (canvas) / N=32 (DOM). `maxFrameRate: 120` delivers 60 — the
begin-frame rate (60 Hz) caps it; a 120 Hz Hyprland mode was granted (reported
120.0 Hz) but Chromium in the Xwayland window still ran at 56–58 fps.
"Cost follows change": 64 pages with 8 animating hold ~49–52 fps.
CDP screencast: 2.5–3.7× the total CPU at the same N; at N=32 its scene drops to
6.6 fps and PSS to 5.6–6.6 GB.


### Scaling — real X11 window (Xwayland) on NVIDIA RTX 5090, ANGLE/OpenGL, out/Default (DCHECK build), no compile running

Guests 640×360 each (laid out at full size, shown scaled down on the left), every guest animating unless noted; scene = WebGL2 wall of all tracks with a ripple shader. 10 s window after 4 s settle. CPU in % of one core.

| run | N | source | requested fps | delivered fps/track median (min) | guest rAF/s median (min) | scene fps | browser | GPU proc | embedder | guests (sum) | total CPU | GPU util % | VRAM MiB | procs | PSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| track 60 | 8 | track | 60 | 60 (60) | 60.1 (60.1) | 60 | 39.8 | 108 | 26.3 | 84.8 | 270.6 | 11 | 804 | 28 | 1354 |
| track 60 | 16 | track | 60 | 32.4 (32.4) | 32.4 (32.4) | 32 | 47.6 | 120.5 | 25.9 | 118.4 | 324.4 | 11 | 887 | 36 | 1588 |
| track 60 | 32 | track | 60 | 15.9 (15.9) | 16 (16) | 16 | 45.2 | 120.1 | 21.9 | 135.3 | 333.8 | 11 | 977 | 52 | 2099 |
| track 60 | 64 | track | 60 | 7.5 (7.5) | 7.6 (7.6) | 7.5 | 33.9 | 118.7 | 19.4 | 136.5 | 311.2 | 10 | 1180 | 80 | 2891 |
| track 120 | 8 | track | 120 | 60 (60) | 60 (60) | 60 | 40.5 | 113.2 | 28.2 | 89 | 282.2 | 11 | 801 | 28 | 1370 |
| CDP screencast | 8 | screencast | – | 60 (60) | 60.2 (60.2) | 60 | 294.1 | 92.9 | 184.6 | 115.3 | 686.9 | 11 | 784 | 27 | 2152 |
| CDP screencast | 32 | screencast | – | 16.2 (15.5) | 40.6 (40.6) | 6.6 | 565 | 161.9 | 196.2 | 296.8 | 1220.1 | 11 | 941 | 51 | 5641 |
| no capture | 8 | none | – | 0 (0) | 60.1 (60.1) | 60 | 7.3 | 44.5 | 11.5 | 79.3 | 145.1 | 6 | 778 | 28 | 1315 |
| no capture | 16 | none | – | 0 (0) | 60.1 (60.1) | 60 | 12.7 | 78.3 | 14.2 | 181.1 | 292.2 | 9.5 | 803 | 36 | 1590 |
| no capture | 32 | none | – | 0 (0) | 57.9 (57.9) | 57.5 | 14.2 | 146.1 | 17.2 | 400.4 | 586.3 | 10.5 | 899 | 52 | 2079 |
| no capture | 64 | none | – | 0 (0) | 26.8 (26.8) | 27 | 17.1 | 147.5 | 13.3 | 428.1 | 615.4 | 14 | 1025 | 84 | 2975 |
| track, 8 of 64 animated | 64 | track | 60 | 48.8 (48.8) | 0 (0) | 49.5 | 41.2 | 126.2 | 30.6 | 75 | 283.8 | 12 | 993 | 84 | 2722 |


### Scaling — headless, GPU (ANGLE GL/EGL, RTX 5090), out/Default (DCHECK build)

Guests 640×360 each (laid out at full size, shown scaled down on the left), every guest animating unless noted; scene = WebGL2 wall of all tracks with a ripple shader. 10 s window after 4 s settle. CPU in % of one core.

| run | N | source | requested fps | delivered fps/track median (min) | guest rAF/s median (min) | scene fps | browser | GPU proc | embedder | guests (sum) | total CPU | GPU util % | VRAM MiB | procs | PSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| track 60 | 8 | track | 60 | 60.1 (60.1) | 60.1 (60.1) | 60 | 30.7 | 110.4 | 27.7 | 89.3 | 264.5 | 12 | 705 | 27 | 1361 |
| track 60 | 16 | track | 60 | 34.7 (34.7) | 34.7 (34.7) | 34 | 51.5 | 126.6 | 27.3 | 125.7 | 345.2 | 12 | 779 | 35 | 1617 |
| track 60 | 32 | track | 60 | 16.5 (16.5) | 16.5 (16.5) | 16 | 45.3 | 125.4 | 23.2 | 141.8 | 348.6 | 11 | 887 | 51 | 2039 |
| track 60 | 64 | track | 60 | 8 (8) | 8.1 (8.1) | 8 | 33.3 | 124.2 | 20.2 | 144.2 | 325.9 | 12 | 1056 | 79 | 2966 |
| track 120 | 8 | track | 120 | 60.1 (60.1) | 60.1 (60.1) | 60 | 28.1 | 111.2 | 28.1 | 90.5 | 264 | 12 | 705 | 27 | 1342 |
| track 120 | 32 | track | 120 | 16.8 (16.8) | 16.9 (16.9) | 17 | 42.1 | 126.4 | 23.7 | 142.9 | 344.3 | 11 | 884 | 51 | 2047 |
| track 120 | 64 | track | 120 | 8.1 (8.1) | 8.2 (8.2) | 8 | 24.4 | 125 | 20.3 | 149.2 | 319.1 | 11 | 1067 | 79 | 2865 |
| screencast | 8 | screencast | – | 59.7 (59.6) | 60.2 (60.2) | 60 | 314.1 | 90.7 | 187.2 | 118.4 | 710.5 | 12 | 697 | 26 | 2014 |
| screencast | 32 | screencast | – | 16.9 (15.5) | 42 (42) | 6.8 | 565.1 | 165.1 | 206 | 315.5 | 1251.8 | 11.5 | 836 | 46 | 6578 |
| no capture | 8 | none | – | 0 (0) | 60 (60) | 60 | 10.7 | 55.3 | 11.8 | 87 | 171.2 | 17 | 680 | 27 | 1280 |
| no capture | 16 | none | – | 0 (0) | 60 (60) | 60 | 28.6 | 88.5 | 11.9 | 197.4 | 338.1 | 18 | 705 | 35 | 1567 |
| no capture | 32 | none | – | 0 (0) | 55 (55) | 55 | 26.1 | 144.5 | 17.4 | 377.5 | 576.7 | 19 | 790 | 51 | 2046 |
| no capture | 64 | none | – | 0 (0) | 26.9 (26.8) | 27 | 12.1 | 147.9 | 13.2 | 426.8 | 606.1 | 13 | 935 | 83 | 2946 |
| track, 8 of 64 animated | 64 | track | 60 | 52.5 (52.5) | 0 (0) | 52.5 | 40 | 132.2 | 34.7 | 86.9 | 303.3 | 13 | 909 | 83 | 2713 |
| no capture, 8 of 64 animated | 64 | none | – | 0 (0) | 0 (0) | 60 | 9 | 61.7 | 20.3 | 90.2 | 187.1 | 17 | 854 | 83 | 2566 |

### F3. GPU-process threads: is it the pages or the capture? (real window, CPU % of one core)

Plain-DOM guests (`guest_site/demo_guest_dom.html`: three CSS-animated boxes + a text counter/clock updated every rAF, no canvas) vs the canvas guests. With capture the GPU process main thread sits at ~90 % and the rate is ~530 frames/s whatever the page type; without capture DOM pages are much cheaper for the GPU main thread (36 % at N=16) and hold 60 fps up to N=32.

| guest page | N | capture | fps/track | guest rAF/s | GPU proc total % | GPU main thread % | VizCompositorThread % | guests sum % | browser % |
|---|---|---|---|---|---|---|---|---|---|
| canvas pages | 32 | track | 15.9 | 16 | 120.1 | 90.7 | 20.2 | 135.3 | 45.2 |
| canvas pages | 32 | none | – | 57.9 | 146.1 | 96.3 | 32 | 400.4 | 14.2 |
| canvas pages | 64 | track | 7.5 | 7.6 | 118.7 | 91 | 19.1 | 136.5 | 33.9 |
| canvas pages | 64 | none | – | 26.8 | 147.5 | 97.1 | 37.9 | 428.1 | 17.1 |
| DOM pages | 16 | track | 33.7 | 33.7 | 124.8 | 89.9 | 23.1 | 208 | 45 |
| DOM pages | 16 | none | – | 60 | 68 | 36 | 21.4 | 294.4 | 25.1 |
| DOM pages | 32 | track | 16.3 | 16.4 | 124 | 89.9 | 23.4 | 227.5 | 51.2 |
| DOM pages | 32 | none | – | 60 | 130.6 | 66.6 | 43 | 687.8 | 11.7 |
| DOM pages | 64 | track | 8.3 | 8.3 | 123.9 | 89.7 | 22.6 | 238.4 | 33.7 |
| DOM pages | 64 | none | – | 43.9 | 189.5 | 95.5 | 63.3 | 1132.4 | 9.8 |

### F4. Latency

| config | path | median ms | p90 ms |
|---|---|---|---|
| headless sw | track (60 fps) | 3 | 4 |
| headless sw | screencast | 8 | 9 |
| headless GPU | track (60 fps) | 5 | 6 |
| headless GPU | screencast | 10 | 11 |

Measured from the guest's `Date.now()` painted as 42 black/white blocks in its
rAF callback, to the moment the app decodes the strip from the arriving frame
(`VideoFrame` via MSTP, or the decoded JPEG). Both pages use the same clock.

Why the Stage 1 still shows ~3 frames (~50 ms) between a guest's counter and its
WebGL card although the table says 3–5 ms: the table stops when the frame
reaches the app's JS. The still compares two things composited into **the same
output frame**: the guest's own surface (the newest guest frame, drawn
directly by Viz) and the app's WebGL canvas. For the card, after the 3–5 ms
transport: (1) the capturer copies the guest frame only when Viz aggregates it
(i.e. at/after the display frame that shows it on the left), (2) the VideoFrame
waits for the app's next rAF to be uploaded with `texImage2D` and drawn, (3) the
WebGL canvas is presented in the app's next compositor frame and the display
frame after that. That is ~2–3 vsyncs (33–50 ms at 60 Hz) of pipeline that is
not capture transport but frame scheduling of the consuming scene; the
recording (screencast of the composited page) adds nothing between the two
halves because both are in the same captured image. A lower-latency consumer
would draw from `requestVideoFrameCallback` / the MSTP reader directly and
accept the 1-frame offset.

## G. Browser test

`ControlledFrameCaptureStreamTest.CaptureStream` in
`chrome/browser/controlled_frame/controlled_frame_apitest.cc` (uses
`EnablePixelOutput()`; browser tests otherwise produce black frames):
1. sizes the element to 320×40 fixed at the top-left (the test app window is
   only 500×42, see B), paints the guest green on every rAF, calls
   `captureStream({maxWidth: 320, maxHeight: 240})` and reads frames with
   `MediaStreamTrackProcessor` until the centre pixel is green;
2. checks no infobar was added to the app WebContents (commit 2);
3. obtains a fresh id without consuming it (intercepting `getUserMedia`) and
   checks that a second window of the same app, a page of another origin, and
   the guest itself get an error, then the owner succeeds once and fails on
   reuse;
4. calls `WebViewInternalGetCaptureStreamIdFunction` directly from a
   same-process non-owner iframe → "Only the embedder of the guest can capture
   it"; the owner → a non-empty id; from another process → "Could not find
   guest" and the guest view manager kills that renderer (existing behaviour,
   `GVM_EMBEDDER_FORBIDDEN_ACCESS_TO_GUEST`);
5. removes the element → guest destroyed → track `readyState === 'ended'`.

| run | result |
|---|---|
| final build, ×20 (`--gtest_repeat=20`, 4 jobs, Release build compiling meanwhile) | 20/20 pass, median 4497 ms (4132–4824) |
| first version (before infobar commit), ×20 | 20/20 pass, median 2685 ms (2622–2735) |
| `ControlledFrame*:*/ControlledFrame*`, final build, 10 jobs | 221 run: 200 pass, 21 fail — exactly the 21 known pre-existing failures (`ControlledFrame*Clipboard*`, `ClipboardReadWrite/*`, `ClipboardSanitizedWrite/*`, `ControlledFrameDisabledPermissionFileSystemAccessTest…`); `ElementHasExpectedProperties` passes with `captureStream` added to `expected_properties.json`; `ControlledFrameMoveBeforeTest.MoveBeforeKeepsGuest` passes |

## Capture indicator

- Prototype (commit 1): in a real window, each `captureStream()` adds an
  infobar **"Sharing 127.0.0.1:8712 to this tab — Stop sharing"** (the guest's
  origin) to the app window: 8 tracks = 8 stacked bars (~450 px). Screenshot
  `demo/capture-indicator-x11-window.png`. (The same bars silently shrank the
  page viewport in headless runs: 1912×593 instead of 1912×1048.)
  Source path: `DesktopCaptureAccessHandler::AcceptRequest` →
  `GetDevicesForDesktopCapture(display_notification=true)` → `TabSharingUI`
  for `TYPE_WEB_CONTENTS`, and `MediaStreamCaptureIndicator::RegisterMediaStream`.
- Commit 2: `display_notification` is false when the captured WebContents is an
  inner WebContents of the requesting WebContents
  (`IsCaptureOfEmbeddedGuest` in `desktop_capture_access_handler.cc`). Verified
  in the real X11 window with 8 tracks: no bar
  (`demo/capture-indicator-suppressed-x11-window.png`), and asserted in the
  browser test. Still registered: `MediaStreamCaptureIndicator` (tab/app
  "recording" state, tray icon where a status tray exists) — not visible in
  this window and not suppressed.
- `getUserMedia` with a legacy desktop source logs "Permissions policy
  violation: camera is not allowed in this document" in the IWA: Blink only
  reports and counts it (`kCameraDisabledByFeaturePolicyEstimate`), it does not
  block.

## H. DCHECKs / crashes

| scenario | result |
|---|---|
| remove the element mid-capture | guest destroyed, track `ended`, reader done; no DCHECK |
| navigate the guest same-site and cross-site (new process) mid-capture | track stays live and shows the new page (captured tab registry follows the RFH swap) |
| guest renderer crash (`Page.crash`) mid-capture | track stays `live` (no frames); only DCHECK is the intentional `Page.crash` NOTREACHED in the killed renderer |
| reload the app page while capturing | no DCHECK |
| close the app window while capturing | no DCHECK |
| two tracks of the same guest | works |
| `<video>.play()` promise never settles in IWA app windows; GC of it | DCHECK `ScriptPromiseResolverBase was not properly detached` in the embedder renderer (pre-existing, reproduced with `canvas.captureStream()` without this API) |
| harness `Runtime.evaluate` before the app document committed | DCHECK `main_thread_debugger.cc:304 !frame->IsProvisional()` (DevTools, pre-existing; harness fixed to wait) |
| real Wayland window on a Hyprland headless output | browser DCHECK `presentation_time_callback_buffer.cc:135 (61 vs. 60)` (no presentation feedback from the output; pre-existing, unrelated) |

Final build (all four commits), real window, phases A N C D H re-run: same results as above, no DCHECK except the intentional `Page.crash` NOTREACHED in the killed guest renderer.

## Usage (prototype API)

```js
// In an Isolated Web App with "controlled-frame" and "cross-origin-isolated".
const frame = document.querySelector('controlledframe');
const stream = await frame.captureStream({maxWidth: 640, maxHeight: 360,
                                          maxFrameRate: 60});
const [track] = stream.getVideoTracks();   // ends when the guest goes away
track.addEventListener('ended', () => console.log('guest gone'));

// a) <video> / WebGL2
const video = Object.assign(document.createElement('video'),
                            {muted: true, autoplay: true, srcObject: stream});
document.body.append(video);                // keep it in the DOM
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

// b) VideoFrames (WebGL2 texImage2D(frame), WebGPU importExternalTexture)
const reader = new MediaStreamTrackProcessor({track}).readable.getReader();
for (;;) {
  const {value: frame, done} = await reader.read();
  if (done) break;
  const tex = device.importExternalTexture({source: frame});
  // ... draw with tex ...
  frame.close();
}
```

## Demo files (`$RESULTS_DIR/capture/demo/`)

Every `*.mp4` has a `*.recording.json`
(how it was recorded) and a `*.readout.json` (per-second readout). The video
frame rate of a recording is not a measurement.

## Hyprland session (desktop use)

Desktop runs used a temporary Hyprland headless output (name given by `HYPR_OUT`), added before and removed after the run.

## Unverified / not done

- `VideoFrame` from `MediaStreamTrackProcessor` in a worker (workers do not
  start in the dev-mode IWA here, independent of this patch).
- NV12/GPU-backed frames: blocked by native-pixmap allocation on this box (see
  E/NV12); nothing measured for that path; macOS not tested at all.
- `GuestViewMPArch`: the function refuses (guest main frame's WebContents ==
  embedder WebContents). MPArch would need a capture target that is the guest
  page's frame sink rather than a WebContents (e.g. a `WebContentsMediaCaptureId`
  variant carrying the guest's frame tree / `RenderWidgetHostViewChildFrame`
  frame sink, plus capturer-count plumbing on the guest page instead of the
  WebContents). Not implemented.
- Pixels of hidden guests with the keep-alive experiment (only frame counts).
- Real Wayland window in the DCHECK build (presentation-feedback DCHECK).
- macOS/Windows; real displays (only Hyprland headless outputs).
- The capture indicator beyond the infobar (tray icon) — no tray here.
- Track behaviour after a guest *crash* (stays `live`, no frames); after the
  guest is reloaded it was not checked whether frames resume.
- `getCaptureStreamId` is reachable from any page that has
  `webViewInternal` (the controlled-frame bindings); ownership is checked in the
  browser, but the JS calls `navigator.mediaDevices.getUserMedia` from the page
  world, so a page can intercept (its own) id.
- `git cl format`/presubmit: clang-format applied to the changed hunks only;
  presubmit not run.

### Demo file list (sizes)

- `demo/stage1-plain.mp4` 2.4 MB
- `demo/stage2-3d-shaders.mp4` 13.7 MB
- `demo/stage2-3d-shaders-window.mp4` 5.6 MB
- `demo/stage3-64.mp4` 8.5 MB
- `demo/stage4-three-apis.mp4` 3.1 MB
- `demo/capture-indicator-x11-window.png` 0.5 MB
- `demo/capture-indicator-suppressed-x11-window.png` 0.9 MB
- stills: `demo/stage1-plain_still{1..3}.png`, `demo/stage2-3d-shaders_still{1..8}.png`, `demo/stage2-3d-shaders-window_still{1..8}.png`, `demo/stage3-64_still{1..3}.png`, `demo/stage4-three-apis_still1.png`; per-run scene stills `demo/stress-*.png`; segment videos `demo/stage3-64-all.mp4`, `stage3-64-mix.mp4`, `stage3-16.mp4`, `suppress-check-x11.mp4`
- page sources: `demo/src/` (demo.html/js/css, three.html/js, guest pages, demo.mjs, stress.mjs)

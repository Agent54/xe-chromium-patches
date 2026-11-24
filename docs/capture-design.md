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

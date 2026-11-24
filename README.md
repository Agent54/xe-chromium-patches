# xe-chromium-patches

Patches for Chromium (Controlled Frame / Isolated Web Apps, Viz capture and frame pacing).
License: BSD-3-Clause (see `LICENSE`). Base: see `BASE_VERSION` (Chromium 160.0.8176.0).

## Layout

| Directory | Patches | Purpose |
|---|---|---|
| `patches/01-upstream-candidates/` | 0001-0005 | Small, self-contained changes meant for upstream review: `moveBefore` keeps the guest; VideoConferenceMatcher yields to other animations (guarded against non-positive intervals); `RemoteFrameSurfaceIgnoresTransformedSize` (squashed); IWA key-distribution readiness wait; macOS unframed IWA titlebar buttons. |
| `patches/02-controlled-frame-api/` | 0006-0030 | `captureStream`, the direct guest-to-texture route, `setFrameRate`, with the hardening and bug-fix commits at the end (0027-0030). |
| `patches/03-experimental/` | 0031-0050 | Experiments. Every new experimental feature is `DISABLED_BY_DEFAULT`, except `0038` (`kDesktopVideoConferenceFrameIntervalMatcher`), which is an `ENABLED_BY_DEFAULT` killswitch preserving stock Chromium behavior. |

`patches/series` lists the apply order (a flat order across the three directories; later patches build on earlier ones).

## Apply

    git clone https://chromium.googlesource.com/chromium/src && cd src
    git checkout "$(sed -n 's/^CHROMIUM_BASE_COMMIT=//p' /path/to/BASE_VERSION)"
    gclient sync -D
    git am --3way $(sed 's#^#/path/to/xe-chromium-patches/patches/#' /path/to/xe-chromium-patches/patches/series)

**Status:** all 50 patches apply in `series` order to `CHROMIUM_BASE_COMMIT` with no offsets
(`git apply --cached` against the base tree, plus `git mailinfo` on every header). The series has not
been compiled or run on 160.0.8176.0 yet; report anything that fails `git am`.

## Build

    CHROME_SRC=/path/to/src OUT_DIR=out/Default build/build.sh chrome

`build/args/*.args.gn` hold example `args.gn` files (Linux default/release/ChromeOS, macOS arm64).

## Harness

Node/Python scripts under `harness/linux/`. Required environment:

- `CHROME_BIN`: path to the patched `chrome` binary
- `PROFILE_DIR`: directory for throwaway profiles
- `HYPR_OUT` (optional, `demo.mjs` desktop mode): Hyprland output name for `grim`

The scripts import `./lib.mjs` and serve an IWA and guest-site pages that are **not included** in this
export; the harness is not runnable until those are added. Design notes and results are in `docs/`.

## Checks (no Chromium needed)

    tools/check-patches.py            # unified-diff syntax, hunk counts, header hygiene, series list
    tools/check-patches.py --redact   # also scans for paths, hosts, private IPs, GPL mentions

## Known gaps

- Patches 0004 and 0005 apply cleanly to stock Chromium 160.0.8176.0 (0004 now targets `components/webapps/isolated_web_apps/key_distribution/` and posts `MaybeQueueComponentUpdate` as a task), but their unit/browser tests still need compile+run verification on Chromium 160.
- `GuestFrameTextureSource` is still exposed as a global constructor to Window.
- macOS behavior of the unified series is untested (0022-0030 were Linux-only before).

# Zoom and native-card features (experimental)

These features live in `patches/03-experimental/` and are all off by default.
They were measured with the following runtime flags (all zoom features on):

    --enable-features=RemoteFrameSurfaceIgnoresTransformedSize,QuantizeRemoteFrameCompositingScale,StableRemoteFrameCompositingRect,HoldCompositingScaleWhileTransforming,RemoteFrameScaleChangeKeepsSurface,StaggerCompositingScaleSteps,MergeSurfacesWithIdleCapture,ShortHoldForUpwardScaleSteps,StepWhenTransformSettles
    --disable-features=TreesInViz

`WillChangeTransformHoldsScale` is not in the list. With it on, a card that keeps
`will-change: transform` permanently loses the fast settle rule and goes back to
the hold for moves that end away from 1:1; enable it only if the app removes
`will-change` when a move ends.

Measurement (wall harness, 120 ms zoom-in of every card from 0.3 to 1.0 with a
cubic ease-out, N = 16 and 32, one run): no frame over 20 ms per zoom-in (worst
16.7 ms) with and without the new features; the last guest re-raster ends 47 ms
before / 4 ms after the landing frame (it was +169 / +219 ms with the hold alone).

All of these features currently require `--disable-features=TreesInViz` and have
no `TreesInViz` tests.

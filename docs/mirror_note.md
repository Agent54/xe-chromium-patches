
## C2. Compositor mirror (feasibility note, no prototype)

Question: can the same guest surface be drawn a second time elsewhere in the
embedder, with a transform, without a copy?

What the source shows:
- **Viz allows it.** `SurfaceAggregator::HandleSurfaceQuad` only refuses a
  surface that is already on the current embedding stack (cycle check:
  `referenced_surfaces_` is inserted at `surface_aggregator.cc:863` and erased
  after the quad at `:1113`). Two `SurfaceDrawQuad`s with the same `SurfaceId`
  in different places of the embedder's frame are both drawn, each with its
  own `quad_to_target_transform`, opacity, clip and filters. Surface
  references from one embedder to the same surface twice are fine.
- **Where the embedder gets the surface:** a remote frame's pixels are a
  `cc::SurfaceLayer` created by `ChildFrameCompositingHelper`
  (`third_party/blink/renderer/core/frame/child_frame_compositing_helper.cc:60`),
  updated through `SetSurfaceId()` when the guest's `LocalSurfaceId`
  changes. A second `cc::SurfaceLayer` fed the same `SurfaceId` (and the same
  updates) anywhere in the embedder's layer tree would show the guest again.
- **Alternative inside cc:** `cc::MirrorLayer` (`cc/layers/mirror_layer.h`,
  used by `ui::Layer` mirroring) re-draws another layer's render pass
  elsewhere in the same tree. For a SurfaceLayer that costs one render pass
  (an intermediate texture) per mirrored layer, then quads per mirror; the
  plain second SurfaceLayer is cheaper (no intermediate).

The short path (estimated 300–500 lines, not built): a Blink element or
paint-worklet-like primitive owned by the controlled frame (e.g.
`controlledFrame.createMirror()` returning an element) whose
`LayoutObject` paints a foreign layer that is a `cc::SurfaceLayer` tracking
the guest's `ChildFrameCompositingHelper` surface id (observer on
`SetSurfaceId`), plus `stretch_content_to_fill_bounds` so it can be sized
freely. Cost per mirror per frame: drawing the guest's quads again in the
display compositor (per-pixel at the mirror's on-screen size, typically less
than a copy) — no copy, no shared image, no IPC, zero added latency, and
damage-driven by construction.

Limits that decide whether it is useful here:
- The mirror lives in the **DOM/compositor layer tree**: CSS transforms
  (including 3D), opacity, filters, clip, blend — but **not inside a
  WebGL/WebGPU scene**. A shader effect (the ripple wall) or arbitrary 3D
  geometry is impossible; a CSS 3D carousel/wall would work.
- Input/hit testing is not mirrored (display only); the guest is drawn at
  the mirror's scale from its full-size quads (no mipmaps; minification
  aliasing at small card sizes unless the guest's own raster scale is
  reduced).
- Same ownership rule as the direct route (only the embedder of the guest);
  cross-origin guest pixels never reach the embedder's renderer, which is
  also why this is privacy-safe in the same sense as the existing iframe.
- Hidden guests: the mirror references the surface, so it keeps it
  aggregated even if the original element is hidden — the keep-alive comes
  for free.

Verdict: feasible and cheap for a CSS-composited overview (cards laid out
with CSS 3D transforms); not a substitute for the direct route when the
scene is WebGL/WebGPU. Not prototyped.

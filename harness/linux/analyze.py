#!/usr/bin/env python3
"""Turns raw/*.json from harness.mjs into markdown tables (tables.md)."""
import json, os, statistics, sys

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raw')
out = []
P = out.append


def load(name):
  p = os.path.join(RAW, name)
  if not os.path.exists(p):
    return None
  return json.load(open(p))


def fmt_sizes(s):
  return ', '.join(f'{k}' for k in s) if s else '–'


# ---------------------------------------------------------------- B
def table_b(label, title):
  d = load(f'{label}-B.json')
  if not d or 'result' not in d:
    return
  P(f'\n### B. Visibility — {title}\n')
  P('| state | no capture: guest visibilityState / rAF per s | track: fps / frame size / guest rAF per s | CDP screencast: fps / frame size / guest visibilityState / rAF per s |')
  P('|---|---|---|---|')
  for r in d['result']:
    nc, t, s = r['noCapture'], r['track'], r['screencast']
    P(f"| {r['state']} | {nc['vis']} / {nc['guestRafPerS']} | {t['fps']} / {fmt_sizes(t['sizes'])} / {t['guestRafPerS']} (guest {t['vis']}) | {s['fps']} / {fmt_sizes(s['sizes'])} / {s['vis']} / {s['guestRafPerS']} |")


# ---------------------------------------------------------------- C
def table_c(label, title):
  d = load(f'{label}-C.json')
  if not d or 'result' not in d:
    return
  P(f'\n### C. Constraints — {title} (guest layout size 640x360)\n')
  P('| guest | constraints | getSettings() w×h@fps | delivered sizes | frames in 1st s | frames/s in s 2–4 |')
  P('|---|---|---|---|---|---|')
  for r in d['result']:
    st = r.get('settings') or {}
    P(f"| {r['kind']} | `{json.dumps(r['opts'])}` | {st.get('width')}×{st.get('height')}@{st.get('frameRate')} | {fmt_sizes(r['sizes'])} | {r['firstSecondFrames']} | {r['fpsPerSecond']} |")


# ---------------------------------------------------------------- F
ROLE_ORDER = ['browser', 'gpu-process', 'embedder renderer', 'guest renderer(s)',
              'utility:NetworkService', 'renderer', 'other', 'total',
              'client(node)']


def collapse(cpu):
  out = {}
  for k, v in cpu.items():
    kk = k if k in ROLE_ORDER else 'other'
    out[kk] = out.get(kk, 0) + v
  return out


def table_f(labels, title):
  runs = [load(f'{l}-F.json') for l in labels]
  runs = [r for r in runs if r and 'result' in r]
  if not runs:
    return
  P(f'\n### F. Cost — {title} ({len(runs)} runs, median per cell; CPU in % of one core, 10 s windows)\n')
  vp = runs[0]['result'][0].get('viewport')
  P(f'Viewport {vp}; each guest 640×360, animated (rAF canvas + 42-bit timestamp strip); track constraints maxWidth 640 / maxHeight 360; screencast `format: jpeg, quality: 72, maxWidth: 640, maxHeight: 360`, each frame acked and forwarded by the CDP client (node) to the app with `Runtime.callFunctionOn`, decoded there with `createImageBitmap`. "renderer" = other renderer processes (spare/about:blank).\n')
  for n_idx, N in enumerate([1, 8]):
    P(f'\n**N = {N}**\n')
    modes = ['idle', 'idleEnd', 'track', 'track60', 'screencast']
    names = {'idle': 'idle (guests animating, no capture)',
             'idleEnd': 'idle again at the end',
             'track': 'track (default 30 fps)',
             'track60': 'track, maxFrameRate 60',
             'screencast': 'CDP screencast'}
    P('| mode | delivered fps per guest (median) | ' + ' | '.join(ROLE_ORDER) + ' |')
    P('|---|---|' + '---|' * len(ROLE_ORDER))
    for m in modes:
      cells = {}
      fps = []
      for r in runs:
        row = [x for x in r['result'] if x['N'] == N]
        if not row or m not in row[0]:
          continue
        c = collapse(row[0][m]['cpu'])
        for k in ROLE_ORDER:
          cells.setdefault(k, []).append(c.get(k, 0))
        fps += row[0][m]['fps']
      if not cells:
        continue
      med = {k: statistics.median(v) for k, v in cells.items()}
      fpsm = statistics.median(fps) if fps else '–'
      P(f"| {names[m]} | {fpsm} | " + ' | '.join(
          f"{med.get(k, 0):.1f}" if k != 'client(node)' or m == 'screencast' else '–'
          for k in ROLE_ORDER) + ' |')


# ---------------------------------------------------------------- L
def table_l(labels):
  P('\n### Latency (guest paints Date.now() as 42 blocks each rAF; app decodes on arrival)\n')
  P('| config | path | frames | median ms | p90 ms | min | max |')
  P('|---|---|---|---|---|---|---|')
  for l, title in labels:
    d = load(f'{l}-L.json')
    if not d or 'result' not in d:
      continue
    for k in ['track', 'screencast']:
      r = d['result'][k]
      P(f"| {title} | {k} | {r['n']} | {r['median']} | {r['p90']} | {r['min']} | {r['max']} |")


def main():
  table_b('swB', 'software compositing (--disable-gpu)')
  table_b('gpu', 'GPU compositing (NVIDIA, --use-angle=gl-egl)')
  table_b('ka', 'real X11 window, + keep-alive of the guest surface (experiment, part 1)')
  table_b('ka2', 'real X11 window, + keep-alive + full compositor viewport for captured guests (both experiments)')
  table_c('sw', 'software compositing')
  table_c('gpu', 'GPU compositing')
  table_c('final', 'real X11 window, final build')
  table_f(['swF1', 'swF2', 'swF3'], 'software compositing (--disable-gpu)')
  table_f(['gpuF1', 'gpuF2', 'gpuF3'], 'GPU compositing (NVIDIA RTX 5090, ANGLE on GL/EGL)')
  table_l([('sw2', 'software'), ('gpu', 'GPU (gl-egl)')])
  open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tables.md'), 'w').write('\n'.join(out) + '\n')
  print('\n'.join(out))


main()


def table_stress(prefix_label, labels, title):
  rows = []
  for l, desc in labels:
    p = os.path.join(RAW, f'stress-{l}.json')
    if not os.path.exists(p):
      continue
    rows.append((desc, json.load(open(p))))
  if not rows:
    return ''
  o = [f'\n### Scaling — {title}\n',
       'Guests 640×360 each (laid out at full size, shown scaled down on the left), every guest animating unless noted; scene = WebGL2 wall of all tracks with a ripple shader. 10 s window after 4 s settle. CPU in % of one core.\n',
       '| run | N | source | requested fps | delivered fps/track median (min) | guest rAF/s median (min) | scene fps | browser | GPU proc | embedder | guests (sum) | total CPU | GPU util % | VRAM MiB | procs | PSS MB |',
       '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for desc, d in rows:
    c = d.get('cpuPct', {})
    tf = d.get('trackFps') or {}
    gr = d.get('guestRafPerS') or {}
    o.append(f"| {desc} | {d['N']} | {d['src']} | {d['requestedFps'] if d['src']=='track' else '–'} | "
             f"{tf.get('median','–')} ({tf.get('min','–')}) | {gr.get('median','–')} ({gr.get('min','–')}) | {(d.get('sceneFps') or {}).get('median','–')} | "
             f"{c.get('browser','–')} | {c.get('gpu-process','–')} | {c.get('embedder renderer','–')} | {c.get('other renderers (guests)','–')} | {c.get('total','–')} | "
             f"{(d.get('gpuUtilPct') or {}).get('median','–')} | {d.get('gpuMemUsedMiB','–')} | {d.get('processes','–')} | {d.get('pssMB','–')} |")
  return '\n'.join(o)

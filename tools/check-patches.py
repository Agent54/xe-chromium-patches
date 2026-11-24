#!/usr/bin/env python3
"""Static checks for the patch series (no Chromium checkout needed).

  tools/check-patches.py            syntax + hunk counts + header hygiene + series
  tools/check-patches.py --redact   also scan the whole repo for banned strings

Exit status is non-zero on any finding. This does NOT prove the patches apply;
use `git am` on a checkout at BASE_VERSION for that (see README.md).
"""
import os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAD_HEADER = [r'local@localhost', r'build@localhost', r'Local commit only', r'Co-Authored-By']
BANNED = [r'/' 'mnt/', r'/' 'Users/', r'/' 'home/\w', r'\.t3/', r'\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+(?:\.\d+)?\b',
          r'Co-Authored-By', r'Local commit only', r'GNU General Public|GPL-?[23]', r'kpg|omarchy|mac-studio']
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')

def check_patch(path):
    errs = []
    lines = open(path, encoding='utf-8').read().split('\n')
    hdr_end = next((i for i, l in enumerate(lines) if l.startswith('diff --git')), None)
    if hdr_end is None:
        return ['no diff --git']
    for l in lines[:hdr_end]:
        for p in BAD_HEADER:
            if re.search(p, l): errs.append('header: ' + l)
    i = hdr_end
    nfiles = 0
    prev_old_end = None
    while i < len(lines):
        l = lines[i]
        if l.startswith('diff --git'):
            nfiles += 1; prev_old_end = None; i += 1
            while i < len(lines) and not lines[i].startswith(('--- ', '@@', 'diff --git', 'Binary')) : i += 1
            if i < len(lines) and lines[i].startswith('--- '):
                if not (i + 1 < len(lines) and lines[i + 1].startswith('+++ ')): errs.append('line %d: --- without +++' % (i + 1))
                i += 2
            continue
        m = HUNK.match(l)
        if m:
            old_start = int(m.group(1))
            old = int(m.group(2) if m.group(2) is not None else 1)
            new = int(m.group(4) if m.group(4) is not None else 1)
            if prev_old_end is not None and old_start < prev_old_end:
                errs.append('line %d: non-monotonic hunk start -%d after previous end -%d (missing file header?)' % (i + 1, old_start, prev_old_end))
            prev_old_end = old_start + old
            o = n = 0; j = i + 1; start = j
            while j < len(lines) and (o < old or n < new):
                t = lines[j]
                if t.startswith('\\'): j += 1; continue
                c = t[:1]
                if c == ' ' or (t == '' and j < len(lines) - 1): o += 1; n += 1
                elif c == '-': o += 1
                elif c == '+': n += 1
                else: errs.append('line %d: bad hunk line %r' % (j + 1, t[:40])); break
                j += 1
            if (o, n) != (old, new): errs.append('line %d: hunk counts declared -%d +%d, found -%d +%d' % (i + 1, old, new, o, n))
            i = j; continue
        if l.startswith('-- ') or l == '' or l.startswith('\\'):
            i += 1; continue
        if re.match(r'^\d+\.\d+', l) or l.startswith(('new file', 'deleted file', 'index ', 'old mode', 'new mode', 'similarity', 'rename')):
            i += 1; continue
        errs.append('line %d: unexpected %r' % (i + 1, l[:40])); i += 1
    return errs

def main():
    bad = 0
    pdir = os.path.join(ROOT, 'patches')
    series = [l.strip() for l in open(os.path.join(pdir, 'series')) if l.strip() and not l.startswith('#')]
    ondisk = sorted(os.path.relpath(os.path.join(d, f), pdir)
                    for d, _, fs in os.walk(pdir) for f in fs if f.endswith('.patch'))
    if sorted(series) != ondisk:
        print('series mismatch:', set(series) ^ set(ondisk)); bad += 1
    for p in series:
        e = check_patch(os.path.join(pdir, p))
        print(('FAIL ' if e else 'ok   ') + p)
        for x in e: print('     ' + x)
        bad += bool(e)
    print('%d patches, %d failing' % (len(series), bad))
    if '--redact' in sys.argv:
        hits = 0
        for d, ds, fs in os.walk(ROOT):
            ds[:] = [x for x in ds if x not in ('.git', 'tools')]
            for f in fs:
                try: txt = open(os.path.join(d, f), encoding='utf-8').read()
                except Exception: continue
                for pat in BANNED:
                    for m in re.finditer(pat, txt):
                        hits += 1; print('banned %-30s %s' % (pat[:28], os.path.relpath(os.path.join(d, f), ROOT)))
        print('banned-string hits: %d' % hits); bad += hits
    sys.exit(1 if bad else 0)
main()

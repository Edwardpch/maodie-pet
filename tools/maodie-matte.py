#!/usr/bin/env python
# 按色相抠图：把豆包那种「灰绿影棚背景」的视频转成 VP9-alpha webm。
# 背景是低饱和绿（hue≈100-120），橘猫是暖色（hue≈20-50），按 hue 分离，比 colorkey 稳。
# 用法: python maodie-matte.py <输入视频> <输出webm> [--size 512] [--fps 12] [--crf 32]
import os, subprocess, sys, tempfile, shutil
import numpy as np
from PIL import Image

def parse():
    a = sys.argv[1:]
    opt = dict(src=a[0], dst=a[1], size=512, fps=12, crf=32, ss=None, to=None, erase=[],
               lo=50, hi=175, ramp=10, sat=0.12, darksat=None, darkval=None, fit=False)
    for i, x in enumerate(a):
        if x == '--size': opt['size'] = int(a[i+1])
        if x == '--fps': opt['fps'] = int(a[i+1])
        if x == '--crf': opt['crf'] = int(a[i+1])
        if x == '--ss': opt['ss'] = a[i+1]
        if x == '--to': opt['to'] = a[i+1]
        if x == '--lo': opt['lo'] = float(a[i+1])
        if x == '--hi': opt['hi'] = float(a[i+1])
        if x == '--ramp': opt['ramp'] = float(a[i+1])
        if x == '--sat': opt['sat'] = float(a[i+1])
        if x == '--darksat': opt['darksat'] = float(a[i+1])
        if x == '--darkval': opt['darkval'] = float(a[i+1])
        if x == '--fit': opt['fit'] = True
        if x == '--erase': opt['erase'].append(tuple(int(v) for v in a[i+1].split(',')))
    return opt

def hue_alpha(rgb, lo=50, hi=175, ramp=10, sat_min=0.12, darksat=None, darkval=None):
    im = rgb.astype(np.float32) / 255.0
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    mx = im.max(2); mn = im.min(2); d = mx - mn
    dd = np.where(d == 0, 1, d)
    h = np.zeros_like(mx)
    m = (mx == r) & (d > 0); h[m] = (60 * ((g - b)[m] / dd[m])) % 360
    m = (mx == g) & (d > 0); h[m] = (60 * ((b - r)[m] / dd[m])) + 120
    m = (mx == b) & (d > 0); h[m] = (60 * ((r - g)[m] / dd[m])) + 240
    sat = d / np.maximum(mx, 1e-6)
    inside = np.clip((h - lo) / ramp, 0, 1) * np.clip((hi - h) / ramp, 0, 1)
    a = np.where(sat > sat_min, 1 - inside, 1.0)
    if darksat is not None and darkval is not None:
        v = im.max(2)
        a = np.where((sat < darksat) & (v < darkval), 0.0, a)
    return np.clip(a, 0, 1)

def main():
    if len(sys.argv) < 3:
        print('用法: python maodie-matte.py <输入视频> <输出webm> [--size 512] [--fps 12] [--crf 32] [--ss 秒] [--to 秒] [--fit] [--erase x0,y0,x1,y1] [--lo 50 --hi 175 --ramp 10 --sat 0.12]')
        sys.exit(2)
    o = parse()
    tmp = tempfile.mkdtemp(prefix='matte-')
    try:
        trim = []
        if o['ss']: trim += ['-ss', o['ss']]
        if o['to']: trim += ['-to', o['to']]
        subprocess.run(['ffmpeg', '-y', '-v', 'error', *trim, '-i', o['src'],
                        '-vf', (f"scale={o['size']}:{o['size']}:force_original_aspect_ratio=decrease:flags=lanczos,fps={o['fps']}"
                                if o['fit'] else
                                f"crop='min(iw,ih)':'min(iw,ih)',scale={o['size']}:{o['size']}:flags=lanczos,fps={o['fps']}"),
                        os.path.join(tmp, 'f%04d.png')], check=True)
        names = sorted(f for f in os.listdir(tmp) if f.endswith('.png'))
        for n in names:
            p = os.path.join(tmp, n)
            rgb = np.array(Image.open(p).convert('RGB'))
            a = hue_alpha(rgb, o['lo'], o['hi'], o['ramp'], o['sat'], o['darksat'], o['darkval'])
            for (x0, y0, x1, y1) in o['erase']:
                a[y0:y1, x0:x1] = 0.0
            rgba = np.dstack([rgb, (a * 255).astype(np.uint8)])
            if o['fit'] and rgba.shape[:2] != (o['size'], o['size']):
                canvas = np.zeros((o['size'], o['size'], 4), np.uint8)
                y0 = (o['size'] - rgba.shape[0]) // 2
                x0 = (o['size'] - rgba.shape[1]) // 2
                canvas[y0:y0 + rgba.shape[0], x0:x0 + rgba.shape[1]] = rgba
                rgba = canvas
            Image.fromarray(rgba, 'RGBA').save(p)
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(o['fps']),
                        '-i', os.path.join(tmp, 'f%04d.png'),
                        '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
                        '-b:v', '0', '-crf', str(o['crf']), '-row-mt', '1', '-auto-alt-ref', '0',
                        o['dst']], check=True)
        print(f'OK {len(names)} 帧 → {o["dst"]}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

main()

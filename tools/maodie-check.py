#!/usr/bin/env python
# 体检 maodie 的 webm：尺寸/帧率/时长/alpha、边角透明度、绿边残留、首尾帧循环差
# 用法: python maodie-check.py [动画目录]
# 帧数据走 rawvideo 管道，避免临时 PNG 偶发写入不完整导致的误报
import json, os, subprocess, sys
from PIL import Image

HOME = os.path.expanduser('~')
DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, '.dsh', 'dsh-pet', 'pet', 'maodie-animation')

def probe(f):
    raw = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', f],
                         capture_output=True, text=True, encoding='utf-8').stdout
    d = json.loads(raw)
    s = next(x for x in d['streams'] if x['codec_type'] == 'video')
    num, den = (s.get('avg_frame_rate') or '0/1').split('/')
    fps = float(num) / float(den) if float(den) else 0
    return dict(w=s['width'], h=s['height'], fps=round(fps, 2), dur=float(d['format']['duration']),
                alpha=s.get('tags', {}).get('alpha_mode') == '1' or (s.get('pix_fmt') or '').startswith('yuva'),
                bytes=os.path.getsize(f))

def frame(f, info, t):
    # VP9-alpha 用输入 seek 会解不出帧，首帧直接取第 1 帧，尾帧用 -sseof
    seek = ['-sseof', f'-{t}'] if t > 0 else []
    args = ['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', *seek, '-i', f,
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']
    data = subprocess.run(args, capture_output=True, check=True).stdout
    n = info['w'] * info['h'] * 4
    if len(data) < n:
        raise RuntimeError(f'解帧不完整: {len(data)} < {n}')
    return Image.frombytes('RGBA', (info['w'], info['h']), data[:n])

def stats(im):
    w, h = im.size
    a = im.getchannel('A')
    px = a.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    trans = sum(1 for y in range(0, h, 4) for x in range(0, w, 4) if px[x, y] < 8) / ((w // 4) * (h // 4))
    # 绿边残留：不透明且明显偏绿的像素占比
    rgb = im.convert('RGB'); pr = rgb.load(); pa = px
    green = 0; opaque = 0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            al = pa[x, y]
            if al > 32:
                opaque += 1
                r, g, b = pr[x, y]
                if g > 90 and g > r * 1.35 and g > b * 1.35:
                    green += 1
    return corners, trans, (green / opaque if opaque else 0)

def diff(a, b):
    pa, pb = a.load(), b.load()
    w, h = a.size
    s = n = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            ca, cb = pa[x, y], pb[x, y]
            s += abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2]) + abs(ca[3] - cb[3])
            n += 1
    return s / (n * 4)

files = sorted(f for f in os.listdir(DIR) if f.endswith('.webm'))
print(f'{len(files)} 个动画 @ {DIR}\n')
for i, f in enumerate(files, 1):
    p = os.path.join(DIR, f)
    try:
        info = probe(p)
        first = frame(p, info, 0)
        last = frame(p, info, 0.2)
        corners, trans, green = stats(first)
        d = diff(first, last)
        flags = []
        if not info['alpha']: flags.append('无alpha')
        if info['w'] != info['h']: flags.append('非正方形')
        if info['w'] not in (512,): flags.append(f"尺寸{info['w']}")
        if abs(info['fps'] - 12) > 1.5 and info['fps'] != 8: flags.append(f"fps{info['fps']}")
        if max(corners) > 8: flags.append('边角不透明')
        if trans < 0.3: flags.append(f'透明占比低{trans:.0%}')
        if green > 0.02: flags.append(f'绿边{green:.1%}')
        if d > 25: flags.append(f'首尾差{d:.1f}')
        status = 'OK' if not flags else '⚠ ' + ' '.join(flags)
        print(f"[{i:02d}] {f:20s} {info['w']}x{info['h']} {info['fps']}fps {info['dur']:.1f}s "
              f"{info['bytes']//1024}KB alpha={'1' if info['alpha'] else '0'} "
              f"透明{trans:.0%} 绿边{green:.1%} 首尾差{d:.1f}  {status}")
    except Exception as e:
        print(f"[{i:02d}] {f}: 检查失败 {e}")

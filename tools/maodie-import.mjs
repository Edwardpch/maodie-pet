#!/usr/bin/env node
// 把豆包生成的绿幕视频批量转成 dsh-pet 用的 VP9-alpha webm，并登记到 maodie-config.json
// 用法:
//   node maodie-import.mjs <输入目录> [--register] [--category 小动作] [--size 512] [--fps 12] [--crf 32] [--dry-run]
// 命名: 输入文件 <动作名>.mp4 → maodie-animation/<动作名>.webm；动作名会写进 config 对应分类
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MATTE = path.join(HERE, 'maodie-matte.py')

const HOME = os.homedir()
const PET_DIR = path.join(HOME, '.dsh', 'dsh-pet', 'pet')
const ANIM_DIR = path.join(PET_DIR, 'maodie-animation')
const CONFIG = path.join(PET_DIR, 'maodie-config.json')
const EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

function parseArgs(argv) {
  const out = { dir: null, register: false, category: '小动作', size: 512, fps: 12, crf: 32, dryRun: false, chroma: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--register') out.register = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--chroma') out.chroma = true
    else if (a === '--category') out.category = argv[++i]
    else if (a === '--size') out.size = Number(argv[++i])
    else if (a === '--fps') out.fps = Number(argv[++i])
    else if (a === '--crf') out.crf = Number(argv[++i])
    else if (!a.startsWith('--')) out.dir = a
  }
  if (!out.dir) out.dir = path.join(process.cwd(), 'pet-src')
  return out
}

function probe(file) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })
  const d = JSON.parse(raw)
  const s = d.streams.find(x => x.codec_type === 'video') || {}
  return {
    w: s.width, h: s.height,
    dur: Number(d.format?.duration || s.duration || 0),
    alpha: s.tags?.alpha_mode === '1' || /^yuva/.test(s.pix_fmt || ''),
    bytes: Number(d.format?.size || 0),
  }
}

function convert(src, dst, opt) {
  if (!opt.chroma) {
    // 豆包出来的不一定是纯 #00FF00，多是灰绿影棚；按色相抠更稳
    execFileSync('python', [MATTE, src, dst, '--size', String(opt.size), '--fps', String(opt.fps), '--crf', String(opt.crf)], { stdio: 'inherit' })
    return
  }
  const crop = `crop=min(iw\\,ih):min(iw\\,ih)`
  const vf = [
    crop,
    `scale=${opt.size}:${opt.size}:flags=lanczos`,
    'format=rgba',
    'colorkey=0x00FF00:0.30:0.08',
  ].join(',')
  const args = [
    '-y', '-v', 'error', '-i', src,
    '-vf', vf, '-an',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', String(opt.crf),
    '-row-mt', '1', '-auto-alt-ref', '0',
    '-r', String(opt.fps),
    dst,
  ]
  execFileSync('ffmpeg', args, { stdio: 'inherit' })
}

function register(name, category) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  const cats = cfg.animations?.categories || []
  let cat = cats.find(c => c.id === category)
  if (!cat) { cat = { id: category, weight: 10, actions: [] }; cats.push(cat) }
  if (!cat.actions.includes(name)) {
    cat.actions.push(name)
    fs.copyFileSync(CONFIG, `${CONFIG}.bak-${Date.now()}`)
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
    return 'added'
  }
  return 'exists'
}

const opt = parseArgs(process.argv.slice(2))
if (!fs.existsSync(opt.dir)) { console.error(`输入目录不存在: ${opt.dir}`); process.exit(1) }
fs.mkdirSync(ANIM_DIR, { recursive: true })

const files = fs.readdirSync(opt.dir)
  .filter(f => EXTS.has(path.extname(f).toLowerCase()))
  .filter(f => !f.startsWith('.'))

if (!files.length) { console.log(`没有可转换的视频（${[...EXTS].join(' ')}）: ${opt.dir}`); process.exit(0) }

for (const f of files) {
  const name = path.basename(f, path.extname(f))
  const src = path.join(opt.dir, f)
  const dst = path.join(ANIM_DIR, `${name}.webm`)
  const srcInfo = probe(src)
  console.log(`\n[${f}] ${srcInfo.w}x${srcInfo.h} ${srcInfo.dur.toFixed(1)}s → ${dst}`)
  if (opt.dryRun) { console.log('  (dry-run，跳过)'); continue }
  convert(src, dst, opt)
  const info = probe(dst)
  if (!info.alpha) { console.error(`  ✗ ${name}: 输出无 alpha，检查源视频背景是否与猫色相可分`); continue }
  console.log(`  ✓ ${info.w}x${info.h} ${info.dur.toFixed(1)}s ${(info.bytes / 1024).toFixed(0)}KB alpha=1`)
  if (opt.register) console.log(`  登记到分类「${opt.category}」: ${register(name, opt.category)}`)
}
console.log('\n完成。桌面端右键「重载配置」或刷新页面即可看到新动作。')

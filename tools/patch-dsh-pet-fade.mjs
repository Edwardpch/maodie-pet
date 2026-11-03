#!/usr/bin/env node
// 关掉 dsh-pet 换动作时的“闪一下”。
//
// 原因：dsh-pet 用两个 <video> 双缓冲，切换时给新元素加 .is-front、同时给旧元素
// 摘掉 .is-front，两边各有 0.18s 的 opacity 过渡。过渡中点两帧各 50% 不透明度，
// 合成到透明窗口上 alpha 只剩 0.75，看起来就是每次换动作“发白闪一下”。
//
// 修法：旧素材始终不透明垫在下面（z-index 2），新素材在上层（z-index 3）淡入，
// 240ms 后再把旧的摘掉。合成 alpha 恒为 1，视觉上是干净的叠化。
//
// 改的是 dsh-pet 自己的文件，所以：
//   · 升级 / 重装 dsh-pet 之后要再跑一次（脚本幂等，重复跑只说 already patched）
//   · 只影响本机这个 profile，不动别人的仓库
//   · 改完刷新 DSH 页面（前端 bundle）；万一宿主缓存了 bundle，重启一次 DSH
//
// 用法：
//   node tools/patch-dsh-pet-fade.mjs            # 打补丁
//   node tools/patch-dsh-pet-fade.mjs --check    # 只看状态，不写
//   node tools/patch-dsh-pet-fade.mjs --profile web
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKER = '硬切 + 垫底';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'desktop';
if (!profile) {
  console.error('--profile 需要一个名字，例如 desktop');
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const root = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-pet');
if (!existsSync(root)) {
  console.error(`没找到 ${root}\n（dsh-pet 没装在这个 profile 里？）`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function backupAndWrite(file, next) {
  const backup = `${file}.bak-${stamp}`;
  copyFileSync(file, backup);
  writeFileSync(file, next);
  return backup;
}

/** 页面里真正画宠物的那份前端 bundle。 */
function patchClient(file) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(MARKER)) return { file, state: 'patched' };

  // 要同时解决两件事：
  //   1) 闪白 —— 两个 <video> 各做 0.18s opacity 过渡，中点两帧各 50%，合成 alpha 0.75；
  //   2) 消失一下 —— 新素材首帧还没解码出来时，旧帧已经被摘掉，窗口里就空了。
  // 做法：CSS 过渡关掉（硬切），旧帧保持完全不透明垫底（z-index 2），新帧直接叠上去（3），
  // 150ms 后再摘旧的。既没有半透明中间帧，也不会露出空白。
  const baseCss =
    '".dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;';
  const removeFront = '					old.current.classList.remove("is-front");';

  const baseStart = text.indexOf(baseCss);
  if (baseStart === -1) return { file, state: 'mismatch', reason: '没找到 .dsh-pet-video 的 CSS' };
  const baseEnd = text.indexOf('"', baseStart + 1);
  const baseRule = text.slice(baseStart, baseEnd + 1);
  if (!text.includes(removeFront)) return { file, state: 'mismatch', reason: '没找到摘 is-front 的那一行' };
  if (checkOnly) return { file, state: 'not-patched' };

  const layered = [
    '					// (maodie-pet 补丁) 硬切 + 垫底：旧帧保持完全不透明在下面，新帧直接叠上去，',
    '					// 150ms 后再摘掉旧的。没有 opacity 过渡，所以不会半透明闪，也不会在新帧没解出来时露出空白。',
    '					const prev = old.current;',
    '					prev.style.zIndex = "2";',
    '					el.style.zIndex = "3";',
    '					window.setTimeout(() => {',
    '						if (prev !== el) {',
    '							prev.classList.remove("is-front");',
    '							prev.style.zIndex = "";',
    '						}',
    '						if (el.style.zIndex === "3") el.style.zIndex = "";',
    '					}, 150);',
  ].join('\n');

  let next = text.replace(baseRule, baseRule.replace('transition:opacity .18s ease;', 'transition:none;'));
  next = next.replace(removeFront, layered);
  return { file, state: 'patched-now', backup: backupAndWrite(file, next) };
}

/** Electron 桌面精灵的旧路径：直接把 CSS 过渡关掉（有的版本用它画桌面宠物）。 */
function patchHelperHtml(file) {
  const ORIGINAL = 'transition: opacity 0.18s ease;';
  const text = readFileSync(file, 'utf8');
  if (text.includes('patched: 双缓冲交叉淡入')) return { file, state: 'patched' };
  if (!text.includes(ORIGINAL)) return { file, state: 'absent' };
  if (checkOnly) return { file, state: 'not-patched' };
  const patched = text.replace(
    ORIGINAL,
    '/* patched: 双缓冲交叉淡入里两帧各 50% 不透明度，像素 alpha 掉到 0.75，透明桌面下会闪。 */\n        transition: none;',
  );
  return { file, state: 'patched-now', backup: backupAndWrite(file, patched) };
}

const jobs = [
  { file: join(root, 'lib', 'client.js'), run: patchClient, hint: '改完刷新 DSH 页面生效' },
  { file: join(root, 'runtime', 'electron-helper', 'index.html'), run: patchHelperHtml, hint: '重新加载桌面精灵生效' },
];

let changed = 0;
let failed = 0;
for (const job of jobs) {
  if (!existsSync(job.file)) {
    console.log(`skip    ${job.file}（不存在）`);
    continue;
  }
  const result = job.run(job.file);
  if (result.state === 'patched-now') changed += 1;
  if (result.state === 'mismatch') failed += 1;
  const label = {
    patched: 'already patched',
    'patched-now': 'patched    ',
    'not-patched': 'not patched',
    absent: 'skip       ',
    mismatch: 'MISMATCH   ',
  }[result.state];
  console.log(`${label} ${job.file}`);
  if (result.reason) console.log(`          ${result.reason}`);
  if (result.backup) console.log(`          backup: ${result.backup}`);
  if (result.state === 'patched-now') console.log(`          ${job.hint}`);
}

if (checkOnly) process.exit(failed > 0 ? 1 : 0);
if (failed > 0) {
  console.error('\n有文件结构变了，先人工看一下再改。');
  process.exit(1);
}
if (changed === 0) console.log('\n没有需要改的（都已打过补丁或本来没有这个文件）。');

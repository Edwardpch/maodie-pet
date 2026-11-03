#!/usr/bin/env node
// 关掉 dsh-pet 桌面精灵的 0.18s 交叉淡入 —— 两段半透明视频各占 50% 不透明度时，
// 像素 alpha 会掉到 0.75，透明桌面下就是每次换动作“闪一下”。
//
// 这个改动落在 dsh-pet 自己的 runtime/electron-helper/index.html 里，所以：
//   · 升级/重装 dsh-pet 之后要再跑一次（脚本幂等，重复跑只会说 already patched）
//   · 不想动别人的文件就别跑；它只影响本机那一个 profile
//
// 用法：
//   node tools/patch-dsh-pet-fade.mjs            # 打补丁
//   node tools/patch-dsh-pet-fade.mjs --check    # 只看状态，不写
//   node tools/patch-dsh-pet-fade.mjs --profile web
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCHED = 'transition: none;';
const ORIGINAL = 'transition: opacity 0.18s ease;';
const MARKER = 'patched: 双缓冲交叉淡入';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'desktop';
if (!profile) {
  console.error('--profile 需要一个名字，例如 desktop');
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const htmlPath = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper', 'index.html');

if (!existsSync(htmlPath)) {
  console.error(`没找到 ${htmlPath}\n（dsh-pet 没装在这个 profile 里？）`);
  process.exit(1);
}

const text = readFileSync(htmlPath, 'utf8');
if (text.includes(MARKER)) {
  console.log(`already patched: ${htmlPath}`);
  process.exit(0);
}
if (!text.includes(ORIGINAL)) {
  console.error(`没找到预期的 CSS（${ORIGINAL}），dsh-pet 可能换写法了，先人工看一下：\n${htmlPath}`);
  process.exit(1);
}
if (checkOnly) {
  console.log(`not patched: ${htmlPath}`);
  process.exit(0);
}

// 只改 video.pet-video 那一条；气泡的 0.25s 淡出不碰。
const anchor = `        opacity: 0;\n        ${ORIGINAL}\n      }\n      video.pet-video.is-front {`;
if (!text.includes(anchor)) {
  console.error('CSS 结构变了（锚点没匹配上），先人工看一下再改。');
  process.exit(1);
}
const patched = text.replace(
  anchor,
  `        opacity: 0;\n        /* ${MARKER}里两帧各 50% 不透明度，像素 alpha 掉到 0.75，\n           透明桌面下表现为每次换动作“闪一下”。精灵动画本来就该硬切。 */\n        ${PATCHED}\n      }\n      video.pet-video.is-front {`,
);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${htmlPath}.bak-${stamp}`;
copyFileSync(htmlPath, backup);
writeFileSync(htmlPath, patched);
console.log(`patched: ${htmlPath}`);
console.log(`backup : ${backup}`);
console.log('重启一次桌宠才会生效：POST /dsh-pet-7340/reload（或右键「重载配置」）。');

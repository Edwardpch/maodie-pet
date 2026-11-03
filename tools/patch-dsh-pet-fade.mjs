#!/usr/bin/env node
// 手动给 dsh-pet 打“换动作不闪”的补丁（插件加载时其实已经自动跑过一次了）。
//
// 什么时候还需要手动跑：
//   · 刚升级 / 重装了 dsh-pet，而且不想重启 DSH —— 手动补完刷新页面即可；
//   · 想先看看当前状态（--check），或换一个 profile（--profile web）。
//
// 用法：
//   node tools/patch-dsh-pet-fade.mjs            # 打补丁
//   node tools/patch-dsh-pet-fade.mjs --check    # 只看状态，不写
//   node tools/patch-dsh-pet-fade.mjs --profile web
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { applyFadePatch } from '../lib/fade-patch.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'desktop';
if (!profile) {
  console.error('--profile 需要一个名字，例如 desktop');
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profile);
const root = join(profileDir, 'node_modules', 'dsh-pet');
if (!existsSync(root)) {
  console.error(`没找到 ${root}\n（dsh-pet 没装在这个 profile 里？）`);
  process.exit(1);
}

const LABEL = {
  patched: 'already patched',
  'patched-now': 'patched    ',
  'not-patched': 'not patched',
  absent: 'skip       ',
  mismatch: 'MISMATCH   ',
};

const dryRun = checkOnly;
const result = applyFadePatch({ profileDir, dryRun });

// applyFadePatch 只回分类结果，这里按文件顺序再报一遍，方便肉眼核对。
for (const file of [...result.patched, ...result.already, ...result.skipped]) {
  const state = result.patched.includes(file) ? 'patched-now' : result.already.includes(file) ? 'patched' : 'absent';
  console.log(`${LABEL[state]} ${file}`);
}
for (const fail of result.failed) {
  console.log(`${LABEL.mismatch} ${fail.file}`);
  console.log(`          ${fail.reason}`);
}

if (checkOnly) {
  const notPatched = result.failed.length > 0 || result.skipped.length === 0;
  process.exit(result.failed.length > 0 ? 1 : 0);
}
if (result.failed.length > 0) {
  console.error('\n有文件结构变了，先人工看一下再改。');
  process.exit(1);
}
if (result.patched.length === 0) console.log('\n没有需要改的（都已打过补丁或本来没有这个文件）。');
else console.log('\n补好了，刷新 DSH 页面生效。');

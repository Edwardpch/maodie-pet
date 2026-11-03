// 自动给 dsh-pet 的“换动作闪白 / 消失一下”打补丁。
//
// 背景：dsh-pet 用两个 <video> 做双缓冲。默认两边各做 0.18s opacity 过渡，过渡中点
// 两帧各 50% 不透明度，合成到透明窗口上 alpha 只剩 0.75 —— 每次换动作“发白闪一下”；
// 只关掉过渡改成硬切，又会在新素材首帧还没解码出来时把旧帧摘掉，窗口空一瞬。
//
// 补丁做法：CSS 过渡关掉（硬切），旧帧保持完全不透明垫在下面（z-index 2），新帧直接
// 叠上去（z-index 3），150ms 后再摘掉旧的。既没有半透明中间帧，也没有空白帧。
//
// 这补的是 dsh-pet 的文件，所以插件每次加载都调一次（幂等：已打过就只回 patched）。
// dsh-pet 升级会把这些文件覆盖回去，于是下次启动又自动补上 —— 不用再手动跑脚本。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/** 页面上真正画宠物的前端 bundle。 */
export const CLIENT_MARKER = '硬切 + 垫底';

const BASE_CSS =
  '".dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;';

const REMOVE_FRONT_RE = /^([ \t]*)old\.current\.classList\.remove\("is-front"\);$/m;

const LAYERED = (indent) => [
  `${indent}// (maodie-pet 补丁) 硬切 + 垫底：旧帧保持完全不透明在下面，新帧直接叠上去，`,
  `${indent}// 150ms 后再摘掉旧的。没有 opacity 过渡，所以不会半透明闪，也不会在新帧没解出来时露出空白。`,
  `${indent}const prev = old.current;`,
  `${indent}prev.style.zIndex = "2";`,
  `${indent}el.style.zIndex = "3";`,
  `${indent}window.setTimeout(() => {`,
  `${indent}\tif (prev !== el) {`,
  `${indent}\t\tprev.classList.remove("is-front");`,
  `${indent}\t\tprev.style.zIndex = "";`,
  `${indent}\t}`,
  `${indent}\tif (el.style.zIndex === "3") el.style.zIndex = "";`,
  `${indent}}, 150);`,
].join('\n');

const HELPER_CSS = 'transition: opacity 0.18s ease;';
const HELPER_MARKER = 'patched: 双缓冲交叉淡入';

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function backupAndWrite(file, next) {
  const backup = `${file}.bak-${stamp()}`;
  copyFileSync(file, backup);
  writeFileSync(file, next);
  return backup;
}

/** 返回 {file, state}，state ∈ patched | patched-now | absent | mismatch | not-patched。 */
export function patchClient(file, { dryRun = false } = {}) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(CLIENT_MARKER)) return { file, state: 'patched' };

  const start = text.indexOf(BASE_CSS);
  if (start === -1) return { file, state: 'mismatch', reason: '没找到 .dsh-pet-video 的 CSS' };
  const end = text.indexOf('"', start + 1);
  const rule = text.slice(start, end + 1);
  if (!rule.includes('transition:opacity .18s ease;'))
    return { file, state: 'mismatch', reason: 'CSS 里没有预期的 0.18s 过渡' };
  const removeMatch = REMOVE_FRONT_RE.exec(text);
  if (!removeMatch) return { file, state: 'mismatch', reason: '没找到摘 is-front 的那一行' };
  if (dryRun) return { file, state: 'not-patched' };

  let next = text.replace(rule, rule.replace('transition:opacity .18s ease;', 'transition:none;'));
  next = next.replace(removeMatch[0], LAYERED(removeMatch[1]));
  return { file, state: 'patched-now', backup: backupAndWrite(file, next) };
}

/** Electron 桌面精灵的旧路径（有的 dsh-pet 版本用它画桌面宠物）。 */
export function patchHelperHtml(file, { dryRun = false } = {}) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(HELPER_MARKER)) return { file, state: 'patched' };
  if (!text.includes(HELPER_CSS)) return { file, state: 'absent' };
  if (dryRun) return { file, state: 'not-patched' };
  const patched = text.replace(
    HELPER_CSS,
    '/* patched: 双缓冲交叉淡入里两帧各 50% 不透明度，像素 alpha 掉到 0.75，透明桌面下会闪。 */\n        transition: none;',
  );
  return { file, state: 'patched-now', backup: backupAndWrite(file, patched) };
}

export const FADE_PATCH_TARGETS = (profileDir) => {
  const root = join(profileDir, 'node_modules', 'dsh-pet');
  return [
    { file: join(root, 'lib', 'client.js'), run: patchClient },
    { file: join(root, 'runtime', 'electron-helper', 'index.html'), run: patchHelperHtml },
  ];
};

/**
 * 插件加载时自动补。失败只记日志，绝不阻断启动。
 * @returns {{patched: string[], already: string[], skipped: string[], failed: {file: string, reason: string}[]}}
 */
export function applyFadePatch({ profileDir, logger, dryRun = false } = {}) {
  const out = { patched: [], already: [], skipped: [], failed: [] };
  if (!profileDir) return out;
  for (const target of FADE_PATCH_TARGETS(profileDir)) {
    if (!existsSync(target.file)) {
      out.skipped.push(target.file);
      continue;
    }
    try {
      const r = target.run(target.file, { dryRun });
      if (r.state === 'patched-now') out.patched.push(r.file);
      else if (r.state === 'patched') out.already.push(r.file);
      else if (r.state === 'mismatch') out.failed.push({ file: r.file, reason: r.reason ?? '结构不匹配' });
      else out.skipped.push(r.file);
    } catch (err) {
      out.failed.push({ file: target.file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (out.patched.length) logger?.info?.(`maodie-pet：已给 dsh-pet 打上“换动作不闪”的补丁（${out.patched.length} 个文件），刷新页面生效`);
  for (const f of out.failed) logger?.warn?.(`maodie-pet：dsh-pet 补丁没打上（${f.file}）：${f.reason}`);
  return out;
}

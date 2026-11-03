// 让「固定橘猫」这类配置改动**不重启桌面 Helper**也能即时生效。
//
// 背景：dsh-pet 的桌面渲染端（runtime/electron-helper）只在启动时读一次 /config，
// 之后 /state 里只有 balance / workStatus / menu / pets.* 这些叶子会被消费，**config
// 段的变化它不看**。所以改 pets[].fixedEnabled / animationWeights 之后，要是不重启
// Helper，宠物还会照旧走动；而重启 Helper（POST /reload）会把**所有**桌面宠物窗口
// 全部重建一遍 —— 用户看到的"点一下固定，所有宠物都重新加载"就是这个。
//
// 补丁做法：在 events.js 末尾挂一个 1.2s 的轻量轮询，读 /config，按 id 把
// fixedEnabled / animationWeights 同步进**已存在**的 sprite（sprite 掷骰时才读这两个
// 字段，所以下一次掷骰就生效），窗口和正在播的动画都不动。
//
// 只补 dsh-pet 的文件：插件每次加载都调一次（幂等），dsh-pet 升级覆盖回去后下次启动
// 又会自动补上。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_MARKER = '// [maodie-pet] 实时配置同步';

const BLOCK = `${LIVE_MARKER}
// 桌面端只在启动时读 /config；配置里的 fixedEnabled / animationWeights 变了要能让
// 已经开着的窗口跟着变，否则只能靠重启 Helper（那会把所有宠物窗口重建一遍）。
// 这里 1.2s 读一次 /config，按 id 把这两个字段同步进现有 sprite —— 不建窗口、不动
// 正在播的动画，下一次掷骰就会用新值。
(function () {
  if (typeof sprites === 'undefined' || typeof BASE === 'undefined') return;
  if (typeof fetch !== 'function') return;
  var sig = null;
  var busy = false;
  function readPets(merged) {
    var out = [];
    Object.keys(merged || {}).forEach(function (layer) {
      var v = merged[layer];
      if (!v || !Array.isArray(v.pets)) return;
      v.pets.forEach(function (p) { if (p && typeof p.id === 'string') out.push({ layer: v, pet: p }); });
    });
    return out;
  }
  function signature(list) {
    return JSON.stringify(list.map(function (e) {
      return [e.pet.id, e.pet.fixedEnabled === true, e.pet.animationWeights || null];
    }));
  }
  function tick() {
    if (!busy) {
      busy = true;
      fetch(BASE + '/config', { cache: 'no-store' }).then(function (r) {
        return r && r.ok ? r.json() : null;
      }).then(function (merged) {
        if (!merged) return;
        var list = readPets(merged);
        var next = signature(list);
        if (sig === null) { sig = next; return; }
        if (next === sig) return;
        sig = next;
        var byId = {};
        list.forEach(function (e) { byId[e.pet.id] = e; });
        for (var i = 0; i < sprites.length; i++) {
          var s = sprites[i];
          var hit = s && s.pet && byId[s.pet.id];
          if (!hit) continue;
          s.pet.fixedEnabled = hit.pet.fixedEnabled === true;
          s.weights = hit.pet.animationWeights || hit.layer.animationWeights || s.weights;
        }
      }).catch(function () {}).then(function () { busy = false; });
    }
    setTimeout(tick, 1200);
  }
  setTimeout(tick, 1500);
})();
`;

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function backupAndWrite(file, next) {
  const backup = `${file}.bak-${stamp()}`;
  copyFileSync(file, backup);
  writeFileSync(file, next);
  return backup;
}

/** 返回 {file, state}，state ∈ patched | patched-now | absent | mismatch。 */
export function patchHelperEvents(file, { dryRun = false } = {}) {
  if (!existsSync(file)) return { file, state: 'absent' };
  const text = readFileSync(file, 'utf8');
  if (text.includes(LIVE_MARKER)) return { file, state: 'patched' };
  if (!text.includes('function startLoops('))
    return { file, state: 'mismatch', reason: 'events.js 里没有 startLoops' };
  if (dryRun) return { file, state: 'not-patched' };
  const next = `${text.replace(/\s*$/, '')}\n\n${BLOCK}`;
  return { file, state: 'patched-now', backup: backupAndWrite(file, next) };
}

export function liveConfigTargets(profileDir) {
  return [join(profileDir, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper', 'events.js')];
}

/** 给当前 profile 里的 dsh-pet 打实时配置补丁；失败只记日志，不抛。 */
export function applyLiveConfigPatch({ profileDir, logger, dryRun = false } = {}) {
  const out = { patched: [], already: [], skipped: [], failed: [] };
  if (!profileDir) return out;
  for (const file of liveConfigTargets(profileDir)) {
    try {
      const r = patchHelperEvents(file, { dryRun });
      if (r.state === 'patched-now') out.patched.push(r.file);
      else if (r.state === 'patched') out.already.push(r.file);
      else if (r.state === 'absent' || r.state === 'not-patched') out.skipped.push(r.file);
      else {
        out.failed.push({ file: r.file, reason: r.reason });
        logger?.warn?.(`maodie-pet: 桌面宠物实时配置补丁跳过（${r.reason}）`);
      }
    } catch (e) {
      out.failed.push({ file, reason: e instanceof Error ? e.message : String(e) });
      logger?.warn?.(`maodie-pet: 实时配置补丁失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

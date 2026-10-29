import assert from 'node:assert/strict';
import { installPet, rollbackPet, mergeConfig } from '../lib/index.js';
import { configSnapshot } from '../lib/merge.mjs';
import { writeManifest } from '../tools/make-manifest.mjs';
import { mkdtempSync, renameSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

void availableParallelism;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'pets', 'maodie');
const sandbox = mkdtempSync(join(tmpdir(), 'maodie-sb-'));

const pending = [];
function check(name, fn) {
    pending.push({ name, fn });
}

const mkHome = () => join(mkdtempSync(join(sandbox, 'h-')), 'home');

/** 造一份可控的素材源（文件内容是文本，便于测试里比对）。 */
function makeSource() {
    const dir = mkdtempSync(join(sandbox, 'src-'));
    mkdirSync(join(dir, 'maodie-animation'), { recursive: true });
    writeFileSync(join(dir, 'maodie-config.json'), JSON.stringify({
        pets: [{ id: 'maodie', size: 400 }],
        animations: {
            idle: ['待机', '睡觉'],
            clicks: ['开心'],
            categories: [{ id: '小动作', weight: 20, actions: ['睡觉', '开心'] }],
        },
    }, null, 2));
    writeFileSync(join(dir, 'maodie-animation', '待机.webm'), 'idle-v1');
    writeFileSync(join(dir, 'maodie-animation', '睡觉.webm'), 'sleep-v1');
    writeFileSync(join(dir, 'maodie-animation', '开心.webm'), 'happy-v1');
    writeManifest(dir, '0.0.0-test');
    return dir;
}

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

check('首次安装：素材与 config 落盘，状态文件与合并基线都在', () => {
    const home = mkHome();
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    const r = installPet({ home, now: '20260101-000000' });
    assert.equal(r.status, 'installed');
    assert.equal(r.mode, 'fresh');
    assert.ok(r.copied.length >= 32, `copied=${r.copied.length}`);
    assert.ok(existsSync(join(target, 'maodie-config.json')));
    assert.ok(existsSync(join(target, 'maodie-animation', '待机.webm')));
    const state = readJson(join(home, 'dsh-pet', 'pet', '.maodie-pet.json'));
    assert.ok(state.mergedConfig, '首次安装也要留合并基线');
    assert.ok(state.owned.length >= 32);
});

check('重复安装是幂等的：第二次什么都不写', () => {
    const home = mkHome();
    installPet({ home, now: '20260101-000000' });
    const again = installPet({ home, now: '20260101-000001' });
    assert.equal(again.status, 'up-to-date');
    assert.equal(again.copied.length + again.updated.length, 0);
    assert.equal(again.config.written, false);
    assert.equal(again.backupDir, undefined, '没变化就不该产生备份目录');
});

check('用户改配置后不产生备份噪声，且用户加的动作保留', () => {
    const home = mkHome();
    installPet({ home, now: '20260101-000000' });
    const cfgFile = join(home, 'dsh-pet', 'pet', 'maodie', 'maodie-config.json');
    const cfg = readJson(cfgFile);
    // 拿包里的动作改顺序/挪池子，等价于用户手动调整
    cfg.animations.idle = ['睡觉', '待机'];
    writeJson(cfgFile, cfg);
    const r = installPet({ home, now: '20260101-000002' });
    assert.equal(r.status, 'up-to-date');
    assert.equal(r.config.written, false);
    assert.deepEqual(readJson(cfgFile).animations.idle, ['睡觉', '待机']);
});

check('升级：未改动的素材被新版覆盖，用户替换过的保留并进备份', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    writeFileSync(join(target, 'maodie-animation', '睡觉.webm'), 'user-replaced');
    writeFileSync(join(dir, 'maodie-animation', '待机.webm'), 'idle-v2');
    writeFileSync(join(dir, 'maodie-animation', '睡觉.webm'), 'sleep-v2');
    writeManifest(dir, '0.0.0-t2');
    const r = installPet({ home, sourceDir: dir, now: '20260202-000000' });
    assert.equal(r.status, 'updated');
    assert.ok(r.updated.includes('maodie-animation/待机.webm'), `updated=${r.updated}`);
    assert.ok(r.skipped.includes('maodie-animation/睡觉.webm'), `skipped=${r.skipped}`);
    assert.equal(readFileSync(join(target, 'maodie-animation', '待机.webm'), 'utf8'), 'idle-v2');
    assert.equal(readFileSync(join(target, 'maodie-animation', '睡觉.webm'), 'utf8'), 'user-replaced');
    assert.ok(existsSync(join(r.backupDir, 'maodie-animation', '待机.webm')));
});

check('新动作进配置与分类，用户顺序与自定义动作不受影响', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    const cfgFile = join(target, 'maodie-config.json');
    const mine = readJson(cfgFile);
    mine.animations.clicks = ['开心'];
    mine.animations.idle.push('走路');
    writeJson(cfgFile, mine);
    writeFileSync(join(target, 'maodie-animation', '走路.webm'), 'walk-mine');
    const theirs = readJson(join(dir, 'maodie-config.json'));
    theirs.animations.idle.push('追尾巴');
    theirs.animations.categories.push({ id: '生气', weight: 5, actions: ['炸毛'] });
    writeJson(join(dir, 'maodie-config.json'), theirs);
    writeFileSync(join(dir, 'maodie-animation', '追尾巴.webm'), 'tail-v1');
    writeFileSync(join(dir, 'maodie-animation', '炸毛.webm'), 'puff-v1');
    writeManifest(dir, '0.0.0-t3');
    const r = installPet({ home, sourceDir: dir, now: '20260303-000000' });
    assert.ok(r.config.added.includes('追尾巴'), `added=${r.config.added}`);
    const merged = readJson(cfgFile);
    assert.deepEqual(merged.animations.clicks, ['开心'], '用户顺序保留');
    assert.ok(merged.animations.idle.includes('走路'), '用户自定义动作保留');
    assert.ok(merged.animations.idle.includes('追尾巴'), '新动作进 idle');
    assert.ok(merged.animations.categories.some(c => c.id === '生气'), '新分类进配置');
    const again = installPet({ home, sourceDir: dir, now: '20260303-000001' });
    assert.equal(again.status, 'up-to-date', '升级后再跑一次应幂等');
});

// 注意：本机删除含中文名的文件会让进程直接死掉（见 README「已知限制」），
// 所以"用户删掉素材"一律用 renameSync 挪到沙箱外的临时目录来模拟。
function simulateUserDelete(file) {
    const stash = mkdtempSync(join(tmpdir(), 'maodie-stash-'));
    renameSync(file, join(stash, 'moved.webm'));
}

check('用户删掉的素材默认不复活，--restore 才补', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    simulateUserDelete(join(target, 'maodie-animation', '开心.webm'));
    const normal = installPet({ home, sourceDir: dir, now: '20260102-000000' });
    assert.ok(normal.skipped.includes('maodie-animation/开心.webm'), `skipped=${normal.skipped}`);
    assert.equal(existsSync(join(target, 'maodie-animation', '开心.webm')), false);
    const restored = installPet({ home, sourceDir: dir, restore: true, now: '20260103-000000' });
    assert.ok(restored.copied.includes('maodie-animation/开心.webm'), `copied=${restored.copied}`);
    assert.equal(existsSync(join(target, 'maodie-animation', '开心.webm')), true);
});

check('--prune 删除新版已移除的素材，用户改过的留着', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    writeFileSync(join(target, 'maodie-animation', '开心.webm'), 'user-edited');
    simulateUserDelete(join(dir, 'maodie-animation', '睡觉.webm'));
    simulateUserDelete(join(dir, 'maodie-animation', '开心.webm'));
    const cfg = readJson(join(dir, 'maodie-config.json'));
    cfg.animations.idle = ['待机'];
    cfg.animations.clicks = [];
    cfg.animations.categories[0].actions = ['待机'];
    writeJson(join(dir, 'maodie-config.json'), cfg);
    writeManifest(dir, '0.0.0-t4');
    const r = installPet({ home, sourceDir: dir, prune: true, now: '20260104-000000' });
    assert.ok(r.removed.includes('maodie-animation/睡觉.webm'), `removed=${r.removed}`);
    assert.ok(r.skipped.includes('maodie-animation/开心.webm'), `skipped=${r.skipped}`);
    // 素材不是被真删，而是挪进本轮备份目录（本机删非 ASCII 文件名会崩）
    assert.equal(existsSync(join(target, 'maodie-animation', '睡觉.webm')), false);
    assert.equal(existsSync(join(r.backupDir, 'maodie-animation', '睡觉.webm')), true);
    assert.equal(existsSync(join(target, 'maodie-animation', '开心.webm')), true);
});

check('从旧版（没有安装清单）升级走保守模式：只追加，不删不改', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    simulateUserDelete(join(home, 'dsh-pet', 'pet', '.maodie-pet.json'));
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    const cfgFile = join(target, 'maodie-config.json');
    const legacy = readJson(cfgFile);
    legacy.animations.idle = ['待机'];
    writeJson(cfgFile, legacy);
    const theirs = readJson(join(dir, 'maodie-config.json'));
    theirs.animations.idle.push('炸毛');
    writeJson(join(dir, 'maodie-config.json'), theirs);
    writeFileSync(join(dir, 'maodie-animation', '炸毛.webm'), 'puff');
    writeManifest(dir, '0.0.0-t5');
    const r = installPet({ home, sourceDir: dir, now: '20260105-000000' });
    assert.equal(r.mode, 'conservative');
    // 保守模式只追加：磁盘上的 idle 原样保留，包里的新动作追加在后面
    assert.deepEqual(readJson(cfgFile).animations.idle, ['待机', '睡觉', '炸毛']);
    assert.ok(r.config.added.includes('炸毛'), `added=${r.config.added}`);
});

check('--force 覆盖用户替换过的素材', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    writeFileSync(join(target, 'maodie-animation', '待机.webm'), 'user-replaced');
    const r = installPet({ home, sourceDir: dir, force: true, now: '20260106-000000' });
    assert.equal(r.mode, 'force');
    assert.ok(r.updated.includes('maodie-animation/待机.webm'), `updated=${r.updated}`);
    assert.equal(readFileSync(join(target, 'maodie-animation', '待机.webm'), 'utf8'), 'idle-v1');
});

check('rollback 还原升级前的文件', () => {
    const home = mkHome();
    const dir = makeSource();
    installPet({ home, sourceDir: dir, now: '20260101-000000' });
    const target = join(home, 'dsh-pet', 'pet', 'maodie');
    const before = readFileSync(join(target, 'maodie-animation', '待机.webm'));
    writeFileSync(join(dir, 'maodie-animation', '待机.webm'), 'idle-v2');
    writeManifest(dir, '0.0.0-t6');
    const up = installPet({ home, sourceDir: dir, now: '20260202-000000' });
    assert.notDeepEqual(readFileSync(join(target, 'maodie-animation', '待机.webm')), before);
    assert.ok(up.backupDir);
    rollbackPet({ home });
    assert.deepEqual(readFileSync(join(target, 'maodie-animation', '待机.webm')), before);
});

check('mergeConfig：只补新增动作，非动画字段保留用户值', () => {
    const ours = {
        pets: [{ id: 'maodie', size: 400 }],
        notificationsEnabled: false,
        animations: { idle: ['待机', '自己的动作'], clicks: ['被摸', '开心'], categories: [{ id: '小动作', weight: 20, actions: ['睡觉'] }] },
    };
    const theirs = {
        pets: [{ id: 'maodie', size: 300 }],
        notificationsEnabled: true,
        animations: { idle: ['待机', '睡觉', '新动作'], clicks: ['开心', '被摸'], categories: [{ id: '小动作', weight: 20, actions: ['睡觉', '新动作'] }] },
    };
    const base = configSnapshot({ animations: { idle: ['待机'], clicks: ['被摸', '开心'], categories: [{ id: '小动作', actions: ['睡觉'] }] } });
    const { config, added } = mergeConfig(ours, theirs, base);
    assert.deepEqual(added, ['睡觉', '新动作']);
    assert.deepEqual(config.animations.idle, ['待机', '自己的动作', '睡觉', '新动作']);
    assert.deepEqual(config.animations.clicks, ['被摸', '开心']);
    assert.deepEqual(config.animations.categories[0].actions, ['睡觉', '新动作']);
    assert.equal(config.pets[0].size, 400);
    assert.equal(config.notificationsEnabled, false);
});

check('包里发布的 .maodie-manifest.json 与素材一致', () => {
    const manifest = readJson(join(SRC, '.maodie-manifest.json'));
    const files = Object.keys(manifest.files);
    assert.ok(files.length >= 32, `files=${files.length}`);
    for (const rel of files)
        assert.ok(existsSync(join(SRC, rel)), `${rel} 在清单里但文件不存在`);
});

// 一项一个子进程：本机（Node 24 / Windows）上同一个进程里反复做 rmSync 临时目录、
// 甚至单纯多 import 几次，都会在第六项左右硬崩（退出码 3221226505 / 0xC0000409）。
// 拆成子进程后每项都是干净的运行时，谁崩了只算那一项失败，不再连累整个套件。
const index = process.argv.indexOf('--only');
if (index === -1) {
    let failed = 0;
    for (let i = 0; i < pending.length; i++) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--only', String(i)], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.status !== 0) {
            failed++;
            process.stderr.write(`FAIL 第 ${i + 1} 项（退出码 ${r.status}${r.signal ? `，signal ${r.signal}` : ''}）\n`);
        }
    }
    process.stderr.write(`\n${pending.length} 项：通过 ${pending.length - failed}，失败 ${failed}\n`);
    process.exitCode = failed === 0 ? 0 : 1;
}
else {
    const only = Number(process.argv[index + 1]);
    const { name, fn } = pending[only];
    const t0 = Date.now();
    try {
        await fn();
        process.stderr.write(`ok   ${name} (${Date.now() - t0}ms)\n`);
    }
    catch (error) {
        process.stderr.write(`FAIL ${name}: ${error && error.message}\n${error && error.stack}\n`);
        process.exitCode = 1;
    }
    // 沙箱里全是含中文名的文件，递归删除本身就会崩（见 README「已知限制」），
    // 清理失败不算失败：临时目录交给系统回收。
    try {
        rmSync(sandbox, { recursive: true, force: true });
    }
    catch {
        /* 忽略 */
    }
}

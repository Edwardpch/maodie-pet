/**
 * maodie-pet —— 宿主半侧（安装器）。
 *
 * 这个仓库的主要内容是桌宠素材（`pets/maodie/`：`maodie-config.json` + 30 个
 * VP9-alpha webm）。放进 DSH 的插件市场后，用户点「安装」应当直接得到一只橘猫，
 * 而不是装完一个空插件再手动拷目录——所以由这个入口把素材落到
 * `$DSH_HOME/dsh-pet/pet/maodie/`。
 *
 * 行为约定：
 * - 幂等：第二次加载发现版本与文件都齐了就直接跳过。
 * - 不覆盖：已存在的 config / webm 一律保留（用户可能改过配置、换过动作）；
 *   需要强刷时用 `--force`。
 * - 可测试：`installPet()` 是纯函数式的（只依赖参数里的路径），导入本模块
 *   不会产生任何副作用；只有 Cordis 调用 `apply()` 或在命令行跑 `--install`
 *   才会写盘。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis 插件名，与 cordis.patch.yml 里的 `id` 一致。 */
export const name = 'maodie-pet';

/** 本包根目录（lib/ 的上一级）。 */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 素材源目录。 */
export const SOURCE_DIR = join(PLUGIN_ROOT, 'pets', 'maodie');

/** dsh-pet 读取自定义宠物包的目录：`$DSH_HOME/dsh-pet/pet/<前缀>/`。 */
export function petPackDir(home = dshHome()) {
    return join(home, 'dsh-pet', 'pet', 'maodie');
}

/** DSH 数据目录；与宿主一致，优先读环境变量 `DSH_HOME`。 */
export function dshHome() {
    const fromEnv = process.env.DSH_HOME;
    return fromEnv && fromEnv.trim() ? resolve(fromEnv) : join(homedir(), '.dsh');
}

/** 记录已安装版本的标记文件，放在宠物父目录而不是宠物目录里。 */
export function markerPath(home = dshHome()) {
    return join(home, 'dsh-pet', 'pet', '.maodie-pet.json');
}

/** 本包版本，用于判断是否需要重装。 */
export function packVersion() {
    try {
        return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}

/** 递归列出源目录里的文件（相对路径，统一用 / 分隔）。 */
export function listSourceFiles(dir = SOURCE_DIR) {
    const out = [];
    const walk = (current, prefix) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = join(current, entry.name);
            if (entry.isDirectory())
                walk(full, rel);
            else if (entry.isFile())
                out.push(rel);
        }
    };
    walk(dir, '');
    return out;
}

function readMarker(home) {
    try {
        const raw = JSON.parse(readFileSync(markerPath(home), 'utf8'));
        return raw && typeof raw === 'object' ? raw : null;
    }
    catch {
        return null;
    }
}

function writeMarker(home, version, files) {
    const path = markerPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ name, version, installedAt: new Date().toISOString(), files }, null, 2)}\n`, 'utf8');
}

/**
 * 把素材包复制到 `$DSH_HOME/dsh-pet/pet/maodie`。
 *
 * @param {object} [options]
 * @param {string} [options.home]  DSH 数据目录，默认 `dshHome()`。
 * @param {boolean} [options.force] 覆盖已存在的文件（默认 false，保留用户改动）。
 * @returns {{status: 'installed'|'up-to-date', version: string, target: string, copied: string[], kept: string[]}}
 */
export function installPet({ home = dshHome(), force = false } = {}) {
    if (!existsSync(SOURCE_DIR))
        throw new Error(`素材目录不存在：${SOURCE_DIR}（是不是装了不含 pets/ 的 npm 包？）`);

    const version = packVersion();
    const target = petPackDir(home);
    const files = listSourceFiles(SOURCE_DIR);
    if (files.length === 0)
        throw new Error(`素材目录是空的：${SOURCE_DIR}`);

    const marker = readMarker(home);
    const allPresent = files.every(rel => existsSync(join(target, rel)));
    if (!force && marker?.version === version && allPresent)
        return { status: 'up-to-date', version, target, copied: [], kept: files };

    const copied = [];
    const kept = [];
    for (const rel of files) {
        const dest = join(target, rel);
        mkdirSync(dirname(dest), { recursive: true });
        if (!force && existsSync(dest)) {
            kept.push(rel);
            continue;
        }
        copyFileSync(join(SOURCE_DIR, rel), dest);
        copied.push(rel);
    }
    writeMarker(home, version, files);
    return { status: 'installed', version, target, copied, kept };
}

/** Cordis 入口：加载时安装素材。失败只记录日志，不让插件加载整体失败。 */
export function apply(ctx) {
    const logger = ctx?.logger;
    const info = message => (typeof logger?.info === 'function' ? logger.info(message) : console.log(message));
    const warn = message => (typeof logger?.warn === 'function' ? logger.warn(message) : console.warn(message));
    try {
        const result = installPet();
        info(result.status === 'up-to-date'
            ? `[maodie-pet] 素材已是最新（v${result.version}）：${result.target}`
            : `[maodie-pet] 已安装 v${result.version} 到 ${result.target}（新增 ${result.copied.length} 个文件，保留 ${result.kept.length} 个）`);
    }
    catch (error) {
        warn(`[maodie-pet] 素材安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 直接运行：`node lib/index.js --install [--home <dir>] [--force]`。 */
function main(argv) {
    const install = argv.includes('--install');
    if (!install) {
        console.log('用法：node lib/index.js --install [--home <DSH_HOME>] [--force]');
        return;
    }
    const homeIndex = argv.indexOf('--home');
    const home = homeIndex >= 0 && argv[homeIndex + 1] ? resolve(argv[homeIndex + 1]) : dshHome();
    const result = installPet({ home, force: argv.includes('--force') });
    console.log(JSON.stringify({ ...result, copied: result.copied.length, kept: result.kept.length }, null, 2));
    if (result.status === 'installed')
        console.log('完成：刷新 DSH 页面（或右键宠物 → 重载配置）即可看到橘猫。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main(process.argv.slice(2));


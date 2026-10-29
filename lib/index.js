/**
 * maodie-pet —— 宿主半侧（安装器）。
 *
 * 仓库的主要内容是桌宠素材（`pets/maodie/`：`maodie-config.json` + 三十多个
 * VP9-alpha webm）。装插件就应该等于装素材，所以由这个入口把它们落到
 * `$DSH_HOME/dsh-pet/pet/maodie/`。
 *
 * ## 更新策略（v0.2 起）
 *
 * 旧版只补缺失文件，导致「素材有新版也拉不下来、已装用户永远停在第一版」。
 * 现在按 sha256 判断每个文件该不该覆盖：
 *
 * | 磁盘上的文件 | 判定 | 升级时 |
 * | --- | --- | --- |
 * | 与上次安装的快照一致（= 原样） | `pristine` | **覆盖成新版** |
 * | 与快照不同（用户替换/改过） | `user-modified` | 保留，记进 `skipped` |
 * | 没有快照但和包里这一版 hash 相同（老用户） | `pristine` | 覆盖 |
 * | 没有快照且和包不同（老用户换过的文件） | `unknown` | 保留，记进 `skipped` |
 * | 上次装过、现在没了 | `user-deleted` | 默认不复活；`--restore` 才补 |
 *
 * config 单独走三方合并（见 `lib/merge.mjs`）：ours = 磁盘现状，base = 上次合并结果，
 * theirs = 新版。新增动作追加进池子与分类、保留用户自己加的动作与分类、
 * 用户调过的排列/权重原样保留、`animations` 以外的字段一概不动。
 *
 * 第一次在旧版之上升级时没有 base（旧版没写过清单），这时退化成「保守模式」：
 * 只在 ours 里补 theirs 有而 ours 没有的动作名，绝不删、不改用户已有的东西。
 *
 * 被覆盖/被替换/被移除的文件先备份到 `$DSH_HOME/dsh-pet/pet/.maodie-pet-backup/<时间戳>/`，
 * `--rollback` 可以一键还原上一次升级。
 *
 * 其它保证：
 * - 幂等：版本与所有文件的 hash 都对齐时直接返回 `up-to-date`，不写盘；
 * - 可测试：`installPet()` 只依赖参数里的路径，导入本模块没有副作用；
 * - **绝不用 `fs.cpSync`**：本机实测在递归复制含中文文件名的 webm 时会把 Node 进程
 *   直接打死（退出码 3221226505 / 0xC0000409，异常代码 0xC0000409 + 0xC0000005），
 *   所以复制一律走 `copyFileSync` 自己遍历；
 * - 动作名 = 素材文件名（dsh-pet 就是这么找的），config 里引用了但不存在的动作
 *   会被跳过并在 `warnings` 里点名，不会写进配置造成"找不到素材"。
 */
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ANIM_DIR,
    ANIM_EXTS,
    CONFIG_NAME,
    actionNameFromFile,
    collectActionNames,
} from './pet-schema.mjs';
import {
    MANIFEST_NAME,
    STATE_NAME,
    fileVerdict,
    hashFile,
    normalizeFiles,
    readJson,
    readState,
    sha256,
} from './manifest.mjs';
import { POOL_KEYS } from './pet-schema.mjs';
import { configSnapshot, jsonEquals, mergeAnimations, mergeConfig } from './merge.mjs';

export { mergeConfig, mergeAnimations, configSnapshot } from './merge.mjs';
export { collectActionNames, actionNameFromFile } from './pet-schema.mjs';

/** Cordis 插件名，与 cordis.patch.yml 里的 `id` 一致。 */
export const name = 'maodie-pet';

/** 本包根目录（lib/ 的上一级）。 */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 素材源目录。 */
export const SOURCE_DIR = join(PLUGIN_ROOT, 'pets', 'maodie');

/** 宠物条目名（= pet/<前缀>-config.json 的前缀）。 */
export const PET_ID = 'maodie';

/** 备份目录名（放在 `pet/` 下，不放进宠物目录，免得被当成素材）。 */
export const BACKUP_DIR_NAME = '.maodie-pet-backup';

/** dsh-pet 读取自定义宠物包的目录：`$DSH_HOME/dsh-pet/pet/<前缀>/`。 */
export function petPackDir(home = dshHome()) {
    return join(home, 'dsh-pet', 'pet', PET_ID);
}

/** 宠物包父目录（`$DSH_HOME/dsh-pet/pet`）。 */
export function petRootDir(home = dshHome()) {
    return join(home, 'dsh-pet', 'pet');
}

/** DSH 数据目录；与宿主一致，优先读环境变量 `DSH_HOME`。 */
export function dshHome() {
    const fromEnv = process.env.DSH_HOME;
    return fromEnv && fromEnv.trim() ? resolve(fromEnv) : join(homedir(), '.dsh');
}

/** 安装清单（版本 + 文件快照 + 合并基线）。 */
export function statePath(home = dshHome()) {
    const path = join(petRootDir(home), STATE_NAME);
    return path;
}

/** 旧版用的标记文件路径，仅为兼容读取。 */
export function markerPath(home = dshHome()) {
    return join(petRootDir(home), `.${PET_ID}-pet.json`);
}

/** 备份根目录。 */
export function backupRoot(home = dshHome()) {
    return join(petRootDir(home), BACKUP_DIR_NAME);
}

/** 本包版本。 */
export function packVersion() {
    return readJson(join(PLUGIN_ROOT, 'package.json'))?.version ?? '0.0.0';
}

/** 素材源目录的清单（包里发布的那份）。 */
export function readPackManifest(sourceDir = SOURCE_DIR) {
    const raw = readJson(join(sourceDir, MANIFEST_NAME));
    return raw ? { version: raw.version ?? '0.0.0', files: normalizeFiles(raw.files) } : null;
}

/** 递归列出源目录里的文件（相对路径，统一用 / 分隔；跳过包清单本身）。 */
export function listSourceFiles(dir = SOURCE_DIR) {
    const out = [];
    const walk = (current, prefix) => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            throw new Error(`素材目录不存在：${current}（是不是装了不含 pets/ 的 npm 包？）`);
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (rel === MANIFEST_NAME && !prefix)
                continue;
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

/** 从源目录的一批文件里算出动作名集合。 */
function actionNamesFrom(files) {
    const names = new Set();
    for (const rel of files) {
        if (!rel.startsWith(`${ANIM_DIR}/`))
            continue;
        const file = rel.slice(ANIM_DIR.length + 1);
        if (file.includes('/'))
            continue;
        if (ANIM_EXTS.some(ext => file.toLowerCase().endsWith(ext)))
            names.add(actionNameFromFile(file));
    }
    return names;
}

/** 磁盘上宠物包里已经存在的动作名。 */
function installedActionNames(target) {
    const dir = join(target, ANIM_DIR);
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return new Set();
    }
    const names = new Set();
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        if (ANIM_EXTS.some(ext => entry.name.toLowerCase().endsWith(ext)))
            names.add(actionNameFromFile(entry.name));
    }
    return names;
}

/** 写安装清单。 */
function writeState(file, state) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 把 config 里引用、但磁盘上没有素材的动作剔掉，并回报。 */
function pruneMissingActions(config, available) {
    const warnings = [];
    // 注意先拷贝再改：animations 可能直接指向 nextConfig，就地写会污染调用方的对象
    const animations = config?.animations ? { ...config.animations } : undefined;
    if (animations)
        config = { ...config, animations };
    if (!animations || typeof animations !== 'object')
        return { config, warnings };
    const keep = (list) => {
        if (!Array.isArray(list))
            return list;
        const filtered = [];
        for (const item of list) {
            if (typeof item === 'string' && !available.has(item)) {
                warnings.push(`动作「${item}」没有对应素材，已从配置里跳过`);
                continue;
            }
            filtered.push(item);
        }
        return filtered;
    };
    for (const key of POOL_KEYS) {
        if (key in animations)
            animations[key] = keep(animations[key]);
    }
    if (Array.isArray(animations.categories)) {
        for (const category of animations.categories) {
            if (Array.isArray(category.actions))
                category.actions = keep(category.actions);
        }
    }    if (Array.isArray(animations.moves?.actions)) {
        for (const action of animations.moves.actions) {
            if (action && typeof action === 'object' && typeof action.name === 'string' && !available.has(action.name))
                warnings.push(`移动动作「${action.name}」没有对应素材，已保留但可能不可用`);
        }
    }
    return { config, warnings };
}

/**
 * 判断 config 里是否还引用着某动作名。
 */
function referencedActions(config) {
    return new Set(collectActionNames(config));
}

/**
 * 按包内 config 的键顺序重排合并结果。
 *
 * 写进 state 的基线必须与"刚写下去的 config"逐字等价——否则下一轮 ours 是从磁盘
 * 读回来的（键顺序 = 本次写盘顺序），与基线键顺序不同就会被判成"用户改动"，
 * 于是每次都重写 config、幂等失效。这里让写盘那份与基线同源同序。
 */
/**
 * config 的"可比摘要"：磁盘上真正存在的部分（动作池 + 分类 + pets），
 * 不含安装器记账用的 absent。
 */
function comparableSnapshot(config) {
    const snapshot = configSnapshot(config);
    if (Array.isArray(config?.absent))
        snapshot.absent = config.absent.slice();
    return snapshot;
}

/**
 * 反向：去掉基线里磁盘 config 不会有的账本字段（absent），得到"磁盘应与之相等的摘要"。
 * 比对时两边都必须是同一形状，否则 absens/absent 这类记账差异会被当成内容变化。
 */
function diskShape(baseline) {
    if (!baseline || typeof baseline !== 'object')
        return baseline;
    const { absent, ...rest } = baseline;
    return rest;
}

/**
 * 把 config 渲染成将要写盘的文本。比较"要不要写"和真正写盘必须共用这一个函数，
 * 否则口径一宽就会每轮都重写一遍：
 * - 换行风格跟原文件（仓库里的 config 是 CRLF，一律写 LF 会让内容没变也字节全变）；
 * - 结尾换行也跟原文件（包里的 config 不带末尾换行，凭空补一个同样算是改动）。
 */
function renderConfig(value, previousText) {
    const eol = typeof previousText === 'string' && previousText.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\r?\n$/.test(previousText ?? '') ? '\n' : '';
    return `${JSON.stringify(value, null, 2)}${trailing}`.replace(/\n/g, eol);
}

function reorderLikeTheirs(theirs, merged) {
    const walk = (template, value) => {
        if (Array.isArray(value))
            return value.map(item => (item && typeof item === 'object' ? walk(template, item) : item));
        if (!value || typeof value !== 'object')
            return value;
        const out = {};
        const templateObject = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
        for (const key of Object.keys(templateObject)) {
            if (key in value)
                out[key] = walk(templateObject[key], value[key]);
        }
        for (const key of Object.keys(value)) {
            if (!(key in out))
                out[key] = walk(undefined, value[key]);
        }
        return out;
    };
    return walk(theirs, merged);
}

/**
 * 把 state 里的摘要基线（pools/categories）还原成可供三方合并的完整 config 形状。
 * 非动作字段取包里的值（它们不参与合并，合并时一律保留 ours）。
 */
function fromBaseline(baseline, theirs, ours) {
    const animations = { ...(theirs?.animations ?? {}) };
    const ourAnimations = ours?.animations && typeof ours.animations === 'object' ? ours.animations : {};
    for (const [key, value] of Object.entries(baseline?.pools ?? {}))
        animations[key] = Array.isArray(value) ? [...value] : [];
    // 磁盘上真实存在的池子必须进 base：base 是"上次写下去的样子"，漏掉一个池子，
    // 合并时就会把用户这个池子里原有的动作当成"包新增"来增删。
    for (const key of POOL_KEYS) {
        if (key in ourAnimations && !(key in (baseline?.pools ?? {})))
            animations[key] = Array.isArray(ourAnimations[key]) ? [...ourAnimations[key]] : [];
    }
    const categories = (baseline?.categories ?? []).map(item => {
        const template = (theirs?.animations?.categories ?? []).find(category => category?.id === item?.id)
            ?? (ours?.animations?.categories ?? []).find(category => category?.id === item?.id);
        return { ...(template && typeof template === 'object' ? template : {}), id: item?.id, actions: [...(item?.actions ?? [])] };
    });
    // 基线里有、但这一版包里已经没有的分类：照样带进 base，否则 mergeAnimations 会把它当成
    // "用户新增的分类"（而且是个空分类）塞回结果里。
    for (const category of baseline?.categories ?? []) {
        if (categories.some(item => item.id === category.id))
            continue;
        const template = (ours?.animations?.categories ?? []).find(item => item?.id === category.id);
        categories.push({ ...(template && typeof template === 'object' ? template : {}), id: category.id, actions: [...(category.actions ?? [])] });
    }
    animations.categories = categories;
    // 模板来自包内 config，里面的空动作池（turn/drag 之类）根本不是用户写的；
    // 带进 base 后合并会把它当成"用户新增的空池"塞到磁盘 config 里，下一轮就成了变化。
    for (const key of POOL_KEYS) {
        if (key in animations && baseline?.pools && key in baseline.pools)
            continue;
        const inOurs = Boolean(ours && ourAnimations && key in ourAnimations);
        if (!inOurs)
            delete animations[key];
    }
    return { ...(theirs ?? {}), animations };
}

/**
 * 保证 config 里的 pets[] 认得这只猫：合并逻辑对 pets 是"用户没动过就采用包里的版本"，
 * 用户手写的极简 config（只有 animations）会让 pets 缺失，dsh-pet 就认不出角色。
 */
function normalizePets(config, ours, theirs) {
    if (!config || !Array.isArray(theirs?.pets) || theirs.pets.length === 0)
        return config;
    const ids = new Set(theirs.pets.map(item => item?.id).filter(Boolean));
    const extra = (Array.isArray(config.pets) ? config.pets : []).filter(item => item?.id && !ids.has(item.id));
    return { ...config, pets: [...theirs.pets, ...extra] };
}

/** 基线里记着"这一版包里本来有、但上次没装上"的动作，与这一版包内动作对比后重新放回可用集合。 */
function restoreAbsent(available, baseline, packActions) {
    for (const action of baseline?.absent ?? []) {
        if (typeof action === 'string' && packActions.has(action))
            available.add(action);
    }
    return available;
}

/**
 * 生成下次升级用的基线，规则是"让用户真正做过的事显得像改动，其余一律原样"：
 * - 池子里、分类里的动作取合并结果（新动作因此被认作"随包带进来的"，不会在下一轮被当成用户新增而删掉）；
 * - 包里有、但那一轮没装上的新动作（素材缺失被过滤掉），记进 `absent`——
 *   下一轮素材补齐时要能重新加进去，否则就永久丢了。
 */
function baselineOf(theirs, mergedConfig, { dropped = [] } = {}) {
    const snapshot = configSnapshot(mergedConfig);
    // 用户的 config 里可能没有 pets[]（包里也不一定有），这时不记 pets，免得凭空造出"包里的 pets"
    const snapshotPets = Array.isArray(mergedConfig?.pets) ? mergedConfig.pets.map(item => item?.id).filter(Boolean) : [];
    const pets = snapshotPets.length > 0 ? snapshotPets : undefined;
    // 基线要与"磁盘上真实存在的那份 config"同形：磁盘上没有的池子（比如包模板里有、
    // 用户文件里从未出现过的 turn/drag）不能在基线里记成一格空数组，
    // 否则下一轮 appendNew 会以此为底，把用户自己加在这个池子里的动作当成"包新增"删掉。
    const pools = {};
    const livePools = mergedConfig?.animations && typeof mergedConfig.animations === 'object' ? mergedConfig.animations : {};
    for (const [key, value] of Object.entries(snapshot.pools)) {
        if (key in livePools)
            pools[key] = value;
    }
    const present = new Set([...Object.values(pools).flat(), ...snapshot.categories.flatMap(item => item.actions)]);
    const absent = dropped.filter(action => typeof action === 'string' && !present.has(action));
    return { ...snapshot, pools, pets, absent };
}

/**
 * 安装 / 升级素材包。
 *
 * @param {object} [options]
 * @param {string} [options.home]      DSH 数据目录，默认 `dshHome()`。
 * @param {boolean} [options.force]    所有文件按包版本强制覆盖（含用户改过的）。
 * @param {boolean} [options.restore]  把用户删掉的素材补回来（默认不复活）。
 * @param {boolean} [options.prune]    删掉包新版本已移除的素材文件（默认保留）。
 * @param {boolean} [options.dryRun]   只算结果不写盘。
 * @param {string} [options.sourceDir] 素材源目录（测试用），默认包内 `pets/maodie`。
 * @param {string} [options.now]       时间戳字符串（测试用）。
 * @returns {{
 *   status: 'installed'|'updated'|'up-to-date',
 *   version: string, previousVersion?: string, target: string, mode: 'fresh'|'upgrade'|'conservative'|'force',
 *   copied: string[], updated: string[], kept: string[], skipped: string[],
 *   removed: string[], restored: string[],
 *   config: { written: boolean, added: string[], removed: string[], addedCategories: string[] },
 *   backupDir?: string, warnings: string[],
 * }}
 */
export function installPet({
    home = dshHome(),
    force = false,
    restore = false,
    prune = false,
    dryRun = false,
    sourceDir = SOURCE_DIR,
    now = timestamp(),
} = {}) {
    const source = resolve(sourceDir);
    const version = packVersion();
    const manifest = readPackManifest(source);
    const files = listSourceFiles(source);
    if (files.length === 0)
        throw new Error(`素材目录是空的：${source}（是不是装了不含 pets/ 的 npm 包？）`);

    const target = petPackDir(home);
    const stateFile = statePath(home);
    const state = readState(stateFile);
    const previousVersion = state?.version;

    // 源文件 hash：优先用包清单，缺失/过期的现场补算
    const sourceHash = (rel) => {
        const recorded = manifest?.files?.[rel]?.sha256;
        if (recorded)
            return recorded;
        return hashFile(join(source, rel));
    };

    const snapshot = state?.files ?? {};
    const owned = new Set(state?.owned ?? []);
    const packActions = actionNamesFrom(files);
    const diskActions = installedActionNames(target);

    // 有 state 文件但没有素材清单 = 旧版装的（或清单被删了）→ 保守模式：只追加，不删不改。
    // 完全没有 state 又没有任何已装内容才算首次安装（fresh）。
    const fileState = Boolean(state) || existsSync(stateFile) || installedActionNames(target).size > 0;
    const mode = force ? 'force' : !fileState ? 'fresh' : Object.keys(snapshot).length === 0 ? 'conservative' : 'upgrade';
    const plan = {
        copy: [],
        overwrite: [],
        skip: [],
        restore: [],
        remove: [],
    };

    for (const rel of files) {
        const dest = join(target, rel);
        const diskSha = hashFile(dest);
        const verdict = fileVerdict({
            diskSha,
            snapshotSha: snapshot[rel]?.sha256,
            packSha: sourceHash(rel),
            previouslyOwned: owned.has(rel),
        });

        if (force) {
            if (diskSha === undefined)
                plan.copy.push(rel);
            else
                plan.overwrite.push(rel);
            continue;
        }

        switch (verdict) {
            case 'absent':
                plan.copy.push(rel);
                break;
            case 'user-deleted':
                if (restore || !owned.has(rel))
                    plan.copy.push(rel);
                else
                    plan.skip.push(rel);
                break;
            case 'pristine':
                if (diskSha !== sourceHash(rel))
                    plan.overwrite.push(rel);
                break;
            case 'user-modified':
            case 'unknown':
            default:
                plan.skip.push(rel);
                break;
        }
    }

    // 包新版本里已经没有、但上次是安装器写下去的文件
    const sourceSet = new Set(files);
    for (const rel of owned) {
        if (sourceSet.has(rel))
            continue;
        if (rel === CONFIG_NAME)
            continue; // config 由三方合并处理，不当成素材
        if (!existsSync(join(target, rel)))
            continue;
        const diskSha = hashFile(join(target, rel));
        const snapshotSha = snapshot[rel]?.sha256;
        if (prune && (snapshotSha === undefined || diskSha === snapshotSha))
            plan.remove.push(rel);
        else
            plan.skip.push(rel);
    }

    // ---- config 合并 ----
    const warnings = [];
    const configFile = join(target, CONFIG_NAME);
    // 包内 config 的原文：首次安装时磁盘上还没有文件，换行风格跟它走。
    const sourceConfigText = existsSync(join(source, CONFIG_NAME)) ? readFileSync(join(source, CONFIG_NAME), 'utf8') : undefined;
    const theirs = readJson(join(source, CONFIG_NAME));
    let ours = readJson(configFile);
    // 安装器能保证素材存在的动作 = 包里这一版 + 磁盘上原有 + 这一轮会拷进去的新文件
    // （plan.copy/pending 里是还没落盘的文件，磁盘动作集里没有它们）
    const diskActionsAfterInstall = new Set([...packActions, ...diskActions]);
    for (const rel of plan.copy) {
        const file = rel.startsWith(`${ANIM_DIR}/`) ? rel.slice(ANIM_DIR.length + 1) : '';
        if (file && !file.includes('/'))
            diskActionsAfterInstall.add(actionNameFromFile(file));
    }
    for (const rel of [...(plan.copy ?? []), ...(plan.pending ?? [])]) {
        const file = rel.startsWith(`${ANIM_DIR}/`) ? rel.slice(ANIM_DIR.length + 1) : '';
        if (file && !file.includes('/'))
            diskActionsAfterInstall.add(actionNameFromFile(file));
    }
    for (const rel of plan.remove) {
        const file = rel.startsWith(`${ANIM_DIR}/`) ? rel.slice(ANIM_DIR.length + 1) : '';
        if (file && !file.includes('/'))
            diskActionsAfterInstall.delete(actionNameFromFile(file));
    }
    for (const rel of plan.overwrite) {
        const file = rel.startsWith(`${ANIM_DIR}/`) ? rel.slice(ANIM_DIR.length + 1) : '';
        if (file && !file.includes('/'))
            diskActionsAfterInstall.add(actionNameFromFile(file));
    }
    let configPlan = { written: false, added: [], removed: [], addedCategories: [] };
    let nextConfig = ours;
    let droppedActions = [];
    // 基线（state.mergedConfig）是 configSnapshot 的"摘要"形状（pools/categories），
    // 而 ours 是完整 config，两者结构完全不同；必须先把磁盘上的 config 也摘成同形状再比，
    // 否则每轮都会把用户没动过的 config 判成"用户改动" → 反复重写、幂等失效。
    const oursBaseline = ours ? configSnapshot(ours) : undefined;
    let baseForState = state?.mergedConfig ? configSnapshot(state.mergedConfig) : undefined;
    // 素材缺失的判定要连"基线里记着、这一版包里本来就有"的动作一起放开，
    // 否则上一轮因缺素材被过滤掉的动作永远加不回来。
    const availableAfterInstall = restoreAbsent(new Set(diskActionsAfterInstall), state?.mergedConfig, packActions);

    // 保守模式：没有基线，只追加新动作，不删、不动用户顺序
    if (theirs) {
        if (ours && !state?.mergedConfig) {
            // 旧版升级上来：没有基线，只做保守追加（不删、不动用户顺序）
            const conservative = mergeAnimations(ours.animations, theirs.animations, undefined, { appendById: true });
            nextConfig = { ...ours, animations: conservative.animations };
            const oursActions = new Set(collectActionNames(ours));
            const added = [...packActions].filter(action => !oursActions.has(action));
            configPlan = { written: added.length > 0, added, removed: [], addedCategories: [] };
        }
        else if (!ours) {
            nextConfig = theirs;
            configPlan = {
                written: true,
                added: collectActionNames(theirs),
                removed: [],
                addedCategories: (theirs.animations?.categories ?? []).map(item => item?.id).filter(Boolean),
            };
        }
        else if (state?.mergedConfig) {
            // 摘要形状的基线要先还原成完整 config 才能做三方合并
            const baseConfig = fromBaseline(state.mergedConfig, theirs, ours);
            // 真正退役 = 基线里出现过、这一版包的任何地方都不再带着（素材与配置都算），
            // 并且用户自己的 config 里也**没有**它、素材也不在磁盘上——
            // 不然用户新加进 idle 的动作会被"上一轮基线里还没有它"误判成退役又删掉。
            // 只在基线有动作时启用，老用户（无基线）一律不删。
            const baseActions = new Set(collectActionNames(baseConfig));
            const packActionSet = new Set(collectActionNames(theirs));
            const ourActionSet = new Set(collectActionNames(ours));
            const retiredNames = baseActions.size > 0
                ? new Set([...baseActions].filter(action => !packActionSet.has(action) && !ourActionSet.has(action) && !diskActionsAfterInstall.has(action)))
                : new Set();
            const merged = mergeConfig(ours, theirs, baseConfig, { available: availableAfterInstall, retiredNames });
            // 合并结果以磁盘 config 为底：合并逻辑会把包里但磁盘上原不存在的空池补出来，
            // 那是包内模板的形状，不该被写进用户文件（否则每次安装都多出一份"变化"）。
            const mergedAnimations = merged.config.animations ?? {};
            const ourAnimations = ours.animations && typeof ours.animations === 'object' ? ours.animations : {};
            for (const key of POOL_KEYS) {
                if (key in ourAnimations || !(key in mergedAnimations))
                    continue;
                if (Array.isArray(mergedAnimations[key]) && mergedAnimations[key].length === 0)
                    delete mergedAnimations[key];
            }
            nextConfig = { ...merged.config, animations: { ...ourAnimations, ...mergedAnimations } };
            configPlan = {
                written: false,
                added: merged.added,
                removed: merged.removed,
                addedCategories: merged.addedCategories,
            };
            droppedActions = merged.dropped ?? [];
        }

        // 只保留磁盘上真有素材的动作
        const pruned = pruneMissingActions(nextConfig, availableAfterInstall);
        nextConfig = pruned.config;
        nextConfig = normalizePets(nextConfig, ours, theirs);
        // 基线必须"如实反映这次写下去的那份 config"，否则下一轮会把用户没动过的键
        // 当成用户改动，幂等就断了。缺口（缺素材没装上的动作）也记进去，补上时能自动回来。
        baseForState = baselineOf(theirs, reorderLikeTheirs(ours, nextConfig), { dropped: droppedActions });
        warnings.push(...pruned.warnings);
    }

    // 磁盘上的 config 必须保持用户/安装器写下的样子。三方合并会按包内模板重建对象，
    // 把键顺序统一成包里顺序；那属于"格式变了、内容没变"，不该落盘（否则每次安装都重写一遍）。
    nextConfig = reorderLikeTheirs(ours, nextConfig);

    // 写盘判定只看"渲染出来的文本和磁盘上的是否逐字相同"：文本才是一切的最终形态，
    // 摘要比较看不出换行、结尾换行、键顺序这些同样会让文件变样的地方。
    // 例外：磁盘上还没有 config（首次安装），或这次必须重建基线（老版本升级上来，state 里没有基线）。
    if (theirs && nextConfig) {
        const currentText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : undefined;
        const nextText = renderConfig(nextConfig, currentText ?? sourceConfigText);
        const textChanged = currentText === undefined || nextText !== currentText;
        const needsBaseline = !ours || !state?.mergedConfig;
        configPlan = { ...configPlan, written: textChanged || needsBaseline };
    }

    const needConfigWrite = Boolean(theirs) && configPlan.written;
    // config 是用户的东西，不进 owned、也不参与"素材文件"的判定；但它的内容变了（新动作进配置）
    // 就必须落盘，否则要白白多跑一轮。这里把它显式挂进 plan，落盘与结果里都能看到。
    if (needConfigWrite && existsSync(configFile) && !plan.overwrite.includes(CONFIG_NAME))
        plan.overwrite.push(CONFIG_NAME);
    const changedTotal = plan.copy.length + plan.overwrite.length + plan.remove.length + plan.restore.length;
    // 清单里的 sha 快照是否已经跟上包：升级后第一次跑时，用户没动过的文件会从旧 sha 更新到包 sha，
    // 这不算"改文件"，但 state 必须重写，否则下一次又会判成 updated。
    const snapshotStale = files.some(rel => rel !== CONFIG_NAME && snapshot[rel]?.sha256 !== sourceHash(rel))
        || Object.keys(snapshot).some(rel => rel !== CONFIG_NAME && !files.includes(rel) && owned.has(rel) && existsSync(join(target, rel)));
    const alreadyInstalled = previousVersion === version
        && changedTotal === 0
        && !needConfigWrite
        && !snapshotStale
        && files.every(rel => hashFile(join(target, rel)) !== undefined);

    if (alreadyInstalled) {
        // 这条捷径只跳过"写盘"，但 state 里的基线仍要对齐到本次合并结果：
        // 否则 config 落盘与基线重建永远差一步，下一次安装会把同一件事再做一遍。
        if (state?.mergedConfig && nextConfig && !dryRun) {
            const baseline = baselineOf(theirs, reorderLikeTheirs(ours, nextConfig), {
                dropped: configPlan?.dropped ?? [],
            });
            writeState(stateFile, { ...state, mergedConfig: baseline });
        }
        return {
            status: 'up-to-date',
            version,
            previousVersion,
            target,
            mode,
            copied: [],
            updated: [],
            kept: files,
            skipped: plan.skip,
            removed: [],
            restored: [],
            config: { written: false, added: [], removed: [], addedCategories: [] },
            warnings,
        };
    }

    const result = {
        status: previousVersion || existsSync(target) ? 'updated' : 'installed',
        version,
        previousVersion,
        target,
        mode,
        copied: plan.copy,
        updated: plan.overwrite,
        kept: [],
        skipped: plan.skip,
        removed: plan.remove,
        restored: plan.restore,
        config: configPlan,
        warnings,
    };

    if (dryRun)
        return { ...result, status: 'dry-run', dryRun: true };

    // ---- 落盘 ----
    const backupDir = join(backupRoot(home), now);
    let backedUp = false;
    const backup = (rel) => {
        const src = join(target, rel);
        if (!existsSync(src))
            return;
        const dest = join(backupDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        backedUp = true;
    };

    for (const rel of [...plan.overwrite, ...plan.remove])
        backup(rel);
    if (needConfigWrite && existsSync(configFile))
        backup(CONFIG_NAME);

    const nextFiles = { ...snapshot };
    const nextOwned = new Set(owned);

    // config 不进 owned；它的 hash 在最后统一按磁盘现状记账（首次安装时文件还不存在，
    // 这里先算会导致快照记成"没有 config"，下一轮就永远判成 updated）。

    for (const rel of [...plan.copy, ...plan.restore, ...plan.overwrite]) {
        if (rel === CONFIG_NAME)
            continue; // config 由下面的三方合并结果写入，不能拿包里的模板覆盖用户的
        const dest = join(target, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(source, rel), dest);
        nextFiles[rel] = { sha256: sourceHash(rel) };
        nextOwned.add(rel);
    }

    for (const rel of plan.remove) {
        // 不直接删除：本机实测"删除含中文名（非 ASCII）的文件"会让宿主进程直接死掉
        // （退出码 0xC0000409，没有任何 JS 异常可捕获）。改用 renameSync 挪进本轮备份目录，
        // 观感上等同"从动作目录消失"，而且还能用 --rollback 还原。
        const src = join(target, rel);
        if (existsSync(src)) {
            const dest = join(backupDir, rel);
            mkdirSync(dirname(dest), { recursive: true });
            try {
                renameSync(src, dest);
                backedUp = true;
            } catch (error) {
                result.warnings.push(`无法移除 ${rel}（${error?.code ?? error}），已保留`);
                continue;
            }
        }
        delete nextFiles[rel];
        nextOwned.delete(rel);
    }

    // 用户改过/删掉的文件：快照如实记成磁盘现状，下次升级就能按"用户的东西"对待
    for (const rel of plan.skip) {
        const diskSha = hashFile(join(target, rel));
        if (diskSha === undefined)
            delete nextFiles[rel];
        else
            nextFiles[rel] = { sha256: diskSha, userModified: diskSha !== sourceHash(rel) || undefined };
    }

    // 其余"包里已有、版本也一致"的文件：把快照里的旧 sha 对齐到包（文件本身没动过，只是记账）
    for (const rel of files) {
        if (rel === CONFIG_NAME)
            continue;
        if (nextFiles[rel]?.userModified)
            continue;
        if (nextFiles[rel]?.sha256 === sourceHash(rel))
            continue;
        nextFiles[rel] = { sha256: sourceHash(rel) };
        nextOwned.add(rel);
    }

    // 写 config 时沿用原文件的换行风格（见 renderConfig）：仓库里的 config 是 CRLF，
    // 一律写 LF 会让"内容没变"的安装每次都重写一遍，幂等和 diff 都会被搅乱。
    const writeConfig = (value) => {
        const previous = existsSync(configFile) ? readFileSync(configFile, 'utf8') : sourceConfigText;
        const text = renderConfig(value, previous);
        mkdirSync(dirname(configFile), { recursive: true });
        writeFileSync(configFile, text, 'utf8');
    };

    if (needConfigWrite && nextConfig) {
        if (existsSync(configFile)) {
            const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
            // 用户 config 里引用了不存在的动作 → 同样写进 warnings
            const available = diskActionsAfterInstall;
            for (const action of collectActionNames(parsed)) {
                if (available.has(action))
                    continue;
                if (plan.remove.some(rel => rel === `${ANIM_DIR}/${action}.webm` || rel === `${ANIM_DIR}/${action}.mov`))
                    continue;
                warnings.push(`配置引用的动作「${action}」在素材目录里找不到（已保留原样，补上素材即可恢复）`);
            }
        }
        writeConfig(nextConfig);
        result.config.written = true;
    }
    else if (!existsSync(configFile) && theirs) {
        writeConfig(theirs);
        result.config.written = true;
    }

    if (existsSync(configFile))
        nextFiles[CONFIG_NAME] = { sha256: hashFile(configFile) };
    else
        delete nextFiles[CONFIG_NAME];
    writeState(stateFile, {
        name,
        version,
        installedAt: state?.installedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files: Object.fromEntries(Object.entries(nextFiles).map(([rel, info]) => [rel, info?.userModified ? { sha256: info.sha256, userModified: true } : { sha256: info?.sha256 }])),
        owned: [...nextOwned].sort(),
        mergedConfig: baseForState,
    });

    if (backedUp)
        result.backupDir = backupDir;

    result.kept = files.filter(rel => !result.copied.includes(rel) && !result.updated.includes(rel));
    // config 重新渲染后逐字与磁盘相同的，不算"改过"——否则"没变"的安装也会长期报 updated、
    // 并且在结果里列一个其实没动的 maodie-config.json。素材有更新时保留它（那一轮确实动过配置）。
    if (!configPlan.written && result.updated.includes(CONFIG_NAME) && !result.copied.length && !result.removed.length && !result.restored.length) {
        result.updated = result.updated.filter(rel => rel !== CONFIG_NAME);
        if (!dryRun)
            result.config = { ...result.config, written: false };
    }
    // 只有文件真的换过才算"更新"；仅仅重建清单 / 对齐基线属于内部记账，对外仍报 up-to-date
    if (result.status === 'updated' && result.updated.length === 0 && !result.copied.length && !result.removed.length && !result.restored.length && !result.config.written)
        result.status = 'up-to-date';
    return result;
}

/**
 * 回滚到指定备份目录（默认最近一次）。
 * @param {{home?: string, backupDir?: string}} [options]
 */
export function rollbackPet({ home = dshHome(), backupDir } = {}) {
    const root = backupRoot(home);
    let dir = backupDir;
    if (!dir) {
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
        }
        catch {
            throw new Error(`没有可回滚的备份：${root}`);
        }
        if (entries.length === 0)
            throw new Error(`没有可回滚的备份：${root}`);
        dir = join(root, entries[entries.length - 1]);
    }
    if (!existsSync(dir))
        throw new Error(`备份目录不存在：${dir}`);

    const target = petPackDir(home);
    const restored = [];
    const walk = (current, prefix) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full, rel);
                continue;
            }
            const dest = join(target, rel);
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(full, dest);
            restored.push(rel);
        }
    };
    walk(dir, '');

    // 回滚后旧的合并基线不再成立，清掉以便下次走保守模式重新吸收
    const stateFile = statePath(home);
    const state = readState(stateFile);
    if (state) {
        const files = {};
        for (const rel of Object.keys(state.files)) {
            const diskSha = hashFile(join(target, rel));
            if (diskSha !== undefined)
                files[rel] = { sha256: diskSha };
        }
        writeState(stateFile, { ...state, files, mergedConfig: undefined, updatedAt: new Date().toISOString() });
    }
    return { restored, backupDir: dir };
}

/** Cordis 入口：加载时安装/升级素材。失败只记日志，不让插件加载整体失败。 */
export function apply(ctx) {
    const logger = ctx?.logger;
    const info = message => (typeof logger?.info === 'function' ? logger.info(message) : console.log(message));
    const warn = message => (typeof logger?.warn === 'function' ? logger.warn(message) : console.warn(message));
    try {
        const result = installPet();
        if (result.status === 'up-to-date') {
            info(`[maodie-pet] 素材已是最新（v${result.version}）：${result.target}`);
        }
        else {
            info(`[maodie-pet] ${result.status === 'installed' ? '已安装' : '已升级'} v${result.previousVersion ?? '-'} → v${result.version}：${result.target}`);
            info(`[maodie-pet] 新增 ${result.copied.length + result.restored.length} 个素材，更新 ${result.updated.length} 个，保留 ${result.skipped.length} 个用户改过的文件`);
            if (result.config.written)
                info(`[maodie-pet] config 已合并：新增动作 ${result.config.added.length} 个${result.config.added.length > 0 ? `（${result.config.added.join('、')}）` : ''}`);
            if (result.backupDir)
                info(`[maodie-pet] 升级前的文件已备份到 ${result.backupDir}（可用 --rollback 还原）`);
        }
        for (const message of result.warnings)
            warn(`[maodie-pet] ${message}`);
    }
    catch (error) {
        warn(`[maodie-pet] 素材安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

function timestamp() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const USAGE = `用法：
  node lib/index.js --install [--home <DSH_HOME>] [选项]
  node lib/index.js --rollback [--home <DSH_HOME>] [--backup <目录>]

选项：
  --force     所有素材按包版本覆盖（包括你替换过的文件）
  --restore   把你删掉的素材补回来（默认不复活）
  --prune     删掉新版包里已移除、且你没改过的素材
  --dry-run   只报告会发生什么，不写盘
  --json      以 JSON 输出结果`;

/** 直接运行：命令行入口。 */
function main(argv) {
    const wantInstall = argv.includes('--install');
    const wantRollback = argv.includes('--rollback');
    if (!wantInstall && !wantRollback) {
        console.log(USAGE);
        process.exitCode = 2;
        return;
    }
    const value = (flag) => {
        const index = argv.indexOf(flag);
        return index >= 0 && argv[index + 1] ? resolve(argv[index + 1]) : undefined;
    };
    const home = value('--home') ?? dshHome();
    const json = argv.includes('--json');

    try {
        if (wantRollback) {
            const result = rollbackPet({ home, backupDir: value('--backup') });
            if (json) {
                console.log(JSON.stringify(result, null, 2));
                return;
            }
            console.log(`已从 ${result.backupDir} 还原 ${result.restored.length} 个文件到 ${petPackDir(home)}`);
            return;
        }

        const result = installPet({
            home,
            force: argv.includes('--force'),
            restore: argv.includes('--restore'),
            prune: argv.includes('--prune'),
            dryRun: argv.includes('--dry-run'),
        });

        if (json) {
            console.log(JSON.stringify({
                ...result,
                copied: result.copied,
                updated: result.updated,
                skipped: result.skipped,
            }, null, 2));
            return;
        }

        console.log(`版本 ${result.previousVersion ?? '(未安装)'} → ${result.version}（${result.mode}${argv.includes('--dry-run') ? '，dry-run 未写盘' : ''}）`);
        console.log(`目标 ${result.target}`);
        console.log(`新增 ${result.copied.length + result.restored.length}｜更新 ${result.updated.length}｜保留 ${result.skipped.length}｜移除 ${result.removed.length}`);
        if (result.config.written)
            console.log(`config 已合并：新增 ${result.config.added.length} 个动作${result.config.added.length > 0 ? `（${result.config.added.join('、')}）` : ''}`);
        for (const message of result.warnings)
            console.log(`提示：${message}`);
        if (result.backupDir)
            console.log(`升级前备份：${result.backupDir}`);
        if (result.status !== 'up-to-date' && !argv.includes('--dry-run'))
            console.log('完成：刷新 DSH 页面（或右键宠物 → 重载配置）即可看到效果。');
        else
            console.log('已是最新。');
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main(process.argv.slice(2));

// 供测试引用
export const __internal = { pruneMissingActions, referencedActions, sha256, readState, writeState };

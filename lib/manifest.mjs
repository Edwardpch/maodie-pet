/**
 * 素材清单（manifest）：记录「仓库里这一版素材长什么样」+「装到用户机器上时这份文件是谁的」。
 *
 * 两份清单，缺一不可：
 *
 * 1. **包清单 `pets/maodie/.maodie-manifest.json`**（随仓库发布，由 `tools/make-manifest.mjs` 生成）
 *    ——每个文件的 sha256 与字节数。它回答「我这一版给的是什么」。安装器用它判断
 *    「用户机器上这份文件还是不是原样」。
 *
 * 2. **安装清单 `$DSH_HOME/dsh-pet/pet/.maodie-pet.json`**（本模块的 `readState` / `writeState`）
 *    ——记录上次装的是哪个版本，以及**用户存盘的文件**的 sha256 快照：
 *    - `files[rel]`：上次安装后磁盘上该文件的 sha256（等于包里的 hash 说明"原样"，
 *      不等于说明"用户改过/换过"）；
 *    - `owned[rel]`：真正由安装器写下去的那些文件（决定升级时能不能删多余素材）；
 *    - `mergedConfig`：上次合并后写下的 config 里的动作名与分类 id 集合，
 *      下次升级做三方合并时用（base = 它，ours = 磁盘现状，theirs = 新版包）。
 *
 * 为什么要第二份：用户可能替换过某个 webm（比如自己抠了一只猫），也可能手改过
 * config。只凭包清单无法区分「这台机器上是原始文件」还是「用户自己换过」——
 * 快照就是那个基线。文件缺失时也给出明确的保守结论（见 `fileVerdict`）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** 包清单文件名（放在素材目录里，随 pets/maodie 一起发布）。 */
export const MANIFEST_NAME = '.maodie-manifest.json';

/** 安装清单文件名（放在 `pet/` 下，与 `maodie-config.json` 同级）。 */
export const STATE_NAME = '.maodie-pet.json';

export function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

export function readJson(file) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : null;
    }
    catch {
        return null;
    }
}

/**
 * 规范化清单的 files 段：接受 `{ "<相对路径>": "<sha256>" }` 或
 * `{ "<相对路径>": { sha256, bytes } }` 两种写法，统一成后一种。
 */
export function normalizeFiles(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object')
        return out;
    for (const [rel, value] of Object.entries(raw)) {
        if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
            out[rel] = { sha256: value };
        else if (value && typeof value === 'object' && typeof value.sha256 === 'string')
            out[rel] = { sha256: value.sha256, bytes: typeof value.bytes === 'number' ? value.bytes : undefined };
    }
    return out;
}

/** 读取安装清单；不存在或坏掉时返回 null（调用方按"没有基线"处理）。 */
export function readState(file) {
    if (!existsSync(file))
        return null;
    const raw = readJson(file);
    if (!raw)
        return null;
    return {
        name: typeof raw.name === 'string' ? raw.name : 'maodie-pet',
        version: typeof raw.version === 'string' ? raw.version : '0.0.0',
        installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : undefined,
        files: normalizeFiles(raw.files),
        owned: Array.isArray(raw.owned) ? raw.owned.filter(item => typeof item === 'string') : [],
        mergedConfig: raw.mergedConfig && typeof raw.mergedConfig === 'object' ? raw.mergedConfig : undefined,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    };
}

/** 计算某文件在清单里该记的 hash；读不到返回 undefined。 */
export function hashFile(file) {
    try {
        return sha256(readFileSync(file));
    }
    catch {
        return undefined;
    }
}

/**
 * 判断磁盘上某个素材文件与「包里这一版」的关系。
 *
 * | 磁盘 | 快照 | 包 | 判定 |
 * | --- | --- | --- | --- |
 * | 有 | — | disk===pack | `pristine` 已经是这一版，不动 |
 * | 有 | 有，且 disk===snapshot | — | `pristine` 原样，升级时可以直接覆盖 |
 * | 有 | 有，disk!==snapshot | — | `user-modified` 用户改过，不覆盖 |
 * | 有 | 无 | hash!==disk | `unknown` 来路不明的旧文件，不覆盖（首次升级的老用户） |
 * | 无 | 有(曾经装过) | — | `user-deleted` 用户删了，默认不复活 |
 * | 无 | 无 | — | `absent` 缺失，直接装 |
 */
export function fileVerdict({ diskSha, snapshotSha, packSha, previouslyOwned }) {
    if (diskSha === undefined) {
        if (snapshotSha !== undefined || previouslyOwned)
            return 'user-deleted';
        return 'absent';
    }
    // 磁盘内容已经等于包里这一版（上一次升级写过、或重建快照后第一次跑）→ 原样，不需要再动
    if (packSha !== undefined && diskSha === packSha)
        return 'pristine';
    if (snapshotSha !== undefined)
        return diskSha === snapshotSha ? 'pristine' : 'user-modified';
    return 'unknown';
}

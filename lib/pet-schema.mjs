/**
 * maodie 桌宠配置的结构知识 —— 安装器合并逻辑与这里的事实来源保持一致。
 *
 * 这些名字来自 `pets/maodie/maodie-config.json` 的实际结构与 dsh-pet 宿主的
 * 读取方式（`node_modules/dsh-pet/lib/index.js` 的 `scanPetFiles` /
 * `resolveAsset(petConfigDir, petId + '-animation')`）：
 *
 * - 宠物条目文件：`pet/<前缀>-config.json`（也支持 `.jsonc`），这里前缀是 `maodie`；
 * - 动画素材目录：`pet/<前缀>-animation/`，按**文件名（不含扩展名）**索引，
 *   专属目录里查不到才回落到 `main-animation/webm/` 与包内素材根；
 * - 配置里引用动作名的地方有：`animations.idle/turn/drag/clicks`（字符串数组）、
 *   `animations.categories[].actions`（字符串数组）、`animations.moves.actions[].name`
 *   （字符串）、`animations.events.<事件>[]`（字符串数组）。
 *
 * 升级流程靠这些知识做三件事：认得出「哪些字符串是动作名」（合并时去重、
 * 判断用户是否自己加了动作），以及知道 `animations` 之外的部分整段由用户掌控。
 */

/** 主配置文件名（本包固定用 json；dsh-pet 同时认 .jsonc，用户改名也照常工作）。 */
export const CONFIG_NAME = 'maodie-config.json';

/** 动画素材目录名（相对宠物包目录）。 */
export const ANIM_DIR = 'maodie-animation';

/** 素材扩展名（与 dsh-pet 的 `findAnim` 一致：.webm 优先，.mov 兜底）。 */
export const ANIM_EXTS = ['.webm', '.mov'];

/** `animations` 下的扁平动作池：字符串数组。 */
export const POOL_KEYS = ['idle', 'turn', 'drag', 'clicks'];

/**
 * 返回该配置里**所有**被引用的动作名（去重保序）。
 * 只按结构取，不猜：认不出的分支跳过，绝不把非动作字符串当成动作名。
 */
export function collectActionNames(config) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
        if (typeof value !== 'string' || !value)
            return;
        if (seen.has(value))
            return;
        seen.add(value);
        out.push(value);
    };

    const animations = config?.animations;
    if (!animations || typeof animations !== 'object')
        return out;

    for (const key of POOL_KEYS) {
        const pool = animations[key];
        if (Array.isArray(pool))
            pool.forEach(push);
    }

    if (Array.isArray(animations.categories)) {
        for (const category of animations.categories) {
            if (Array.isArray(category?.actions))
                category.actions.forEach(push);
        }
    }

    const moveActions = animations.moves?.actions;
    if (Array.isArray(moveActions)) {
        for (const action of moveActions) {
            if (typeof action === 'string')
                push(action);
            else if (action && typeof action === 'object')
                push(action.name);
        }
    }

    const events = animations.events;
    if (events && typeof events === 'object') {
        for (const value of Object.values(events)) {
            if (Array.isArray(value))
                value.forEach(push);
        }
    }

    return out;
}

/**
 * 动作名 → 该动作会用到哪个素材文件。
 * dsh-pet 按文件名（去扩展名）找素材，所以动作名就是文件名；这里只做扩展名归一。
 */
export function animationFileFor(actionName, ext = '.webm') {
    return `${actionName}${ext}`;
}

/** 去掉扩展名，得到 dsh-pet 眼里的「动作名」。 */
export function actionNameFromFile(file) {
    const lower = file.toLowerCase();
    for (const ext of ANIM_EXTS) {
        if (lower.endsWith(ext))
            return file.slice(0, file.length - ext.length);
    }
    return file;
}

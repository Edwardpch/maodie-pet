/**
 * config 合并（三方合并）—— 升级时既把新动作带进来，又不抹掉用户的改动。
 *
 * 三方：base = 上次合并后写下的 config（安装清单里的 `mergedConfig`），
 *       ours = 用户磁盘上的 config，theirs = 新版包里的 config。
 *
 * 规则（只对 `animations` 段做结构合并，其余字段整段保留 ours）：
 * - 字典 / 数组：ours 与 base 相同（用户没动）→ 用 theirs；否则保留 ours；
 * - `animations.*` 的扁平动作池（idle/turn/drag/clicks）与 `categories[].actions`：
 *   在 ours 基础上追加 theirs 新增、且 ours 里没有的动作名；用户的顺序一律不动；
 * - `animations.categories`：按 id 对齐；新分类追加；ours 里全空的新分类先不塞；
 * - hers 删掉的动作：只有当 ours 里也原样保留（用户没删、且那个 webm 已经不在包里）才删，
 *   用户自己删掉的不动。
 *
 * 首次安装（没有 base）时用户本来就没有需要保护的东西，直接返回 theirs。
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** animations 里按"动作池"处理的四个键。 */
const POOL_KEYS = ['idle', 'turn', 'drag', 'clicks'];

/** JSON 等价比较（对象键顺序不算差异）。 */
export function jsonEquals(a, b) {
    return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(item => stableStringify(item)).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function equalJson(a, b) {
    return jsonEquals(a, b);
}

/** 取出 animations 里四个动作池的动作名（不做去重，调用方自己用 Set 包）。 */
function collectPoolNames(animations) {
    const names = [];
    if (!isPlainObject(animations))
        return names;
    for (const key of ['idle', 'turn', 'drag', 'clicks']) {
        if (Array.isArray(animations[key]))
            names.push(...animations[key]);
    }
    return names;
}

/** 追加 src 里 base 没有、dst 里也没有的字符串元素（保序，不重复）。 */
function appendNew(dst, src, base, onlyIfMissing = []) {
    const known = new Set([...(Array.isArray(base) ? base : []), ...dst]);
    const added = [];
    for (const item of Array.isArray(src) ? src : []) {
        if (typeof item !== 'string' || known.has(item))
            continue;
        if (onlyIfMissing.length > 0 && !onlyIfMissing.includes(item))
            continue;
        dst.push(item);
        known.add(item);
        added.push(item);
    }
    return added;
}

/**
 * 深度合并：ours 为底，逐键与 base 比较决定用谁的。
 * `handlers` 可按键名接管某个子树的合并（动画池用专门规则）。
 */
function mergeNode(ours, theirs, base, handlers, path) {
    const handler = handlers[path];
    if (handler)
        return handler(ours, theirs, base);

    if (!isPlainObject(ours) || !isPlainObject(theirs))
        return equalJson(ours, base) ? theirs : ours;

    const out = { ...ours };
    const keys = new Set([...Object.keys(theirs), ...Object.keys(ours), ...(isPlainObject(base) ? Object.keys(base) : [])]);
    for (const key of keys) {
        const childPath = path ? `${path}.${key}` : key;
        const childHandler = handlers[childPath];
        if (childHandler) {
            out[key] = childHandler(ours[key], theirs[key], isPlainObject(base) ? base[key] : undefined);
            continue;
        }
        const baseValue = isPlainObject(base) ? base[key] : undefined;
        if (!(key in theirs)) {
            // theirs 不再有这个键：用户没动过 base 就跟着删，动过就保留
            if (baseValue !== undefined && equalJson(ours[key], baseValue))
                delete out[key];
            continue;
        }
        out[key] = mergeNode(ours[key], theirs[key], baseValue, handlers, childPath);
    }
    return out;
}

/** 数组型动作池：ours 顺序不动，追加 theirs 新增，删掉真正退役的。 */
function mergeActionList(ours, theirs, base, { allowRetire = true, retired = new Set(), appendById = false } = {}) {
    if (!Array.isArray(ours))
        return Array.isArray(theirs) ? theirs.slice() : ours;
    if (!Array.isArray(theirs))
        return ours;
    const out = ours.slice();
    // 保守模式：只追加用户没有的动作，不删、不改用户顺序
    if (appendById) {
        for (const name of theirs) {
            if (!out.includes(name))
                out.push(name);
        }
        return out;
    }
    appendNew(out, theirs, base);
    // 这一版包里还带着的动作（可能只是放进了分类、没进这个池子）一律不删，只删彻底退役的。
    // 注意不能拿"这个池子里有没有"当判据：配置合并发生在素材落盘之前，此刻磁盘上
    // 还没有本轮要拷进去的新文件，磁盘可用集合会被错误地削小（用户加的动作就被误删）。
    // 素材缺失统一交给后续的 pruneMissingActions 处理。
    const packNames = new Set(Array.isArray(theirs) ? theirs : []);
    const kept = out.filter((name) => packNames.has(name) || !(retired instanceof Set) || !retired.has(name));
    out.length = 0;
    out.push(...kept);
    return out;
}

/**
 * 合并 `animations` 段。
 * @returns {{animations: object, added: string[], addedCategories: string[], removed: string[]}}
 */
export function mergeAnimations(ours, theirs, base, { retiredNames, appendById } = {}) {
    const report = { added: [], addedCategories: [], removed: [] };
    if (!isPlainObject(theirs))
        return { animations: ours, ...report };
    if (!isPlainObject(ours))
        return { animations: theirs, ...report };

    const out = {};

    // 三方比较的语义：「base 里有、这一版包里已经没有」才算退役，才能删；
    // 包里这一版还有、只是没放进这个池子的动作（比如 idle 只放了「待机」，「睡觉」在分类里），
    // 用户原先放在池子里就得原样留着。
    const packActions = new Set([
        ...collectPoolNames(theirs),
        ...(Array.isArray(theirs.categories) ? theirs.categories.flatMap(item => (Array.isArray(item?.actions) ? item.actions : [])) : []),
    ]);
    const baseActions = new Set([
        ...(base ? collectPoolNames(base) : []),
        ...(Array.isArray(base?.categories) ? base.categories.flatMap(item => (Array.isArray(item?.actions) ? item.actions : [])) : []),
    ]);
    // 基线里一条动作都没有时（老版本升级上来）无法判断退役，一律不删
    const allowRetire = baseActions.size > 0;
    // 退役集合只由安装器算好传进来。这里不做"基线里有、包里没有"的自动推断：
    // 基线可能记着一个池子里有某动作，而这一版包只是把它挪进了分类（包里仍有），
    // 那种情况不能删；真正的退役由调用方结合包内素材与基线一起判定。
    const retired = retiredNames instanceof Set ? retiredNames : new Set();
    if (process.env.MAODIE_DEBUG_CONFIG)
        process.stderr.write(`[mergeAnim] pack=${[...packActions].join('|')}\n[mergeAnim] base=${[...baseActions].join('|')}\n[mergeAnim] retired=${[...retired].join('|')}\n`);
    // 基线里明明没有这个池子，说明上一轮写下去的 config 里就没有它（用户和包都没写）；
    // 这一版包模板里多出来的空池不该凭空造进用户文件。
    const inventedPools = base ? new Set(POOL_KEYS.filter(key => !(key in base))) : new Set();

    for (const key of ['idle', 'turn', 'drag', 'clicks']) {
        const rawNext = mergeActionList(ours[key], theirs[key], base?.[key], { allowRetire, retired, appendById });
        // 磁盘上本来没有这个池子、包里也没有 → 不凭空造一个空池。
        // 造出来的空池会让"写盘结果 ≠ 磁盘内容"，幂等就断了（turn/drag 最容易被这样造出来）。
        if (rawNext === undefined && !(key in ours) && !(key in theirs) && !(isPlainObject(base) && key in base))
            continue;
        if (inventedPools.has(key) && (!Array.isArray(rawNext) || rawNext.length === 0) && !(key in (base ?? {})))
            continue;
        out[key] = Array.isArray(rawNext) ? rawNext : [];
        const before = Array.isArray(ours[key]) ? ours[key] : [];
        report.added.push(...out[key].filter(item => !before.includes(item)));
        report.removed.push(...before.filter(item => !out[key].includes(item)));
    }

    // categories：按 id 对齐，新分类追加在末尾。这里一律生成新的分类对象，
    // 绝不就地改 ours 里的对象——ours 就是磁盘上那份 config，改了会让同一次运行里的
    // "本次结果 vs 磁盘现状" 自相矛盾（幂等检查因此永远判有变化）。
    if (Array.isArray(theirs.categories)) {
        const oursCats = Array.isArray(ours.categories) ? ours.categories : [];
        const baseCats = Array.isArray(base?.categories) ? base.categories : [];
        const baseById = new Map(baseCats.filter(isPlainObject).map(item => [item.id, item]));
        const merged = [];
        for (const category of oursCats) {
            const next = theirs.categories.find(item => isPlainObject(item) && item.id === category.id);
            if (!next) {
                merged.push(category);
                continue;
            }
            // 保守模式（老版本升级上来，没有基线）只按动作 id 追加，不比顺序：
            // 没有基线就没法判断"用户改过"还是"包里换了写法"，只能一律不动用户的形状。
            const actions = appendById
                ? mergeActionList(category.actions, next.actions, undefined, { appendById: true })
                : mergeActionList(category.actions, next.actions, baseById.get(category.id)?.actions, { allowRetire, retired });
            const before = Array.isArray(category.actions) ? category.actions : [];
            report.added.push(...actions.filter(item => !before.includes(item)));
            report.removed.push(...before.filter(item => !actions.includes(item)));
            merged.push({ ...category, actions });
        }
        for (const category of theirs.categories) {
            if (!isPlainObject(category) || merged.some(item => item.id === category.id))
                continue;
            const actions = Array.isArray(category.actions) ? category.actions.slice() : [];
            // 用户机器上这些素材还不存在时（新分类整类都是新动作），先照装；素材装不上的会被这里过滤
            merged.push({ ...category, actions });
            report.addedCategories.push(category.id);
            report.added.push(...actions);
        }
        out.categories = merged;
    }
    else if (ours.categories !== undefined) {
        out.categories = ours.categories;
    }

    for (const key of Object.keys(theirs)) {
        if (key in out)
            continue;
        out[key] = ours[key] === undefined ? theirs[key] : ours[key];
    }
    for (const key of Object.keys(ours)) {
        if (key in out)
            continue;
        // 池子键在上面的循环里已经处理过（磁盘上本来没有的空池不会被凭空造出来），这里不再补
        if (POOL_KEYS.includes(key))
            continue;
        out[key] = ours[key];
    }

    report.added = [...new Set(report.added)];
    report.removed = [...new Set(report.removed)];
    return { animations: out, ...report };
}

/**
 * 合并整份 config。
 * @param {object} ours   用户磁盘上的 config
 * @param {object} theirs 新版包里的 config
 * @param {object} [base] 上次合并结果（安装清单里的 mergedConfig 快照）
 * @param {object} [options]
 * @param {string[]} [options.available] 磁盘上真实存在的动作名（新分类里素材缺失的动作先不挂）
 */
export function mergeConfig(ours, theirs, base, { available, retiredNames } = {}) {
    if (!isPlainObject(ours))
        return { config: theirs, added: [], addedCategories: [], removed: [] };
    if (!isPlainObject(theirs))
        return { config: ours, added: [], addedCategories: [], removed: [] };

    const { animations, added, addedCategories, removed } = mergeAnimations(ours.animations, theirs.animations, base?.animations, { retiredNames });

    // 新分类里的动作过滤交给 pruneMissingActions（它在素材落盘之后跑，能看到本轮拷进来的文件）。
    // 这里能动的是"分类对象"层面的复制，避免就地改到 ours。
    const dropped = [];
    // 素材缺失导致变空的分类不留在配置里（用户自己写空的分类不动，那种情况 base 里也是空）
    if (Array.isArray(animations.categories)) {
        const baseEmpty = new Set((Array.isArray(base?.animations?.categories) ? base.animations.categories : [])
            .filter(item => isPlainObject(item) && Array.isArray(item.actions) && item.actions.length === 0)
            .map(item => item.id));
        animations.categories = animations.categories.filter(category => {
            if (!isPlainObject(category) || !Array.isArray(category.actions))
                return true;
            if (category.actions.length > 0)
                return true;
            return baseEmpty.has(category.id) && !dropped.some(name => (theirs?.animations?.categories ?? []).some(item => item?.id === category.id && item.actions?.includes(name)));
        });
    }

    const out = { ...ours, animations };
    for (const [key, value] of Object.entries(theirs)) {
        if (key === 'animations')
            continue;
        if (!(key in ours))
            out[key] = value;
    }
    return { config: out, added, addedCategories, removed, dropped };
}

/** 从合并后的 config 里抽出下次升级要用的基线。 */
export function configSnapshot(config) {
    if (!isPlainObject(config))
        return { pools: { idle: [], turn: [], drag: [], clicks: [] }, categories: [] };
    const animations = isPlainObject(config.animations) ? config.animations : {};
    const categories = Array.isArray(animations.categories) ? animations.categories : [];
    const pools = {};
    for (const key of ['idle', 'turn', 'drag', 'clicks'])
        pools[key] = Array.isArray(animations[key]) ? animations[key] : [];
    const snapshot = {
        pools,
        categories: categories.filter(isPlainObject).map(item => ({
            id: item.id,
            actions: Array.isArray(item.actions) ? item.actions : [],
        })),
    };
    // 额外字段（pets/absent）原样带上：基线既拿来比对"磁盘没被动过"，也拿来还原三方合并的 base，
    // 丢掉它们会让下次比较永远不相等（pets 尤其常见）。
    if (Array.isArray(config.pets))
        snapshot.pets = config.pets.map(item => (isPlainObject(item) ? item.id : item)).filter(value => value !== undefined);
    return snapshot;
}

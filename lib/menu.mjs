/**
 * 桌宠右键菜单里的「固定橘猫」开关。
 *
 * dsh-pet 提供一份第三方菜单注册表（进程内存态，DSH 重启即清空）：
 *   POST   /dsh-pet-7340/menu/item      { owner, labels }   —— 注册即整体覆盖
 *   GET    /dsh-pet-7340/menu/events    ?owner=&wait=       —— 长轮询，读取即消费
 *   DELETE /dsh-pet-7340/menu/item      ?owner=             —— 注销
 * 我们的菜单项挂在「更多」分组下，点击后由这里改 pet/maodie-config.json 的
 * pets[0].fixedEnabled，再 POST /dsh-pet-7340/reload 让桌面 Helper 按新配置重建窗口。
 *
 * fixedEnabled 的语义（dsh-pet/lib/client.js 的 rollKind）：固定时 turn/move 权重按 0 处理，
 * 只剩 idle 与分类动作；右键点播、碎碎念、工作状态等手动触发不受影响。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MENU_OWNER = 'maodie-pet';
/** 未固定时菜单里显示：点了就固定 */
export const FIXED_LABEL = '固定橘猫（待在原地）';
/** 已固定时菜单里显示：点了就恢复走动 */
export const FREE_LABEL = '恢复走动';

/** dsh-pet 的宠物路由前缀（与它自己的 ROUTE_PREFIX 一致）。 */
export const PET_ROUTE_PREFIX = '/dsh-pet-7340';

/** 我们这只宠物的 id（配置里的 pets[0].id）。 */
export const PET_ID = 'maodie';

/** 菜单文案随当前状态翻转，点一下永远是「切到另一种状态」。 */
export function labelFor(fixed) {
    return fixed ? FREE_LABEL : FIXED_LABEL;
}

/**
 * 我们这只宠物真正生效的用户配置。
 *
 * dsh-pet 的 `scanPetFiles()`（lib/index.js:859）只读 `pet/` 目录**下一层**里匹配
 * `*-config.json` 的文件，不递归子目录，所以生效的永远是扁平的
 * `pet/maodie-config.json`；`pet/maodie/maodie-config.json` 是安装器早期写的位置，
 * 宿主根本不会加载。这里优先返回扁平那份，只在它不存在时回退到旧位置。
 */
export function configFileOf(home) {
    const flat = join(home, 'dsh-pet', 'pet', 'maodie-config.json');
    if (existsSync(flat))
        return flat;
    const nested = join(home, 'dsh-pet', 'pet', 'maodie', 'maodie-config.json');
    return existsSync(nested) ? nested : flat;
}

/** 读当前 fixedEnabled；文件不存在 / 不是数组 / 不是布尔都返回 null。 */
export function readFixed(home) {
    const file = configFileOf(home);
    if (!existsSync(file))
        return null;
    try {
        const config = JSON.parse(readFileSync(file, 'utf8'));
        const value = config?.pets?.[0]?.fixedEnabled;
        return typeof value === 'boolean' ? value : false;
    }
    catch {
        return null;
    }
}

/**
 * 写 fixedEnabled，并尽量保持原文件的排版（UTF-8、原来的换行风格、结尾换行有无）。
 * 只改这一个字段，其余键原样保留——用户自己加的动画池/动作不会被动到。
 */
export function setFixed(home, fixed) {
    const file = configFileOf(home);
    const text = readFileSync(file, 'utf8');
    const config = JSON.parse(text);
    if (!Array.isArray(config?.pets) || config.pets.length === 0)
        throw new Error(`${file} 里没有 pets[0]，无法设置 fixedEnabled`);
    config.pets[0].fixedEnabled = Boolean(fixed);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\r?\n$/.test(text) ? eol : '';
    const next = `${JSON.stringify(config, null, 2).replace(/\n/g, eol)}${trailing}`;
    writeFileSync(file, next, 'utf8');
    return { fixed: Boolean(fixed), file };
}

/** 翻转当前状态；文件不存在时报错而不是猜一个默认值。 */
export function toggleFixed(home) {
    const current = readFixed(home);
    if (current === null)
        throw new Error(`找不到可用的 ${configFileOf(home)}（先跑一次安装：maodie-pet）`);
    return setFixed(home, !current);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 启动菜单服务：注册菜单项、长轮询点击、点击后改配置并让宿主重载。
 *
 * 返回一个 `stop()`；`signal` 中止也会停。宿主没跑 dsh-pet / 路由不存在时只在第一次
 * 记一条 warn，之后静默重试——不因为这个开关拖垮插件加载。
 */
export function startFixedMenu({ port, home, logger = console, fetchImpl = globalThis.fetch, signal, baseUrl, waitMs = 8000 } = {}) {
    const origin = baseUrl ?? (port ? `http://127.0.0.1:${port}` : undefined);
    if (!origin)
        return { stop() {} };
    const base = `${origin}${PET_ROUTE_PREFIX}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    const log = (level, message) => {
        const fn = logger?.[level];
        if (typeof fn === 'function')
            fn.call(logger, message);
    };
    let registered = null;
    let warned = false;
    let stopped = false;

    const call = async (path, init = {}) => {
        const res = await fetchImpl(`${base}${path}`, {
            ...init,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!res.ok)
            throw new Error(`${path} → HTTP ${res.status}`);
        return res.json();
    };

    const register = async (fixed) => {
        const label = labelFor(fixed);
        const result = await call('/menu/item', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner: MENU_OWNER, labels: [label] }),
        });
        if (result?.ok !== true)
            throw new Error(`注册菜单项失败：${result?.message ?? JSON.stringify(result)}`);
        registered = label;
    };

    /**
     * 读桌面宠物当前的中心坐标（归一化 0~1，与 POST /position 同一口径）。
     * 桌面 Helper 会周期性把实况推给宿主（`/pose?pet=<id>` 读最近一次），
     * 从没上报过时返回 null——那就只能回配置角落。
     */
    const snapshotPose = async () => {
        try {
            const r = await call(`/pose?pet=${encodeURIComponent(PET_ID)}`, { method: 'GET' });
            if (r?.ok === true && typeof r.x === 'number' && typeof r.y === 'number')
                return { x: r.x, y: r.y };
        }
        catch {
            // 宿主老版本没有 /pose 路由：静默放弃，不影响开关本身
        }
        return null;
    };

    /**
     * 把宠物挪回原处（POST /position，mode=instant 直接落位，不做动画）。
     *
     * 为什么需要：`/reload` 会重启桌面 Helper，新进程的 sprite 从 `customPos = null` 起步
     * （runtime/electron-helper/sprite.js:120「restart 回角落」），于是哪怕只是想切个开关，
     * 猫也会跳回配置里的右下角。重建窗口后补一条位置指令就能原地不动。
     */
    const restorePose = async (pose) => {
        if (!pose)
            return false;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                // surface=desktop 必填：宿主的 /position 会按 surface 校验可见性，
                // 缺这个参数直接回 bad-request「surface 必须是 web / desktop / both / any」。
                const r = await call(`/position?pet=${encodeURIComponent(PET_ID)}&surface=desktop`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ x: pose.x, y: pose.y, mode: 'instant' }),
                });
                if (r?.ok === true)
                    return true;
            }
            catch {
                // 新窗口还没起来 / 正在忙碌：等一会儿再试
            }
            await sleep(700);
        }
        return false;
    };

    const apply = async (label) => {
        const fixed = label === FIXED_LABEL;
        // 先记下当前位置：/reload 会把 Helper 换成新进程，位置也一起丢掉。
        const pose = await snapshotPose();
        const { file } = setFixed(home, fixed);
        log('info', `[maodie-pet] 右键菜单：${fixed ? '已固定，不再来回走动' : '已恢复走动'}（${file}）`);
        // 桌面 Helper 按最新磁盘配置重建窗口；浏览器端的桌宠刷新页面也会重读。
        await call('/reload', { method: 'POST' });
        if (pose && !(await restorePose(pose)))
            log('warn', '[maodie-pet] 右键菜单：窗口已重建，但把宠物挪回原位置失败（会停在配置角落）');
        registered = null;
        await register(fixed);
    };

    const loop = async () => {
        while (!stopped && !controller.signal.aborted) {
            try {
                if (registered === null)
                    await register(readFixed(home) === true);
                const result = await call(`/menu/events?owner=${encodeURIComponent(MENU_OWNER)}&wait=${waitMs}`, { method: 'GET' });
                if (result?.ok !== true) {
                    // unknown-owner：注册表被重启清空了，重新注册即可
                    registered = null;
                    continue;
                }
                const events = result.events ?? {};
                for (const [label] of Object.entries(events)) {
                    // 桌面右键点出来的事件 payload 是 null（没有网页端 pet 实例），
                    // 所以只能按 label 判断，不能要求 pet 非空。
                    if (label !== registered)
                        continue;
                    await apply(label);
                    break;
                }
            }
            catch (error) {
                if (controller.signal.aborted)
                    break;
                registered = null;
                if (!warned) {
                    warned = true;
                    log('warn', `[maodie-pet] 右键菜单开关暂不可用（dsh-pet 未运行或路由不匹配）：${error instanceof Error ? error.message : String(error)}`);
                }
                await sleep(2000);
            }
        }
    };

    void loop();

    return {
        /** 停止轮询并尽力注销菜单项；返回的 Promise 会在注销请求结束后 settle（失败也 resolve）。 */
        stop() {
            if (stopped)
                return Promise.resolve();
            stopped = true;
            controller.abort();
            // 宿主已退出时这里失败也无所谓
            return fetchImpl(`${base}/menu/item?owner=${encodeURIComponent(MENU_OWNER)}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(2000),
            }).then(() => { }, () => { });
        },
    };
}

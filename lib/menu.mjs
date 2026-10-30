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

    const apply = async (label) => {
        const fixed = label === FIXED_LABEL;
        const { file } = setFixed(home, fixed);
        log('info', `[maodie-pet] 右键菜单：${fixed ? '已固定，不再来回走动' : '已恢复走动'}（${file}）`);
        // 桌面 Helper 按最新磁盘配置重建窗口；浏览器端的桌宠刷新页面也会重读。
        await call('/reload', { method: 'POST' });
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
                for (const [label, pet] of Object.entries(events)) {
                    if (!pet || label !== registered)
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

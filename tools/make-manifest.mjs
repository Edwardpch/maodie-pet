import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包清单文件名 */
export const MANIFEST_NAME = '.maodie-manifest.json';

/** 生成素材目录的清单：{ version, generatedAt, files: { rel: { sha256, bytes } } } */
export function buildManifest(sourceDir, version) {
    const root = resolve(sourceDir);
    const files = {};
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile())
                continue;
            const rel = relative(root, full).split(sep).join('/');
            if (rel === MANIFEST_NAME)
                continue;
            const buffer = readFileSync(full);
            files[rel] = {
                sha256: createHash('sha256').update(buffer).digest('hex'),
                bytes: buffer.length,
            };
        }
    };
    walk(root);
    return { version, generatedAt: new Date().toISOString(), files };
}

export function writeManifest(sourceDir, version) {
    const manifest = buildManifest(sourceDir, version);
    const target = join(resolve(sourceDir), MANIFEST_NAME);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { target, count: Object.keys(manifest.files).length };
}

/**
 * 校验包里的清单与素材是否一致。
 * 忘着重算清单是最难查的一类问题：升级时素材不更新、配置却变了，还会产生空转的"updated"。
 */
export function verifyManifest(sourceDir) {
    const root = resolve(sourceDir);
    const target = join(root, MANIFEST_NAME);
    if (!existsSync(target))
        return { ok: false, reason: '缺少包清单' };
    const recorded = JSON.parse(readFileSync(target, 'utf8')).files ?? {};
    const actual = buildManifest(root, 'verify').files;
    const stale = Object.keys(actual).filter(rel => recorded[rel]?.sha256 !== actual[rel].sha256);
    const missing = Object.keys(recorded).filter(rel => !(rel in actual));
    if (stale.length === 0 && missing.length === 0)
        return { ok: true, count: Object.keys(actual).length };
    return { ok: false, reason: '包清单与素材不一致', stale, missing };
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.argv[1] ? resolve(process.argv[1]) : '';
if (cli === fileURLToPath(import.meta.url)) {
    const root = join(here, '..');
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const source = process.argv[2] ? resolve(process.argv[2]) : join(root, 'pets', 'maodie');
    if (!existsSync(source)) {
        console.error(`素材目录不存在：${source}`);
        process.exit(2);
    }
    const result = writeManifest(source, version);
    console.log(`已写入 ${result.target}（${result.count} 个文件，version ${version}）`);
}
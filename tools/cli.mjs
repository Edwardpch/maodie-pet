#!/usr/bin/env node
/**
 * maodie-pet 的命令行入口。
 *
 *   maodie-pet                 # 等同于 --install：把素材装进 $DSH_HOME/dsh-pet/pet/maodie
 *   maodie-pet --dry-run       # 只报告会做什么，不落盘
 *   maodie-pet --restore       # 补回你手动删掉的素材
 *   maodie-pet --force         # 无视你的改动，全部按包里覆盖
 *   maodie-pet --prune         # 删掉新版已移除的素材（挪进备份目录，可 --rollback）
 *   maodie-pet --rollback      # 还原最近一次安装/升级前的文件
 *
 * 真正的参数解析在 lib/index.js 的 CLI 段（导出 installPet / rollbackPet 供测试用）。
 */
import { installPet, rollbackPet } from '../lib/index.js';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const value = name => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
};
const has = name => argv.includes(name);

if (has('--rollback')) {
    const result = rollbackPet({ backupDir: value('--backup') });
    if (result.backupDir === undefined)
        console.error('没有找到可以还原的备份目录');
    else
        console.log(`已从 ${result.backupDir} 还原 ${result.restored.length} 个文件`);
}
else {
    const result = installPet({
        force: has('--force'),
        restore: has('--restore'),
        prune: has('--prune'),
        dryRun: has('--dry-run'),
        home: value('--home'),
        sourceDir: has('--source') ? resolve(value('--source')) : undefined,
    });
    if (has('--json'))
        console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`[maodie-pet] ${result.status}（v${result.version}，模式 ${result.mode}）`);
        if (result.copied.length)
            console.log(`  新增 ${result.copied.length} 个文件`);
        if (result.updated.length)
            console.log(`  更新 ${result.updated.length} 个文件`);
        if (result.removed.length)
            console.log(`  移除 ${result.removed.length} 个文件`);
        if (result.skipped.length)
            console.log(`  保留你的改动 ${result.skipped.length} 个`);
        for (const warning of result.warnings ?? [])
            console.warn(`  注意：${warning}`);
        if (result.backupDir)
            console.log(`升级前备份：${result.backupDir}（可用 --rollback 还原）`);
    }
}

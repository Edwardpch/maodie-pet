/**
 * 测试启动器：在子进程里跑指定脚本，把它的 stdout/stderr 原样转出来。
 *
 *   node tools/_runner.mjs test/run.mjs
 *
 * 为什么需要它：本机（Windows + Node 24）在父进程里直接用 stdio inherit 跑测试时，
 * 子进程崩溃后的输出会丢；包一层 spawnSync 并显式把两个流写回 stderr 才稳定可见。
 */
import { spawnSync } from 'node:child_process';

const target = process.argv.slice(2);
if (target.length === 0) {
    console.error('用法：node tools/_runner.mjs <脚本> [参数...]');
    process.exit(2);
}
const r = spawnSync(process.execPath, target, { encoding: 'utf8' });
process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}\nEXIT=${r.status}\n`);
process.exit(r.status ?? 1);

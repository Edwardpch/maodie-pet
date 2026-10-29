import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
const child = process.argv[2] === 'child';

if (child) {
    await import(new URL('./run.mjs', import.meta.url).href);
}
else {
    const r = spawnSync(process.execPath, [self, 'child'], { stdio: ['ignore', 'inherit', 'inherit'] });
    process.stderr.write(`\nEXIT=${r.status}\n`);
    process.exitCode = r.status === 0 ? 0 : 1;
}

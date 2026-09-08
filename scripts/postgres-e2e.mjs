import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeArgs = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.integration.yml'];
let exitCode = 1;
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  execFileSync('docker', [...composeArgs, 'up', '-d', 'postgres', '--wait'], { cwd: root, stdio: 'inherit', timeout: 300000 });
  execFileSync(process.execPath, ['scripts/postgres-integration.mjs'], { cwd: root, stdio: 'inherit', timeout: 300000 });
  exitCode = 0;
} finally {
  try { execFileSync('docker', [...composeArgs, 'down', '-v'], { cwd: root, stdio: 'inherit', timeout: 180000 }); } catch { /* preserve the integration failure */ }
}
process.exit(exitCode);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));

const pkg = read('package.json');
const lock = read('package-lock.json');
const manifest = read('server.json');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const serverSource = readFileSync(join(root, 'src', 'mcp', 'server.ts'), 'utf8');

const expected = pkg.version;
const locations = {
  'package.json': expected,
  'package-lock.json (root)': lock.version,
  'package-lock.json (packages[""])': lock.packages?.['']?.version,
  'server.json': manifest.version,
  'server.json (packages[0])': manifest.packages?.[0]?.version,
};
const serverConstant = serverSource.match(/version:\s*'([^']+)'/)?.[1];
if (serverConstant) locations['src/mcp/server.ts'] = serverConstant;
const changelogHead = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1];
if (changelogHead) locations['CHANGELOG.md (head)'] = changelogHead;

const mismatches = Object.entries(locations).filter(([, value]) => value !== expected);
if (mismatches.length) {
  console.error(`version mismatch: expected ${expected} everywhere`);
  for (const [name, value] of mismatches) console.error(`  ${name}: ${value}`);
  process.exit(1);
}
console.log(`versions consistent: ${expected} across ${Object.keys(locations).length} locations`);

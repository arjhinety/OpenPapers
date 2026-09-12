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

// Identity drift is a separate failure class from version drift: the repository moved accounts while
// package.json, server.json, and mcpName kept the old owner, leaving a broken CI badge and an mcpName
// whose io.github.<owner> namespace no longer matched repository ownership. package.json's
// repository.url is the single source of truth for <owner>/<repo>.
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const slug = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? '');
if (!slug) {
  console.error(`unparseable package.json repository.url: ${pkg.repository?.url}`);
  process.exit(1);
}
const [, owner, repo] = slug;
const base = `https://github.com/${owner}/${repo}`;
const mcpName = `io.github.${owner}/${repo.toLowerCase()}`;

const identity = {
  'package.json (homepage)': [pkg.homepage?.startsWith(base), pkg.homepage],
  'package.json (bugs.url)': [pkg.bugs?.url?.startsWith(base), pkg.bugs?.url],
  'package.json (mcpName)': [pkg.mcpName === mcpName, pkg.mcpName],
  'server.json (name)': [manifest.name === mcpName, manifest.name],
  'server.json (repository.url)': [manifest.repository?.url === base, manifest.repository?.url],
};

// Only consider links to this repository; links to sibling projects (e.g. OpenGrad) are unrelated.
const foreign = [...readme.matchAll(new RegExp(`github\\.com/([^/\\s)]+)/${repo}(?![\\w-])`, 'g'))]
  .map(match => match[1])
  .filter(found => found !== owner);
if (foreign.length) identity[`README.md (${[...new Set(foreign)].join(', ')})`] = [false, `expected owner ${owner}`];

const identityMismatches = Object.entries(identity).filter(([, [ok]]) => !ok);
if (identityMismatches.length) {
  console.error(`identity mismatch: expected ${owner}/${repo} everywhere`);
  for (const [name, [, value]] of identityMismatches) console.error(`  ${name}: ${value}`);
  process.exit(1);
}
console.log(`identity consistent: ${owner}/${repo} across ${Object.keys(identity).length + 1} locations`);

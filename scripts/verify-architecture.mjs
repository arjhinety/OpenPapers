import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const files = async (pattern) => {
  const result = [];
  for await (const file of glob(pattern, { exclude: ['**/node_modules/**', '**/dist/**'] })) result.push(file.replaceAll('\\', '/'));
  return result.sort();
};
const violations = [];
const sourceFiles = await files('src/**/*.ts');
for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8');
  if (file.startsWith('src/mcp/') && /from\s+['"][^'"]*(?:^|\/)providers\//m.test(text)) violations.push(`${file}: MCP layer imports provider implementation directly`);
  if (file.startsWith('src/providers/') && /from\s+['"][^'"]*(?:^|\/)mcp\//m.test(text)) violations.push(`${file}: provider layer imports MCP code`);
  if (file.startsWith('src/database/') && /from\s+['"][^'"]*(?:^|\/)mcp\//m.test(text)) violations.push(`${file}: persistence layer imports MCP code`);
}
const mcpFiles = await files('src/mcp/**/*.ts');
const tools = (await Promise.all(mcpFiles.map(file => readFile(file, 'utf8')))).join('\n');
const registered = [...tools.matchAll(/registerTool\(['"]([^'"]+)/g)].map((match) => match[1]).sort();
const expected = [
  'add_paper_to_collection', 'build_research_report', 'compare_methods', 'compare_paper_to_code',
  'compare_papers', 'create_collection', 'delete_collection', 'export_research_pack',
  'extract_paper_claims', 'extract_paper_facts', 'extract_training_parameters', 'extract_training_recipe',
  'extract_training_recipe_from_url', 'find_datasets', 'find_implementations', 'find_models',
  'find_repository_configs', 'get_bibtex', 'get_citations', 'get_paper', 'get_references',
  'get_related_papers', 'get_repository_config', 'import_research_pack', 'list_collections', 'read_paper',
  'reconstruct_research', 'refresh_collection', 'refresh_paper', 'remove_paper_from_collection', 'research_method',
  'research_topic', 'resolve_author', 'search_papers', 'search_within_paper', 'vector_search', 'verify_claim'
].sort();
if (registered.length !== new Set(registered).size) violations.push('MCP registration contains duplicate tool names');
if (registered.join('\n') !== expected.join('\n')) violations.push(`MCP inventory mismatch\nexpected: ${expected.join(', ')}\nactual: ${registered.join(', ')}`);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`architecture checks passed: ${registered.length} MCP tools, ${sourceFiles.length} TypeScript source files audited`);

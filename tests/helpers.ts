import { author, paperId } from '../src/research/citations.js';
import type { ParsedDocument } from '../src/ingestion/document.js';
import type { ResearchWork } from '../src/models/research.js';
import { registerTools } from '../src/mcp/tools.js';

export { author, paperId };

export type ToolRegistration = {
  name: string;
  options: { title?: string; description?: string; inputSchema?: unknown };
  handler: (args: any, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }>;
};

export function captureTools(research: unknown, ecosystemDeps?: Record<string, unknown>): { registrations: ToolRegistration[]; handlers: Record<string, ToolRegistration['handler']> } {
  const registrations: ToolRegistration[] = [];
  registerTools({ registerTool: (name: string, options: ToolRegistration['options'], handler: ToolRegistration['handler']) => { registrations.push({ name, options, handler }); } } as any, research as any, ecosystemDeps as any);
  const handlers = Object.fromEntries(registrations.map(registration => [registration.name, registration.handler]));
  return { registrations, handlers };
}

export function makeWork(overrides: Partial<ResearchWork> & { title: string }): ResearchWork {
  const authors = overrides.authors ?? [author('Test Author')];
  return {
    paperId: overrides.paperId ?? paperId(overrides.title, authors),
    title: overrides.title,
    authors,
    year: 2024,
    publicationStatus: 'preprint',
    bibtex: `@article{test,\n  title = {${overrides.title}}\n}`,
    sourceProviders: ['fixture'],
    versions: [],
    ...overrides,
  };
}

export function makeParsedDocument(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    format: 'html',
    url: 'https://fixture.example/paper',
    title: 'Fixture Paper',
    sections: [{ level: 1, heading: 'Training Details', text: 'Optimizer: AdamW. Learning rate 2e-5. Batch size 256. Precision bf16.' } as ParsedDocument['sections'][number]],
    references: [],
    warnings: [],
    ...overrides,
  } as ParsedDocument;
}

export const ok = (result: { isError?: boolean; structuredContent?: Record<string, unknown> }): Record<string, unknown> => {
  if (result.isError) throw new Error(`expected success but tool returned isError: ${JSON.stringify(result).slice(0, 300)}`);
  return result.structuredContent ?? {};
};

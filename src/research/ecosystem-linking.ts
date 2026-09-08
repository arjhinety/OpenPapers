import type { GitHubRepository } from '../providers/github.js';
import type { HubItem, PaperLink } from '../providers/huggingface.js';
import type { Evidence, ResearchWork } from '../models/research.js';
import { makeEvidence, normalizeArxivId, normalizeDoi } from './citations.js';

export interface ReconciledPaperLink extends PaperLink {
  status: 'VERIFIED' | 'UNVERIFIED';
  paperId?: string;
}
export interface ReconciledPaperLinks { itemId: string; links: ReconciledPaperLink[]; }
export type PaperResolver = (link: PaperLink) => string | undefined;
export interface RepositoryAttribution { status: GitHubRepository['implementationStatus']; reason: string; }
export interface RepositoryLinkSource { url?: string; blobSha?: string; commitSha?: string; lineStart?: number; lineEnd?: number; }
export interface RepositoryLinkAssessment { level: 'PAPER_REFERENCED' | 'AUTHOR_OVERLAP' | 'UNVERIFIED'; implementationStatus: 'UNKNOWN'; reasons: string[]; source?: RepositoryLinkSource; }

export function classifyRepositoryAttribution(repository: GitHubRepository, paper: ResearchWork, readme = ''): RepositoryAttribution {
  const text = readme.toLowerCase();
  const identifiers = [paper.arxivId, paper.doi].filter((value): value is string => Boolean(value)).map(value => { try { return value.startsWith('10.') ? normalizeDoi(value) : normalizeArxivId(value); } catch { return value.toLowerCase(); } });
  const referencesPaper = identifiers.some(identifier => text.includes(identifier));
  const owner = repository.owner.toLowerCase().replace(/[^a-z0-9]/g, '');
  const officialClaim = /\bofficial implementation\b/.test(text);
  const organizationClaim = new RegExp(`\\bofficial implementation by ${owner}\\b`).test(text);
  const communityClaim = /\b(community|unofficial) (re)?implementation\b|\breimplementation\b/.test(text);
  if (officialClaim && communityClaim) return { status: 'UNKNOWN', reason: 'conflicting official and community attribution claims' };
  if (organizationClaim) {
    if (referencesPaper) return { status: 'ORGANIZATION_OFFICIAL', reason: 'README explicitly names the repository owner as the official implementation organization and references the paper identifier' };
    return { status: 'UNKNOWN', reason: 'README names an official organization but does not reference the verified paper identifier' };
  }
  if (officialClaim) {
    if (referencesPaper) return { status: 'OFFICIAL', reason: 'README explicitly identifies an official implementation and references the paper identifier' };
    return { status: 'UNKNOWN', reason: 'README claims official status but does not reference the verified paper identifier' };
  }
  if (communityClaim) return { status: 'COMMUNITY_REPRODUCTION', reason: 'README explicitly describes a community or reimplementation' };
  const authorOverlap = paper.authors.some(author => author.normalizedName.toLowerCase().split(/[^a-z0-9]+/).some(part => part.length >= 4 && part === owner));
  if (authorOverlap) return { status: 'AUTHOR_MAINTAINED', reason: 'Repository owner overlaps a paper author name' };
  return { status: 'UNKNOWN', reason: 'No explicit attribution evidence was found' };
}

export function assessRepositoryLink(repository: { owner: string }, paper: { arxivId?: string; doi?: string; authors: Array<{ normalizedName: string; name: string }> }, readme = '', source?: RepositoryLinkSource): RepositoryLinkAssessment {
  const reasons: string[] = [];
  const text = readme.toLowerCase();
  const arxiv = paper.arxivId?.toLowerCase();
  const doi = paper.doi?.toLowerCase();
  const paperReferenced = Boolean((arxiv && text.includes(arxiv)) || (doi && text.includes(doi)));
  if (paperReferenced) {
    reasons.push('README references the paper identifier');
    const lines = readme.split(/\r?\n/);
    const lineIndex = lines.findIndex(line => (arxiv && line.toLowerCase().includes(arxiv)) || (doi && line.toLowerCase().includes(doi)));
    if (lineIndex >= 0) source = { ...source, lineStart: lineIndex + 1, lineEnd: lineIndex + 1 };
  }
  const owner = repository.owner.toLowerCase().replace(/[^a-z0-9]/g, '');
  const authorOverlap = paper.authors.some(author => author.normalizedName.toLowerCase().split(/[^a-z0-9]+/).some(part => part.length >= 4 && part === owner));
  if (authorOverlap) reasons.push('Repository owner overlaps a paper author name');
  return { level: paperReferenced ? 'PAPER_REFERENCED' : authorOverlap ? 'AUTHOR_OVERLAP' : 'UNVERIFIED', implementationStatus: 'UNKNOWN', reasons, ...(source ? { source } : {}) };
}

export function repositoryLinkEvidence(repository: { htmlUrl: string; fullName: string }, paper: ResearchWork, assessment: RepositoryLinkAssessment): Evidence[] {
  if (assessment.level === 'UNVERIFIED') return [];
  const source = assessment.source;
  const locator = source ? { repositoryPath: 'README.md', ...(source.lineStart !== undefined ? { repositoryLineStart: source.lineStart, repositoryLineEnd: source.lineEnd } : {}), ...(source.commitSha ? { commitSha: source.commitSha } : {}) } : undefined;
  return [makeEvidence(repository.htmlUrl, paper, `GitHub repository ${repository.fullName}: ${assessment.reasons.join('; ')}`, assessment.level === 'PAPER_REFERENCED' ? 'SECONDARY_SOURCE' : 'DERIVED', 'D', locator)];
}

export function reconcilePaperLinks(item: HubItem, resolver: PaperResolver): ReconciledPaperLinks { const seen=new Set<string>(); const links=item.paperLinks.filter(link=>{const key=`${link.type}:${normalisePaperLink(link)}`;if(seen.has(key))return false;seen.add(key);return true;}).map(link=>{ const paperId = resolver(link); return paperId ? { ...link, status: 'VERIFIED' as const, paperId } : { ...link, status: 'UNVERIFIED' as const }; }); return { itemId: item.id, links }; }
function normalisePaperLink(link:PaperLink):string { try{return link.type==='arxiv'?normalizeArxivId(link.value):normalizeDoi(link.value);}catch{return link.value.trim().toLowerCase();} }

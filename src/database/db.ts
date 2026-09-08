import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ResearchWork, Evidence, GraphEdge } from '../models/research.js';
import type { ParsedDocument } from '../ingestion/document.js';
import type { PaperClaim, ClaimConflict } from '../extraction/claims.js';
import type { ResearchPack } from '../research/research-pack.js';
import { validateResearchPack } from '../research/research-pack.js';
import { runMigrations } from './migrations.js';
import { normalizeArxivId, normalizeDoi } from '../research/citations.js';
import type { AsyncResearchStore } from './store.js';

export interface Collection { id:string; name:string; paperIds:string[]; }

export class ResearchDb implements AsyncResearchStore {
  private db: DatabaseSync;
  constructor(path = process.env.RESEARCH_DB_PATH ?? ':memory:') { if(path!==':memory:')mkdirSync(dirname(path),{recursive:true}); this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode = WAL;'); runMigrations(this.db); }
  schemaVersion():number { const row=this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as {version:number}; return row.version; }
  async upsertWork(work: ResearchWork): Promise<void> { this.db.prepare('INSERT INTO works(paper_id,data,title,doi,arxiv_id,year) VALUES(?,?,?,?,?,?) ON CONFLICT(paper_id) DO UPDATE SET data=excluded.data,title=excluded.title,doi=excluded.doi,arxiv_id=excluded.arxiv_id,year=excluded.year').run(work.paperId, JSON.stringify(work), work.title, work.doi ?? null, work.arxivId ?? null, work.year ?? null); this.db.prepare('DELETE FROM works_fts WHERE paper_id=?').run(work.paperId); this.db.prepare('INSERT INTO works_fts(paper_id,title,abstract) VALUES(?,?,?)').run(work.paperId, work.title, work.abstract ?? ''); }
  async migrateWorkIdentity(fromPaperId:string,toWork:ResearchWork):Promise<void> {
    if(fromPaperId===toWork.paperId){ await this.upsertWork(toWork); return; }
    this.db.exec('BEGIN');
    try {
      const source=this.db.prepare('SELECT data FROM works WHERE paper_id=?').get(fromPaperId) as {data:string}|undefined;
      if(!source) throw new Error(`source work does not exist: ${fromPaperId}`);
      if(this.db.prepare('SELECT 1 FROM works WHERE paper_id=?').get(toWork.paperId)) throw new Error(`target work already exists: ${toWork.paperId}`);
      this.db.prepare('INSERT INTO works(paper_id,data,title,doi,arxiv_id,year) VALUES(?,?,?,?,?,?)').run(toWork.paperId,JSON.stringify(toWork),toWork.title,toWork.doi??null,toWork.arxivId??null,toWork.year??null);
      this.db.prepare('DELETE FROM works_fts WHERE paper_id=?').run(fromPaperId);
      this.db.prepare('INSERT INTO works_fts(paper_id,title,abstract) VALUES(?,?,?)').run(toWork.paperId,toWork.title,toWork.abstract??'');
      this.db.prepare('DELETE FROM works WHERE paper_id=?').run(fromPaperId);
      const evidenceRows=this.db.prepare('SELECT evidence_id,data FROM evidence WHERE paper_id=? OR source_id=?').all(fromPaperId,fromPaperId) as {evidence_id:string;data:string}[];
      for(const row of evidenceRows){ const evidence=JSON.parse(row.data) as Evidence; evidence.sourceId=toWork.paperId; this.db.prepare('UPDATE evidence SET source_id=?,paper_id=?,data=? WHERE evidence_id=?').run(toWork.paperId,toWork.paperId,JSON.stringify(evidence),row.evidence_id); }
      const claimRows=this.db.prepare('SELECT claim_id,data FROM paper_claims').all() as {claim_id:string;data:string}[];
      for(const row of claimRows){ const claim=JSON.parse(row.data) as {evidence?:Evidence}; if(claim.evidence?.sourceId===fromPaperId){claim.evidence={...claim.evidence,sourceId:toWork.paperId};this.db.prepare('UPDATE paper_claims SET data=? WHERE claim_id=?').run(JSON.stringify(claim),row.claim_id);this.db.prepare('UPDATE evidence SET source_id=? WHERE evidence_id=?').run(toWork.paperId,claim.evidence.evidenceId);}}
      this.db.prepare('INSERT OR IGNORE INTO collection_items(collection_id,paper_id) SELECT collection_id,? FROM collection_items WHERE paper_id=?').run(toWork.paperId,fromPaperId);
      this.db.prepare('DELETE FROM collection_items WHERE paper_id=?').run(fromPaperId);
      this.db.prepare('UPDATE graph_edges SET source_paper_id=? WHERE source_paper_id=?').run(toWork.paperId,fromPaperId);
      this.db.prepare('UPDATE graph_edges SET target_paper_id=? WHERE target_paper_id=?').run(toWork.paperId,fromPaperId);
      this.db.prepare('INSERT INTO work_aliases(alias_id,canonical_id) VALUES(?,?) ON CONFLICT(alias_id) DO UPDATE SET canonical_id=excluded.canonical_id').run(fromPaperId,toWork.paperId);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async addEvidence(e: Evidence, paperId: string): Promise<void> { this.db.prepare('INSERT OR REPLACE INTO evidence(evidence_id,source_id,paper_id,data) VALUES(?,?,?,?)').run(e.evidenceId, e.sourceId, paperId, JSON.stringify(e)); }
  async upsertGraphEdge(edge: GraphEdge): Promise<void> { this.db.prepare('INSERT INTO graph_edges(source_paper_id,target_paper_id,relation,relationship_class,provider,evidence_id,retrieved_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_paper_id,target_paper_id,relation,provider) DO UPDATE SET relationship_class=excluded.relationship_class,evidence_id=excluded.evidence_id,retrieved_at=excluded.retrieved_at').run(edge.sourcePaperId,edge.targetPaperId,edge.relation,edge.relationshipClass,edge.provider,edge.evidenceId,edge.retrievedAt); }
  async getGraphEdges(sourcePaperId?: string): Promise<GraphEdge[]> { const rows = (sourcePaperId ? this.db.prepare('SELECT source_paper_id AS sourcePaperId,target_paper_id AS targetPaperId,relation,relationship_class AS relationshipClass,provider,evidence_id AS evidenceId,retrieved_at AS retrievedAt FROM graph_edges WHERE source_paper_id=?') : this.db.prepare('SELECT source_paper_id AS sourcePaperId,target_paper_id AS targetPaperId,relation,relationship_class AS relationshipClass,provider,evidence_id AS evidenceId,retrieved_at AS retrievedAt FROM graph_edges')).all(...(sourcePaperId ? [sourcePaperId] : [])) as unknown as GraphEdge[]; return rows; }
  async getWork(id: string): Promise<ResearchWork | undefined> {
    const direct = this.db.prepare('SELECT data FROM works WHERE paper_id=? OR doi=? OR arxiv_id=?').get(id, id, id) as {data:string}|undefined;
    if (direct) return JSON.parse(direct.data) as ResearchWork;
    let doi: string|undefined; let arxiv: string|undefined;
    try { doi = normalizeDoi(id); } catch { /* not a DOI */ }
    try { arxiv = normalizeArxivId(id); } catch { /* not an arXiv id */ }
    if (doi || arxiv) {
      const row = this.db.prepare('SELECT data FROM works WHERE lower(doi)=lower(?) OR lower(arxiv_id)=lower(?)').get(doi ?? '', arxiv ?? '') as {data:string}|undefined;
      if (row) return JSON.parse(row.data) as ResearchWork;
    }
    const alias=this.db.prepare('SELECT canonical_id FROM work_aliases WHERE alias_id=?').get(id) as {canonical_id:string}|undefined;
    if(!alias)return undefined;
    const canonical=this.db.prepare('SELECT data FROM works WHERE paper_id=?').get(alias.canonical_id) as {data:string}|undefined;
    return canonical ? JSON.parse(canonical.data) as ResearchWork : undefined;
  }
  async search(query: string, limit = 20): Promise<ResearchWork[]> { const rows = this.db.prepare('SELECT data FROM works WHERE paper_id IN (SELECT paper_id FROM works_fts WHERE works_fts MATCH ? LIMIT ?)').all(query.replace(/["']/g, ' '), limit) as {data: string}[]; return rows.map(r => JSON.parse(r.data) as ResearchWork); }
  async saveParsedDocument(document: ParsedDocument, contentHash: string): Promise<void> { this.db.prepare('INSERT OR REPLACE INTO parsed_documents(url,content_hash,data,retrieved_at) VALUES(?,?,?,?)').run(document.url, contentHash, JSON.stringify(document), new Date().toISOString()); }
  async getParsedDocument(url: string, contentHash: string): Promise<ParsedDocument | undefined> { const row = this.db.prepare('SELECT data FROM parsed_documents WHERE url=? AND content_hash=?').get(url, contentHash) as {data:string} | undefined; return row ? JSON.parse(row.data) as ParsedDocument : undefined; }
  async saveClaim(claim: PaperClaim): Promise<void> { this.db.prepare('INSERT OR REPLACE INTO paper_claims(claim_id,claim_key,data) VALUES(?,?,?)').run(claim.claimId, claim.claimKey, JSON.stringify(claim)); await this.addEvidence(claim.evidence, claim.claimId); }
  async getClaims(): Promise<PaperClaim[]> { return (this.db.prepare('SELECT data FROM paper_claims ORDER BY claim_id').all() as {data:string}[]).map(row => JSON.parse(row.data) as PaperClaim); }
  async getClaim(claimId: string): Promise<PaperClaim | undefined> { const row=this.db.prepare('SELECT data FROM paper_claims WHERE claim_id=?').get(claimId) as {data:string}|undefined; return row ? JSON.parse(row.data) as PaperClaim : undefined; }
  async getEvidenceForPaper(paperId: string): Promise<Evidence[]> { return (this.db.prepare('SELECT data FROM evidence WHERE paper_id=? ORDER BY evidence_id').all(paperId) as {data:string}[]).map(row => JSON.parse(row.data) as Evidence); }
  async createCollection(name:string): Promise<Collection> { const normalized=name.trim(); if(!normalized) throw new Error('collection name must not be empty'); const id=`collection-${createHash('sha256').update(normalized.normalize('NFKC').toLowerCase()).digest('hex').slice(0,24)}`; this.db.prepare('INSERT OR IGNORE INTO collections(collection_id,name) VALUES(?,?)').run(id,normalized); return (await this.getCollection(id))!; }
  async addToCollection(collectionId:string,paperId:string): Promise<void> { this.db.prepare('INSERT OR IGNORE INTO collection_items(collection_id,paper_id) VALUES(?,?)').run(collectionId,paperId); }
  async removeFromCollection(collectionId:string,paperId:string):Promise<void> { this.db.prepare('DELETE FROM collection_items WHERE collection_id=? AND paper_id=?').run(collectionId,paperId); }
  async deleteCollection(collectionId:string):Promise<void> { this.db.prepare('DELETE FROM collection_items WHERE collection_id=?').run(collectionId); this.db.prepare('DELETE FROM collections WHERE collection_id=?').run(collectionId); }
  async getCollection(collectionId:string): Promise<Collection|undefined> { const row=this.db.prepare('SELECT collection_id AS id,name FROM collections WHERE collection_id=?').get(collectionId) as {id:string;name:string}|undefined; if(!row)return undefined; const items=this.db.prepare('SELECT paper_id AS paperId FROM collection_items WHERE collection_id=? ORDER BY paper_id').all(collectionId) as {paperId:string}[]; return {id:row.id,name:row.name,paperIds:items.map(item=>item.paperId)}; }
  async listCollections(): Promise<Collection[]> { return (this.db.prepare('SELECT collection_id AS id,name FROM collections ORDER BY name,id').all() as {id:string;name:string}[]).map(row=>({id:row.id,name:row.name,paperIds:(this.db.prepare('SELECT paper_id AS paperId FROM collection_items WHERE collection_id=? ORDER BY paper_id').all(row.id) as {paperId:string}[]).map(item=>item.paperId)})); }
  async saveClaimConflict(conflict: ClaimConflict): Promise<void> { this.db.prepare('INSERT OR REPLACE INTO claim_conflicts(claim_key,selected_claim_id,alternate_claim_id,data) VALUES(?,?,?,?)').run(conflict.claimKey, conflict.selectedClaimId, conflict.alternateClaimId, JSON.stringify(conflict)); }
  async getClaimConflicts(): Promise<ClaimConflict[]> { return (this.db.prepare('SELECT data FROM claim_conflicts ORDER BY claim_key,selected_claim_id,alternate_claim_id').all() as {data:string}[]).map(row => JSON.parse(row.data) as ClaimConflict); }
  async importResearchPackTransactional(pack: ResearchPack): Promise<Collection> {
    validateResearchPack(pack);
    const normalized = pack.collection.name.trim();
    const id = `collection-${createHash('sha256').update(normalized.normalize('NFKC').toLowerCase()).digest('hex').slice(0,24)}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR IGNORE INTO collections(collection_id,name) VALUES(?,?)').run(id, normalized);
      for (const paper of pack.papers) {
        this.db.prepare('INSERT INTO works(paper_id,data,title,doi,arxiv_id,year) VALUES(?,?,?,?,?,?) ON CONFLICT(paper_id) DO UPDATE SET data=excluded.data,title=excluded.title,doi=excluded.doi,arxiv_id=excluded.arxiv_id,year=excluded.year').run(paper.paperId,JSON.stringify(paper),paper.title,paper.doi??null,paper.arxivId??null,paper.year??null);
        this.db.prepare('DELETE FROM works_fts WHERE paper_id=?').run(paper.paperId);
        this.db.prepare('INSERT INTO works_fts(paper_id,title,abstract) VALUES(?,?,?)').run(paper.paperId,paper.title,paper.abstract??'');
        this.db.prepare('INSERT OR IGNORE INTO collection_items(collection_id,paper_id) VALUES(?,?)').run(id,paper.paperId);
      }
      for (const item of pack.evidence) this.db.prepare('INSERT OR REPLACE INTO evidence(evidence_id,source_id,paper_id,data) VALUES(?,?,?,?)').run(item.evidence.evidenceId,item.evidence.sourceId,item.paperId,JSON.stringify(item.evidence));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return (await this.getCollection(id))!;
  }
  async close(): Promise<void> { this.db.close(); }
}

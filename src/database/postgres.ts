import { Pool, type PoolConfig } from 'pg';
import { createHash } from 'node:crypto';
import type { ResearchWork, Evidence, GraphEdge } from '../models/research.js';
import type { ParsedDocument } from '../ingestion/document.js';
import type { PaperClaim, ClaimConflict } from '../extraction/claims.js';
import type { Collection } from './db.js';
import type { AsyncResearchStore } from './store.js';
import { validateResearchPack, type ResearchPack } from '../research/research-pack.js';
import { normalizeArxivId, normalizeDoi } from '../research/citations.js';

type PostgresQuery={query<Row=Record<string,unknown>>(text:string,parameters?:readonly unknown[]):Promise<{rows:Row[]}>};
type PostgresClient=PostgresQuery & {connect?:()=>Promise<PostgresQuery & {release:()=>void}>;end?:()=>Promise<void>;close?:()=>Promise<void>};

export const POSTGRES_SCHEMA=`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS works(paper_id text PRIMARY KEY,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS work_aliases(alias_id text PRIMARY KEY,canonical_id text NOT NULL);
CREATE TABLE IF NOT EXISTS evidence(evidence_id text PRIMARY KEY,paper_id text NOT NULL,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS graph_edges(edge_key text PRIMARY KEY,source_paper_id text NOT NULL,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS parsed_documents(cache_key text PRIMARY KEY,url text NOT NULL,content_hash text NOT NULL,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS claims(claim_id text PRIMARY KEY,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS claim_conflicts(conflict_key text PRIMARY KEY,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS collections(collection_id text PRIMARY KEY,name text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS collection_items(collection_id text NOT NULL,paper_id text NOT NULL,PRIMARY KEY(collection_id,paper_id));
CREATE TABLE IF NOT EXISTS vector_records(record_id text PRIMARY KEY,embedding vector NOT NULL,payload jsonb NOT NULL);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='vector_records' AND column_name='embedding' AND udt_name='_float4') THEN
    ALTER TABLE vector_records ALTER COLUMN embedding TYPE vector USING ('['||array_to_string(embedding,',')||']')::vector;
  END IF;
END $$;
`;
export const POSTGRES_MIGRATIONS=Object.freeze([{version:2,sql:'CREATE INDEX IF NOT EXISTS work_aliases_canonical_idx ON work_aliases(canonical_id);'}]);

export class PostgresResearchStore implements AsyncResearchStore {
  private pending:Promise<void>=Promise.resolve();
  private readonly works=new Map<string,ResearchWork>(); private readonly aliases=new Map<string,string>(); private readonly evidence=new Map<string,{paperId:string;value:Evidence}>(); private readonly edges=new Map<string,GraphEdge>(); private readonly parsed=new Map<string,ParsedDocument>(); private readonly claims=new Map<string,PaperClaim>(); private readonly conflicts=new Map<string,ClaimConflict>(); private readonly collections=new Map<string,Collection>(); private readonly vectors=new Map<string,{embedding:number[];payload:unknown}>();
  private constructor(private readonly pool:PostgresClient){}
  static fromConfig(config:PoolConfig|string|undefined=process.env.DATABASE_URL){if(!config)throw new Error('DATABASE_URL is required for PostgreSQL'); return new PostgresResearchStore(new Pool(typeof config==='string'?{connectionString:config}:config));}
  static fromQueryClient(client:PostgresClient):PostgresResearchStore{return new PostgresResearchStore(client);}
  async initialize():Promise<void>{await this.pool.query(POSTGRES_SCHEMA);await this.pool.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',[1]);for(const migration of POSTGRES_MIGRATIONS){if(await this.schemaVersion()>=migration.version)continue;await this.withTransaction(async tx=>{await tx(migration.sql);await tx('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);});} const [works,aliases,evidence,edges,parsed,claims,conflicts,collections,items,vectors]=await Promise.all([this.pool.query<any>('SELECT paper_id,payload FROM works'),this.pool.query<any>('SELECT alias_id,canonical_id FROM work_aliases'),this.pool.query<any>('SELECT evidence_id,paper_id,payload FROM evidence'),this.pool.query<any>('SELECT edge_key,payload FROM graph_edges'),this.pool.query<any>('SELECT cache_key,payload FROM parsed_documents'),this.pool.query<any>('SELECT claim_id,payload FROM claims'),this.pool.query<any>('SELECT conflict_key,payload FROM claim_conflicts'),this.pool.query<any>('SELECT collection_id,name FROM collections'),this.pool.query<any>('SELECT collection_id,paper_id FROM collection_items'),this.pool.query<any>('SELECT record_id,embedding,payload FROM vector_records')]); works.rows.forEach((x:any)=>this.works.set(x.paper_id,x.payload)); aliases.rows.forEach((x:any)=>this.aliases.set(x.alias_id,x.canonical_id)); evidence.rows.forEach((x:any)=>this.evidence.set(x.evidence_id,{paperId:x.paper_id,value:x.payload})); edges.rows.forEach((x:any)=>this.edges.set(x.edge_key,x.payload)); parsed.rows.forEach((x:any)=>this.parsed.set(x.cache_key,x.payload)); claims.rows.forEach((x:any)=>this.claims.set(x.claim_id,x.payload)); conflicts.rows.forEach((x:any)=>this.conflicts.set(x.conflict_key,x.payload)); collections.rows.forEach((x:any)=>this.collections.set(x.collection_id,{id:x.collection_id,name:x.name,paperIds:[]})); items.rows.forEach((x:any)=>this.collections.get(x.collection_id)?.paperIds.push(x.paper_id)); vectors.rows.forEach((x:any)=>this.vectors.set(x.record_id,{embedding:x.embedding,payload:x.payload}));}
  async schemaVersion():Promise<number>{const result=await this.pool.query<{version:number}>('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations');return Number(result.rows[0]?.version??0);}
  private write(operation:()=>Promise<unknown>):Promise<void>{const result=this.pending.then(()=>operation().then(()=>undefined));this.pending=result.catch(()=>undefined);return result;}
  async flush():Promise<void>{await this.pending;}
  async withTransaction<T>(operation:(query:<Row=Record<string,unknown>>(text:string,parameters?:readonly unknown[])=>Promise<{rows:Row[]}>)=>Promise<T>):Promise<T>{
    await this.flush();
    if(this.pool.connect){
      const client=await this.pool.connect();
      try{await client.query('BEGIN');const result=await operation(client.query.bind(client));await client.query('COMMIT');return result;}
      catch(error){try{await client.query('ROLLBACK');}catch{/* preserve the transaction error */}throw error;}
      finally{client.release();}
    }
    await this.pool.query('BEGIN');
    try{const result=await operation(this.pool.query.bind(this.pool));await this.pool.query('COMMIT');return result;}
    catch(error){await this.pool.query('ROLLBACK');throw error;}
  }
  async upsertWork(w:ResearchWork):Promise<void>{await this.write(()=>this.pool.query('INSERT INTO works(paper_id,payload) VALUES($1,$2) ON CONFLICT(paper_id) DO UPDATE SET payload=excluded.payload',[w.paperId,w]));this.works.set(w.paperId,w);}
  async migrateWorkIdentity(fromPaperId:string,toWork:ResearchWork):Promise<void>{
    if(fromPaperId===toWork.paperId){await this.upsertWork(toWork);return;}
    await this.withTransaction(async tx=>{
      const existing=await tx<{payload:ResearchWork}>('SELECT payload FROM works WHERE paper_id=$1',[fromPaperId]);
      if(!existing.rows[0])throw new Error(`source work does not exist: ${fromPaperId}`);
      const target=await tx('SELECT 1 FROM works WHERE paper_id=$1',[toWork.paperId]);
      if(target.rows[0])throw new Error(`target work already exists: ${toWork.paperId}`);
      await tx('INSERT INTO works(paper_id,payload) VALUES($1,$2)',[toWork.paperId,toWork]);
      await tx('UPDATE evidence SET paper_id=$1,payload=jsonb_set(payload,\'{sourceId}\',$2::jsonb) WHERE paper_id=$3',[toWork.paperId,JSON.stringify(toWork.paperId),fromPaperId]);
      await tx('UPDATE claims SET payload=jsonb_set(payload,\'{evidence,sourceId}\',$1::jsonb) WHERE payload->\'evidence\'->>\'sourceId\'=$2',[JSON.stringify(toWork.paperId),fromPaperId]);
      const edgeRows=await tx<{edge_key:string;source_paper_id:string;payload:GraphEdge}>('SELECT edge_key,source_paper_id,payload FROM graph_edges WHERE source_paper_id=$1 OR payload->>\'targetPaperId\'=$1',[fromPaperId]);
      for(const row of edgeRows.rows){const edge={...row.payload,sourcePaperId:row.payload.sourcePaperId===fromPaperId?toWork.paperId:row.payload.sourcePaperId,targetPaperId:row.payload.targetPaperId===fromPaperId?toWork.paperId:row.payload.targetPaperId};const key=[edge.sourcePaperId,edge.targetPaperId,edge.relation,edge.provider].join('|');await tx('DELETE FROM graph_edges WHERE edge_key=$1',[row.edge_key]);await tx('INSERT INTO graph_edges(edge_key,source_paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(edge_key) DO UPDATE SET payload=excluded.payload,source_paper_id=excluded.source_paper_id',[key,edge.sourcePaperId,edge]);}
      await tx('INSERT INTO collection_items(collection_id,paper_id) SELECT collection_id,$1 FROM collection_items WHERE paper_id=$2 ON CONFLICT DO NOTHING',[toWork.paperId,fromPaperId]);
      await tx('DELETE FROM collection_items WHERE paper_id=$1',[fromPaperId]);
      await tx('UPDATE vector_records SET record_id=$1,payload=jsonb_set(payload,\'{metadata,paperId}\',$2::jsonb) WHERE record_id=$3',[toWork.paperId,JSON.stringify(toWork.paperId),fromPaperId]);
      await tx('DELETE FROM works WHERE paper_id=$1',[fromPaperId]);
      await tx('INSERT INTO work_aliases(alias_id,canonical_id) VALUES($1,$2) ON CONFLICT(alias_id) DO UPDATE SET canonical_id=excluded.canonical_id',[fromPaperId,toWork.paperId]);
    });
    this.works.delete(fromPaperId); this.works.set(toWork.paperId,toWork); this.aliases.set(fromPaperId,toWork.paperId);
    for(const collection of this.collections.values())if(collection.paperIds.includes(fromPaperId))collection.paperIds=[...new Set(collection.paperIds.map(id=>id===fromPaperId?toWork.paperId:id))];
    for(const item of this.evidence.values())if(item.paperId===fromPaperId){item.paperId=toWork.paperId;item.value={...item.value,sourceId:toWork.paperId};}
    const migratedEdges=[...this.edges.values()].map(edge=>({...edge,sourcePaperId:edge.sourcePaperId===fromPaperId?toWork.paperId:edge.sourcePaperId,targetPaperId:edge.targetPaperId===fromPaperId?toWork.paperId:edge.targetPaperId})); this.edges.clear(); for(const edge of migratedEdges)this.edges.set([edge.sourcePaperId,edge.targetPaperId,edge.relation,edge.provider].join('|'),edge);
    const vector=this.vectors.get(fromPaperId); if(vector){this.vectors.delete(fromPaperId);this.vectors.set(toWork.paperId,{...vector,payload:updateVectorPaperId(vector.payload,toWork.paperId)});}
  }
  async getWork(id:string):Promise<ResearchWork|undefined>{
     const direct=this.works.get(id); if(direct)return direct;
     let doi:string|undefined; let arxiv:string|undefined;
     try { doi=normalizeDoi(id); } catch { /* not a DOI */ }
     try { arxiv=normalizeArxivId(id); } catch { /* not an arXiv id */ }
     const local=[...this.works.values()].find(work=>(doi&&work.doi&&normalizeSafe(work.doi,'doi')===doi)||(arxiv&&work.arxivId&&normalizeSafe(work.arxivId,'arxiv')===arxiv));
     if(local)return local;
     const canonical=this.aliases.get(id); if(canonical){const aliased=this.works.get(canonical);if(aliased)return aliased;}
     try { const result=await this.pool.query<{payload:ResearchWork}>('SELECT payload FROM works WHERE paper_id=$1 OR lower(payload->>\'doi\')=lower($2) OR lower(payload->>\'arxivId\')=lower($3) LIMIT 1',[id,doi??'',arxiv??'']); const payload=result?.rows?.[0]?.payload; if(payload){this.works.set(payload.paperId,payload);return payload;} } catch { /* fail closed when the durable backend is unavailable */ }
     return undefined;
   }
  async search(q:string,limit=10):Promise<ResearchWork[]>{const needle=q.toLowerCase();return [...this.works.values()].filter(w=>`${w.title} ${w.abstract??''}`.toLowerCase().includes(needle)).sort((a,b)=>a.paperId.localeCompare(b.paperId)).slice(0,limit);}
  async addEvidence(e:Evidence,paperId:string):Promise<void>{await this.write(()=>this.pool.query('INSERT INTO evidence(evidence_id,paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(evidence_id) DO UPDATE SET paper_id=excluded.paper_id,payload=excluded.payload',[e.evidenceId,paperId,e]));this.evidence.set(e.evidenceId,{paperId,value:e});}
  async getEvidenceForPaper(id:string):Promise<Evidence[]>{return [...this.evidence.values()].filter(x=>x.paperId===id).map(x=>x.value).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));}
  async upsertGraphEdge(e:GraphEdge):Promise<void>{const key=[e.sourcePaperId,e.targetPaperId,e.relation,e.provider].join('|');await this.write(()=>this.pool.query('INSERT INTO graph_edges(edge_key,source_paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(edge_key) DO UPDATE SET payload=excluded.payload',[key,e.sourcePaperId,e]));this.edges.set(key,e);}
  async getGraphEdges(source?:string):Promise<GraphEdge[]>{return [...this.edges.values()].filter(e=>!source||e.sourcePaperId===source).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
  async saveParsedDocument(d:ParsedDocument,h:string):Promise<void>{await this.write(()=>this.pool.query('INSERT INTO parsed_documents(cache_key,url,content_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload',[`${d.url}|${h}`,d.url,h,d]));this.parsed.set(`${d.url}|${h}`,d);}
  async getParsedDocument(url:string,h:string):Promise<ParsedDocument|undefined>{return this.parsed.get(`${url}|${h}`);}
  async saveClaim(c:PaperClaim):Promise<void>{await this.write(()=>this.pool.query('INSERT INTO claims(claim_id,payload) VALUES($1,$2) ON CONFLICT(claim_id) DO UPDATE SET payload=excluded.payload',[c.claimId,c]).then(()=>this.pool.query('INSERT INTO evidence(evidence_id,paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(evidence_id) DO UPDATE SET paper_id=excluded.paper_id,payload=excluded.payload',[c.evidence.evidenceId,c.evidence.sourceId,c.evidence])));this.claims.set(c.claimId,c);this.evidence.set(c.evidence.evidenceId,{paperId:c.evidence.sourceId,value:c.evidence});}
  async getClaims():Promise<PaperClaim[]>{return [...this.claims.values()].sort((a,b)=>a.claimId.localeCompare(b.claimId));}
  async getClaim(id:string):Promise<PaperClaim|undefined>{return this.claims.get(id);}
  async saveClaimConflict(c:ClaimConflict):Promise<void>{const key=JSON.stringify(c);await this.write(()=>this.pool.query('INSERT INTO claim_conflicts(conflict_key,payload) VALUES($1,$2) ON CONFLICT(conflict_key) DO NOTHING',[key,c]));this.conflicts.set(key,c);}
  async getClaimConflicts():Promise<ClaimConflict[]>{return [...this.conflicts.values()];}
  async createCollection(name:string):Promise<Collection>{const normalized=name.trim();if(!normalized)throw new Error('collection name must not be empty');const id=`collection-${createHash('sha256').update(normalized.normalize('NFKC').toLowerCase()).digest('hex').slice(0,24)}`;const existing=[...this.collections.values()].find(c=>c.name===normalized);if(existing)return existing;const c={id,name:normalized,paperIds:[]} as Collection;await this.write(()=>this.pool.query('INSERT INTO collections(collection_id,name) VALUES($1,$2) ON CONFLICT(name) DO NOTHING',[id,normalized]));this.collections.set(id,c);return c;}
  async addToCollection(id:string,paperId:string):Promise<void>{const c=this.collections.get(id);await this.write(()=>this.pool.query('INSERT INTO collection_items(collection_id,paper_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,paperId]));if(c&&!c.paperIds.includes(paperId))c.paperIds.push(paperId);}
  async removeFromCollection(id:string,paperId:string):Promise<void>{const c=this.collections.get(id);await this.write(()=>this.pool.query('DELETE FROM collection_items WHERE collection_id=$1 AND paper_id=$2',[id,paperId]));if(c)c.paperIds=c.paperIds.filter(x=>x!==paperId);}
  async deleteCollection(id:string):Promise<void>{await this.write(()=>this.pool.query('DELETE FROM collection_items WHERE collection_id=$1',[id]).then(()=>this.pool.query('DELETE FROM collections WHERE collection_id=$1',[id])));this.collections.delete(id);}
  async deleteCollectionTransactional(id:string):Promise<void>{await this.withTransaction(async tx=>{await tx('DELETE FROM collection_items WHERE collection_id=$1',[id]);await tx('DELETE FROM collections WHERE collection_id=$1',[id]);});this.collections.delete(id);}
  async importResearchPackTransactional(pack:ResearchPack):Promise<Collection>{validateResearchPack(pack);const normalized=pack.collection.name.trim();const id=`collection-${createHash('sha256').update(normalized.normalize('NFKC').toLowerCase()).digest('hex').slice(0,24)}`;let collectionId=id;const collection={id,name:normalized,paperIds:pack.papers.map(paper=>paper.paperId)} as Collection;await this.withTransaction(async tx=>{const existing=await tx<{collection_id:string}>('SELECT collection_id FROM collections WHERE name=$1',[normalized]);collectionId=existing.rows[0]?.collection_id??id;await tx('INSERT INTO collections(collection_id,name) VALUES($1,$2) ON CONFLICT(name) DO NOTHING',[collectionId,normalized]);collection.id=collectionId;for(const paper of pack.papers){await tx('INSERT INTO works(paper_id,payload) VALUES($1,$2) ON CONFLICT(paper_id) DO UPDATE SET payload=excluded.payload',[paper.paperId,paper]);await tx('INSERT INTO collection_items(collection_id,paper_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[collectionId,paper.paperId]);}for(const item of pack.evidence)await tx('INSERT INTO evidence(evidence_id,paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(evidence_id) DO UPDATE SET paper_id=excluded.paper_id,payload=excluded.payload',[item.evidence.evidenceId,item.paperId,item.evidence]);});this.collections.set(collectionId,collection);for(const paper of pack.papers)this.works.set(paper.paperId,paper);for(const item of pack.evidence)this.evidence.set(item.evidence.evidenceId,{paperId:item.paperId,value:item.evidence});return collection;}
  async persistGraphTransactional(records:Array<{work:ResearchWork;evidence:Evidence;edge:GraphEdge}>):Promise<void>{await this.withTransaction(async tx=>{for(const record of records){const key=[record.edge.sourcePaperId,record.edge.targetPaperId,record.edge.relation,record.edge.provider].join('|');await tx('INSERT INTO works(paper_id,payload) VALUES($1,$2) ON CONFLICT(paper_id) DO UPDATE SET payload=excluded.payload',[record.work.paperId,record.work]);await tx('INSERT INTO evidence(evidence_id,paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(evidence_id) DO UPDATE SET paper_id=excluded.paper_id,payload=excluded.payload',[record.evidence.evidenceId,record.work.paperId,record.evidence]);await tx('INSERT INTO graph_edges(edge_key,source_paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(edge_key) DO UPDATE SET payload=excluded.payload',[key,record.edge.sourcePaperId,record.edge]);}});for(const record of records){this.works.set(record.work.paperId,record.work);this.evidence.set(record.evidence.evidenceId,{paperId:record.work.paperId,value:record.evidence});this.edges.set([record.edge.sourcePaperId,record.edge.targetPaperId,record.edge.relation,record.edge.provider].join('|'),record.edge);}}
  async persistClaimsTransactional(claims:PaperClaim[],conflicts:ClaimConflict[]):Promise<void>{await this.withTransaction(async tx=>{for(const claim of claims){await tx('INSERT INTO claims(claim_id,payload) VALUES($1,$2) ON CONFLICT(claim_id) DO UPDATE SET payload=excluded.payload',[claim.claimId,claim]);await tx('INSERT INTO evidence(evidence_id,paper_id,payload) VALUES($1,$2,$3) ON CONFLICT(evidence_id) DO UPDATE SET paper_id=excluded.paper_id,payload=excluded.payload',[claim.evidence.evidenceId,claim.evidence.sourceId,claim.evidence]);}for(const conflict of conflicts){const key=JSON.stringify(conflict);await tx('INSERT INTO claim_conflicts(conflict_key,payload) VALUES($1,$2) ON CONFLICT(conflict_key) DO NOTHING',[key,conflict]);}});for(const claim of claims){this.claims.set(claim.claimId,claim);this.evidence.set(claim.evidence.evidenceId,{paperId:claim.evidence.sourceId,value:claim.evidence});}for(const conflict of conflicts)this.conflicts.set(JSON.stringify(conflict),conflict);}
  async getCollection(id:string):Promise<Collection|undefined>{return this.collections.get(id);}
  async listCollections():Promise<Collection[]>{return [...this.collections.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>({...c,paperIds:[...c.paperIds].sort()}));}
  async upsertVector(recordId:string,embedding:number[],payload:unknown):Promise<void>{await this.write(()=>this.pool.query('INSERT INTO vector_records(record_id,embedding,payload) VALUES($1,$2::vector,$3) ON CONFLICT(record_id) DO UPDATE SET embedding=excluded.embedding,payload=excluded.payload',[recordId,toVectorLiteral(embedding),payload]));this.vectors.set(recordId,{embedding,payload});}
  searchVectors(query:number[],limit=10):Array<{recordId:string;score:number;payload:unknown}>{return [...this.vectors.entries()].map(([recordId,v])=>{const dot=v.embedding.reduce((s,x,i)=>s+x*(query[i]??0),0);const na=Math.sqrt(v.embedding.reduce((s,x)=>s+x*x,0));const nb=Math.sqrt(query.reduce((s,x)=>s+x*x,0));return {recordId,score:na&&nb?dot/(na*nb):0,payload:v.payload};}).sort((a,b)=>b.score-a.score||a.recordId.localeCompare(b.recordId)).slice(0,limit);}
  async searchVectorsSql(query:number[],limit=10,embeddingIdentity?:string,dimensions?:number):Promise<Array<{recordId:string;score:number;payload:unknown}>>{const filters=embeddingIdentity!==undefined?(dimensions!==undefined?' WHERE payload->>\'embeddingProvider\'=$2 AND (payload->>\'dimensions\')::integer=$3':' WHERE payload->>\'embeddingProvider\'=$2'):'';const parameters=embeddingIdentity===undefined?[toVectorLiteral(query),limit]:dimensions===undefined?[toVectorLiteral(query),embeddingIdentity,limit]:[toVectorLiteral(query),embeddingIdentity,dimensions,limit];const limitParameter=embeddingIdentity===undefined?'$2':dimensions===undefined?'$3':'$4';const r=await this.pool.query<any>(`SELECT record_id,payload,1-(embedding <=> $1::vector) AS score FROM vector_records${filters} ORDER BY embedding <=> $1::vector,record_id LIMIT ${limitParameter}`,parameters);return r.rows.map((row:any)=>({recordId:row.record_id,score:Number(row.score),payload:row.payload}));}
  async close():Promise<void>{await this.write(()=>this.pool.close?this.pool.close():this.pool.end?this.pool.end():Promise.resolve());}
}
function toVectorLiteral(values:number[]):string{return `[${values.map(value=>{if(!Number.isFinite(value))throw new Error('vector values must be finite');return String(value);}).join(',')}]`;}
function normalizeSafe(value:string,kind:'doi'|'arxiv'):string { try{return kind==='doi'?normalizeDoi(value):normalizeArxivId(value);}catch{return value.trim().toLowerCase();} }
function updateVectorPaperId(payload:unknown,paperId:string):unknown { if(!payload||typeof payload!=='object')return payload; const record=payload as {metadata?:Record<string,unknown>}; return {...record,metadata:{...(record.metadata??{}),paperId}}; }

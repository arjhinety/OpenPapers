import { describe, expect, it } from 'vitest';
import { ResearchDb } from '../src/database/db.js';
import { ResearchService } from '../src/research/service.js';
import { author, bibtex, paperId } from '../src/research/citations.js';
import type { ResearchWork } from '../src/models/research.js';

describe('ResearchPack import',()=>{
  it('restores a validated pack into a local collection without remote calls', async () =>{
    const sourceDb=new ResearchDb(':memory:'); const authors=[author('Alice Smith')];
    const paper:ResearchWork={paperId:paperId('Paper A',authors,undefined,'2501.00001'),title:'Paper A',authors,year:2025,abstract:'A study',arxivId:'2501.00001',publicationStatus:'preprint',bibtex:'',sourceProviders:['arxiv'],versions:[]}; paper.bibtex=bibtex(paper);
    const pack={format:'openpapers.research-pack.v1' as const,collection:{id:'ignored',name:'restored'},papers:[paper],evidence:[]};
    const targetDb=new ResearchDb(':memory:'); const collection=await new ResearchService(targetDb).importResearchPack(pack);
    expect(collection.name).toBe('restored'); expect(await targetDb.getWork(paper.paperId)).toEqual(paper); expect((await targetDb.getCollection(collection.id))?.paperIds).toEqual([paper.paperId]); await sourceDb.close(); await targetDb.close();
  });
  it('rejects an unsupported pack format', async () =>{ await expect(new ResearchService(new ResearchDb(':memory:')).importResearchPack({format:'unknown'} as any)).rejects.toThrow('unsupported ResearchPack format'); });
  it('rejects malformed paper metadata before persistence', async () =>{ const db=new ResearchDb(':memory:'); await expect(new ResearchService(db).importResearchPack({format:'openpapers.research-pack.v1',collection:{id:'ignored',name:'bad'},papers:[{paperId:'paper-a',title:'A'}],evidence:[]} as any)).rejects.toThrow('invalid ResearchPack paper'); await db.close(); });
  it('rolls back the entire SQLite import when a later entry is malformed', async () => { const db=new ResearchDb(':memory:'); const valid={paperId:'paper-a',title:'A',authors:[],bibtex:'',sourceProviders:[],versions:[]}; await expect(new ResearchService(db).importResearchPack({format:'openpapers.research-pack.v1',collection:{id:'ignored',name:'atomic'},papers:[valid,{paperId:'paper-b',title:''}],evidence:[]} as any)).rejects.toThrow('invalid ResearchPack paper'); expect(await db.listCollections()).toEqual([]); expect(await db.getWork('paper-a')).toBeUndefined(); await db.close(); });
});
import { describe, expect, it } from 'vitest';
import { InMemoryVectorRetriever, PostgresVectorRetriever } from '../src/retrieval/vector.js';

describe('vector retrieval interface',()=>{
  it('rejects malformed, non-finite, zero, and mismatched embeddings', async()=>{
    const store={upsertVector:async()=>{},searchVectorsSql:async()=>[]};
    await expect(new PostgresVectorRetriever(store,{dimensions:2,embed:async()=>[1]}).index([{id:'a',text:'x'}])).rejects.toThrow(/dimension/);
    await expect(new PostgresVectorRetriever(store,{dimensions:2,embed:async()=>[NaN,1]}).index([{id:'a',text:'x'}])).rejects.toThrow(/finite/);
    await expect(new PostgresVectorRetriever(store,{dimensions:2,embed:async()=>[0,0]}).index([{id:'a',text:'x'}])).rejects.toThrow(/zero/);
  });
  it('indexes and deterministically ranks lexical vectors',async()=>{
    const retriever=new InMemoryVectorRetriever();
    await retriever.index([{id:'a',text:'knowledge distillation student teacher',metadata:{paperId:'paper-a'}},{id:'b',text:'image segmentation benchmark',metadata:{paperId:'paper-b'}}]);
    expect(await retriever.search('teacher distillation',5)).toEqual([{id:'a',score:0.7071067811865475,metadata:{paperId:'paper-a'}}]);
  });
  it('replaces records by id and bounds results',async()=>{
    const retriever=new InMemoryVectorRetriever(); await retriever.index([{id:'a',text:'old text'}]); await retriever.index([{id:'a',text:'new retrieval text'},{id:'b',text:'new retrieval text'}]);
    expect((await retriever.search('new',1)).map(item=>item.id)).toEqual(['a']);
  });
  it('indexes and searches through the SQL vector boundary',async()=>{
    const indexed:Array<{id:string;embedding:number[];payload:unknown}>=[];
    const store={upsertVector:(id:string,embedding:number[],payload:unknown)=>indexed.push({id,embedding,payload}),searchVectorsSql:async()=>indexed.map(item=>({recordId:item.id,score:1,payload:item.payload})),flush:async()=>undefined};
    const retriever=new PostgresVectorRetriever(store,async text=>text==='query'?[1,0]:[0,1]);
    await retriever.index([{id:'paper-a',text:'document',metadata:{paperId:'a'}}]);
    expect(await retriever.search('query')).toEqual([{id:'paper-a',score:1,metadata:{paperId:'a'}}]);
  });
  it('does not apply a bogus zero-dimension filter for bare embedding callbacks', async () => {
    let dimensions:number|undefined=123; const store={upsertVector:async()=>{},searchVectorsSql:async (_query:number[],_limit:number,_identity?:string,dims?:number)=>{dimensions=dims;return [];},flush:async()=>undefined};
    const retriever=new PostgresVectorRetriever(store,async()=>[1,0]); await retriever.index([{id:'paper-a',text:'document'}]); await retriever.search('query'); expect(dimensions).toBeUndefined();
  });
  it('requires the same embedding identity and dimension during SQL search', async () => {
    let request:{identity?:string;dimensions?:number}|undefined;
    const store={upsertVector:async()=>{},searchVectorsSql:async (_query:number[],_limit:number,identity?:string,dimensions?:number)=>{request={identity,dimensions};return [];},flush:async()=>undefined};
    const retriever=new PostgresVectorRetriever(store,{identity:'model-a',dimensions:2,embed:async()=>[1,0]});
    await retriever.index([{id:'paper-a',text:'document'}]);
    await retriever.search('query');
    expect(request).toEqual({identity:'model-a',dimensions:2});
  });
});

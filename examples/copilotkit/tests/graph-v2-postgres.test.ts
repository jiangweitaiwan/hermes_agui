import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresWikiStore } from "../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../server/graph/postgres-ingest-queue";
import { FilesystemGraphObjects } from "../server/graph/objects";
import { WikiCompiler } from "../server/graph/compiler";
import { compileV2 } from "../server/graph/compiler-v2";
import { activeEdges, postgresGraphConnection } from "../server/graph/v2-store";
import { namespaceKey } from "../server/graph/wiki-store";
import { profile, meeting, fixtureModel } from "./fixtures/graph-v2/model";
const url=process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
async function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),"graph-v2-objects-"));
 const objects=new FilesystemGraphObjects(root),store=new PostgresWikiStore(url!,objects),other=new PostgresWikiStore(url!,objects);
 const queue=new PostgresDocumentIngestor(store),second=new PostgresDocumentIngestor(other);
 const ns={principal:randomUUID(),projectId:"test",botId:"a",visibility:"bot_private" as const};
 await queue.ready();
 const add=(content:string,key:string)=>queue.enqueue(ns,{title:key,content,mime:"text/plain",idempotencyKey:key},
  {provenance:{botId:"a",threadId:key,runId:key},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:content,confirmed:false,assistants:[]}});
 return {root,objects,store,other,queue,second,ns,add,close:async()=>{await Promise.all([store.close(),other.close()]);rmSync(root,{recursive:true,force:true});}};
}
test.skipIf(!url)("PG + immutable mock GCS: concurrent subject creation/CAS retry, edge-only jobs, source revoke, tenant isolation",async()=>{
 const f=await fixture();try{
  const {ns,queue,second}=f,model=fixtureModel();const a=await f.add(profile,"a"),b=await f.add(profile,"b");
  const ja=(await queue.claim(ns,undefined,undefined,a))!,jb=(await second.claim(ns,undefined,undefined,b))!;
  const [pa,pb]=await Promise.all([compileV2(queue,model,ns,await queue.source(ja),new AbortController().signal),compileV2(second,model,ns,await second.source(jb),new AbortController().signal)]);
  const outcomes=await Promise.allSettled([queue.publish(ns,ja,pa,()=>{}),second.publish(ns,jb,pb,()=>{})]);
  expect(outcomes.filter(o=>o.status==="fulfilled")).toHaveLength(1);
  const failed=outcomes[0].status==="rejected"?ja:jb;
  const reload=await compileV2(queue,model,ns,await queue.source(failed),new AbortController().signal);expect(reload.pages).toHaveLength(0);
  await queue.publish(ns,failed,reload,()=>{});expect(await queue.graphSubjects(ns)).toHaveLength(3);
  const m=await f.add(meeting,"meeting");await new WikiCompiler(queue,model,120000,"v2").processJob(ns,m);expect((await queue.status(ns,m)).state).toBe("completed");
  const bob=(await queue.graphSubjects(ns)).find(s=>s.canonicalName==="Bob")!;
  const client=await f.store.pool.connect();try{
   expect(await activeEdges(postgresGraphConnection(client),namespaceKey(ns),bob.subjectId)).toHaveLength(1);
   expect(await activeEdges(postgresGraphConnection(client),namespaceKey({...ns,botId:"b"}),bob.subjectId)).toEqual([]);
   await queue.revoke(ns,(await queue.status(ns,m)).source);
   expect(await activeEdges(postgresGraphConnection(client),namespaceKey(ns),bob.subjectId)).toEqual([]);
  }finally{client.release();}
  const hub=(await queue.graphSubjects(ns)).find(s=>s.canonicalName==="FeatureHub")!;
  await queue.revoke(ns,(await queue.status(ns,a)).source);expect(await queue.current(ns,hub.wikiPageId)).toBeUndefined();
  await new WikiCompiler(queue,model,120000,"v2").processJob(ns,b);expect((await queue.current(ns,hub.wikiPageId))?.page.body).toContain("TTL");
 }finally{await f.close();}
});
test.skipIf(!url)("PG: object upload succeeds then DB lease validation fails; all graph rows and pointers roll back",async()=>{
 const f=await fixture();try{
  const id=await f.add(profile,"fault"),job=(await f.queue.claim(f.ns))!;
  const publication=await compileV2(f.queue,fixtureModel(),f.ns,await f.queue.source(job),new AbortController().signal);
  await f.store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET lease=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  await expect(f.queue.publish(f.ns,job,publication,()=>{})).rejects.toThrow("lease");
  expect(await f.queue.graphSubjects(f.ns)).toEqual([]);expect(await f.queue.current(f.ns,publication.subjects[0].wikiPageId)).toBeUndefined();
  const retry=(await f.second.claim(f.ns))!;await f.second.publish(f.ns,retry,publication,()=>{});expect((await f.queue.status(f.ns,id)).state).toBe("completed");
 }finally{await f.close();}
});

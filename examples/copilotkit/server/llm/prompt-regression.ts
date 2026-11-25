import golden from "./prompts/regression-v1.json";
import { ParsedSchema } from "./schema/parser";
import { RelationOutputSchema } from "./schema/relations";
import { validateRelation } from "./validation/relation";
import { schemas } from "./schema/registry";
import { validateOutput } from "./validation/pipeline";
import { validateParsed, validateSpan } from "./validation/evidence";
import type { RawSource } from "../graph/ingest-queue";
export const suiteVersion="prompt-safety-v1";
/** Deterministic negative corpus; this is a safety gate, never a model quality benchmark. */
export function promptRegression(){
  const cases:Array<{id:string;passed:boolean}>=[];
  for(const stage of Object.keys(schemas)){
    let rejected=false;
    try{validateOutput(stage,{acl:"admin",tool:"shell",inventedReference:"foreign"});}catch{rejected=true;}
    cases.push({id:`${stage}:forged-contract`,passed:rejected});
  }
  for(const fixture of golden.cases){
    const parsed=ParsedSchema.parse(structuredClone(golden.parsed));
    const proposal=RelationOutputSchema.parse({edges:[golden.relation]}).edges[0];
    const mutations:Record<string,()=>void>={none:()=>{},offset:()=>{parsed.narratives[0].position=2;},repeat:()=>{parsed.narratives[0].position=golden.source.lastIndexOf(parsed.narratives[0].quote);},
      quote:()=>{parsed.narratives[0].quote="Bob deployed v2";},claim:()=>{parsed.narratives[0].text="Bob caused an outage";},ref:()=>{parsed.narratives[0].subjectRefs.push("invented");},identity:()=>{parsed.subjects[0].identity="Bob the surgeon";},
      time:()=>{parsed.narratives[0].anchorRef="draft";},attribute:()=>{parsed.stableAttributes=[{subjectRef:"bob",kind:"background",text:"Bob drafted report yesterday",quote:golden.source,position:0}];},
      direction:()=>{proposal.fromRef="report";proposal.toRef="bob";},state:()=>{proposal.stateProperty="status";},inferred:()=>{proposal.certainty="inferred";}};
    mutations[fixture.kind]();
    const verdict=["direction","state","inferred"].includes(fixture.kind)?validateRelation(parsed,proposal):validateParsed({content:golden.source} as RawSource,parsed);
    cases.push({id:fixture.id,passed:verdict.verdict===fixture.verdict});
  }
  const source={content:"😀 Bob did not deploy.",id:"synthetic",version:1} as RawSource;
  cases.push({id:"utf16-split",passed:validateSpan(source,{quote:"\ude00",position:1}).verdict==="rejected"});
  cases.push({id:"fake-quote",passed:validateSpan(source,{quote:"Bob deployed.",position:3}).verdict==="rejected"});
  cases.push({id:"literal-negative",passed:validateSpan(source,{quote:"Bob did not deploy.",position:3}).verdict==="accepted"});
  const validation=validateParsed(source,{subjects:[],stableAttributes:[],narratives:[{ref:"n",text:"Bob deployed.",quote:"Bob did not deploy.",position:3,subjectRefs:[],timeText:"",eventRef:"e"}]});
  cases.push({id:"negation-loss",passed:validation.verdict!=="accepted"});
  return {suiteVersion,passed:cases.every(c=>c.passed),cases,checkedLayers:["output","evidence","domain"],
    notRun:["provider_quality","persistence","ACL","lease","publication"],kind:"deterministic-safety-corpus"};
}

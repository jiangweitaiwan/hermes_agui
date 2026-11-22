import type { CompilerLLM } from "../../../server/graph/compiler";
export const meeting = "11/3，會議中，Alice 報告上週搜尋推薦服務的延遲飆高，原因是 FeatureHub 的快取失效。隔天 Bob 把 FeatureHub 回滾到舊版，延遲隨即恢復。會後由 AI 助理草擬了事後檢討文件交給 Alice。";
export const profile = "FeatureHub 的本機快取使用 TTL；FeatureHub 的存取層支援版本回滾。";
export function fixtureModel(): CompilerLLM {
  return {async json(stage,data:any) {
    if (stage === "v2-parser") {
      const raw:string = data.content;
      const text = raw.includes(meeting) ? meeting : profile;
      const span = (quote:string) => ({quote,position:raw.indexOf(quote)});
      const definitions = text === meeting ? [
        ["alice","Alice","person","Alice"], ["bob","Bob","person","Bob"], ["search","搜尋推薦服務","system","搜尋推薦服務"],
        ["hub","FeatureHub","system","FeatureHub"], ["cache","FeatureHub 的快取","component","FeatureHub 的快取"],
        ["ai","AI 助理","role","AI 助理"], ["doc","事後檢討文件","document","事後檢討文件"],
      ] : [["hub","FeatureHub","system","FeatureHub"],["cache","FeatureHub 的快取","component","FeatureHub 的本機快取"],["access","FeatureHub 的存取層","component","FeatureHub 的存取層"]];
      const subjects = definitions.map(([ref,name,type,q]) => ({ref,name,type,identity:name,aliases:[],grouping:["cache","access"].includes(ref)?"component-of":"independent",
        ...(["cache","access"].includes(ref)?{parentRef:"hub"}:{}),...span(q)}));
      if (text !== meeting) return {subjects,narratives:[],stableAttributes:[
        {subjectRef:"cache",kind:"component_property",text:"本機快取使用 TTL",...span("FeatureHub 的本機快取使用 TTL")},
        {subjectRef:"access",kind:"component_property",text:"存取層支援版本回滾",...span("FeatureHub 的存取層支援版本回滾")},
      ]};
      const narrative = (ref:string,quote:string,subjectRefs:string[],timeText:string,anchorRef?:string) => ({ref,text:quote,subjectRefs,timeText,eventRef:"incident",...(anchorRef?{anchorRef}:{}),...span(quote)});
      return {subjects,stableAttributes:[],narratives:[
        narrative("meeting","11/3，會議中，Alice 報告上週搜尋推薦服務的延遲飆高",["alice","search"],"11/3"),
        narrative("cause","上週搜尋推薦服務的延遲飆高，原因是 FeatureHub 的快取失效",["cache","search"],"上週"),
        narrative("rollback","隔天 Bob 把 FeatureHub 回滾到舊版，延遲隨即恢復",["bob","hub","search"],"隔天","meeting"),
        narrative("report","會後由 AI 助理草擬了事後檢討文件交給 Alice",["ai","doc","alice"],"會後"),
      ]};
    }
    if (stage === "v2-relations") return {edges:data.narratives.length ? [
      ["meeting","alice","search","reported_issue"],["cause","cache","search","caused_degradation"],
      ["rollback","bob","hub","rolled_back"],["report","ai","doc","drafted"],["report","doc","alice","delivered_to"],
    ].map(([narrativeRef,fromRef,toRef,relation]) => ({narrativeRef,fromRef,toRef,relation,description:data.narratives.find((n:any)=>n.ref===narrativeRef).text,factKind:"event",certainty:"reported"})) : []};
    throw new Error(`Unexpected stage ${stage}`);
  }};
}

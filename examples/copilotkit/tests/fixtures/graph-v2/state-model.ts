import type {CompilerLLM} from "../../../server/graph/compiler";
export const stateText="11/05 FeatureHub 目前部署 v1。11/12 FeatureHub 目前部署 v2。";
export const stateModel:CompilerLLM={async json(stage,data:any){
 const content:string=data.content ?? stateText;
 if(stage==="v2-parser")return {subjects:[{ref:"hub",name:"FeatureHub",type:"system",identity:"FeatureHub",aliases:[],grouping:"independent",quote:"FeatureHub",position:content.indexOf("FeatureHub")},
 ...["v1","v2"].map(ref=>({ref,name:ref,type:"value",identity:ref,aliases:[],grouping:"independent",quote:ref,position:content.indexOf(ref)}))],stableAttributes:[],
 narratives:["v1","v2"].map((ref,i)=>{const quote=content.split("。")[i];return {ref,text:quote,quote,position:content.indexOf(quote),subjectRefs:["hub",ref],timeText:i?"11/12":"11/05",eventRef:ref};})};
 return {edges:["v1","v2"].map(ref=>({narrativeRef:ref,fromRef:"hub",toRef:ref,relation:"deployed_version",description:`FeatureHub 目前部署 ${ref}`,factKind:"state",stateProperty:"deployed_version",certainty:"reported"}))};
}};

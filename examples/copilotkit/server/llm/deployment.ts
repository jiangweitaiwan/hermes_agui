import { ModelRegistry, taskFingerprint } from "./config";
/** New and legacy configuration cannot coexist for an activated role. No implicit rerouting. */
export function configureLLMDeployment(input:any){
  console.info(JSON.stringify({event:"graph_task_contract",fingerprint:taskFingerprint()}));
  if(!input?.llm)return input;
  const registry=new ModelRegistry(input.llm);
  if(input.llmFingerprint && input.llmFingerprint!==registry.fingerprint)throw new Error("LLM config fingerprint mismatch");
  const copy=structuredClone(input);
  configureGraph(copy,registry);
  configureTemplates(copy,registry);
  console.info(JSON.stringify({event:"llm_config",version:1,fingerprint:registry.fingerprint}));
  return copy;
}

function configureGraph(copy:any,registry:ModelRegistry){
  const configured=(role:string)=>registry.config.models.some(m=>m.alias===role);
  const route=(role:string)=>({registry:registry.config,role,...(copy.llmControl?.mode==="managed" && role!=="graph_embedding"?{managed:true}:{})});
  if(copy.graph?.enabled){
    if(copy.graph.evolution?.enabled){
      if(copy.graph.evolution.compiler)throw new Error("Conflicting legacy compiler and LLM registry");
      for(const role of ["graph_parser","graph_matcher","graph_relations"])registry.model(role);
      copy.graph.evolution.compiler=route("graph_parser");
    }
    for(const [field,role] of [["embedding","graph_embedding"],["queryParser","graph_query"],["storyteller","graph_story"]]){
      if(!configured(role))continue;
      if(copy.graph[field])throw new Error("Conflicting legacy Graph config and LLM registry");
      copy.graph[field]=route(role);
    }
    if(copy.graph.retrievalMode==="v3")registry.model("graph_query");
  }
}
function configureTemplates(copy:any,registry:ModelRegistry){
  const configured=(role:string)=>registry.config.models.some(m=>m.alias===role);
  for(const template of copy.management?.templates ?? []){
    if(template.harness!=="hermes")continue;
    const role=template.modelRole ?? "agent_primary";
    if(copy.llmControl?.mode==="managed" && role!=="agent_primary")throw new Error("Managed Bots use the deployment agent_primary role");
    if(!configured(role))throw new Error("Unknown Bot model role");
    if(template.model || template.provider)throw new Error("Conflicting legacy Bot routing and LLM registry");
    const model=registry.model(role),provider=registry.provider(model.provider);
    if(!provider.capabilities.includes("chat")||model.dimension)throw new Error("Bot role requires chat capability");
    template.model=model.model;template.provider=provider.driver==="vertex"?"vertex":provider.id;
  }
}

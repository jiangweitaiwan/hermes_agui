import { execution, observe, type Observer } from "../observability";
import { validateOutput, ValidationError, issue, result } from "./pipeline";
/** Keep existing retrieval algorithms/fallbacks; expose their semantic verdict without source text. */
export function validateRetrieval<T>(stage:"v3-query"|"v3-story",output:unknown,check:()=>T,sink:Observer=observe):T {
  const started=Date.now();
  try{
    validateOutput(stage,output);
    const value=check();
    sink(execution(stage,started,result(stage,[],["output","evidence","domain"])));
    return value;
  }catch(error){
    const validation=error instanceof ValidationError?error.validation:result(stage,[issue(stage,"evidence",stage==="v3-query"?"REF_INVALID":"SEMANTIC_UNCERTAIN",stage==="v3-query"?"rejected":"needs_review")],["output","evidence","domain"]);
    sink(execution(stage,started,validation,{outcome:"failed"}));
    throw new ValidationError(validation);
  }
}

import golden from "./prompts/regression-v1.json";
import { createHash } from "node:crypto";
import { z } from "zod";
import { baselineSystemPrompt, baselinePromptFor, instruction } from "./prompts/registry";
import { schemas, outputSchema } from "./schema/registry";
const editableTasks=["v2-parser","v2-subject-disambiguation","v2-relations","v3-query","v3-story"] as const;
export const PromptEdits=z.object(Object.fromEntries([...editableTasks,"agent_primary"].map(id=>[id,z.string().max(id==="agent_primary"?4000:12000).optional()]))).strict();
export type PromptEdits=z.infer<typeof PromptEdits>;
export const textHash=(text:string)=>createHash("sha256").update(text).digest("hex");
export function promptManifest(baseline:Record<string,unknown>,edits:PromptEdits){
  const tasks={...baseline};
  for(const stage of editableTasks){
    const editableText=edits[stage]??"", protectedText=baselineSystemPrompt(stage);
    const prompt=editableText?`${instruction}\nTask guidance (subordinate to protected contracts):\n${editableText}\n${baselinePromptFor(stage).rule}\n${stage}`:protectedText;
    tasks[stage]={...(baseline[stage] as object),prompt,promptVersion:`p2-${textHash(prompt)}`,editableText,
      protectedContractId:"graph-v1",protectedContractHash:textHash(protectedText),effectivePromptHash:textHash(prompt)};
  }
  // Native slot is separate from Graph contracts and contains no runtime session material.
  tasks.agent_primary={prompt:edits.agent_primary??"",promptVersion:`p2-${textHash(edits.agent_primary??"")}`,
    protectedContractId:"native-slot-v1",protectedContractHash:textHash("native-slot-v1:subordinate-deployment-guidance"),effectivePromptHash:textHash(edits.agent_primary??""),editableText:edits.agent_primary??"",schemaVersion:1,validatorVersion:"1"};
  return tasks;
}
export function schemaView(stage:string){
  if(!Object.hasOwn(schemas,stage))throw new Error("Unknown schema task");
  const schema=outputSchema(schemas[stage]);
  return {task:stage,schemaVersion:1,validatorVersion:"1",schema,examples:stage==="v2-parser"?[golden.parsed]:stage==="v2-relations"?[{edges:[golden.relation]}]:[],schemaHash:textHash(JSON.stringify(schema)),
    projectionWarning:"Provider projection omits Zod refinements and semantic constraints. Code-defined; readonly.",
    checks:{output:"Deployed Zod schema",evidence:"Literal UTF-16 spans, negation, identity and attribution",
      domain:"References, direction, time/state/event and exact story claims",persistence:"ACL, active source revision, revocation and transaction fencing"}};
}

import { z } from "zod";
export const RetrievalConfig = z.object({
  retrievalMode:z.enum(["v2","v3"]).default("v2"),
  runtimeDeadlineMs:z.number().int().min(100).max(15000).default(8000),
  storyteller:z.object({baseUrl:z.string().url(),model:z.string().min(1).max(200),keyEnv:z.string().min(1),timeoutMs:z.number().int().min(1).max(5000).default(1500),maxTokens:z.number().int().min(1).max(4096).default(2048)}).strict().optional(),
  queryParser:z.object({baseUrl:z.string().url(),model:z.string().min(1).max(200),keyEnv:z.string().min(1),
    timeoutMs:z.number().int().min(1).max(30000).default(2000),maxTokens:z.number().int().min(1).max(8192).default(2048)}).strict().optional(),
}).superRefine((v,ctx)=>{if(v.retrievalMode==="v3"&&!v.queryParser)ctx.addIssue({code:"custom",message:"V3 requires explicit queryParser model"});});

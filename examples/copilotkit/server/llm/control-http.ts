import type { IncomingMessage,ServerResponse } from "node:http";
export function serveHealth(req:IncomingMessage,res:ServerResponse){
  if(req.url==="/health" && req.method==="GET"){
    res.writeHead(200,{"Content-Type":"application/json"}).end('{"status":"ok"}');return true;
  }
  return false;
}
export function dispatchControlHttp(req:IncomingMessage,res:ServerResponse,handler?: (req:IncomingMessage,res:ServerResponse)=>Promise<void>){
  if(!req.url?.startsWith("/api/admin/llm/"))return false;
  if(!handler){res.writeHead(404).end();return true;}
  void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});
  return true;
}

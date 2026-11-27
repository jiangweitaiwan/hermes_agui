import { upgradeRelease } from "./control-upgrade";
import { readFile } from "node:fs/promises";
import { ControlSettings, candidate, hash } from "./control-contract";
import { ControlStore } from "./control-store";

async function main() {
  const [command, filename, ...flags] = process.argv.slice(2);
  if (!["bootstrap","opt-in","upgrade"].includes(command) || !filename) throw new Error("Control CLI: bootstrap|upgrade RUNTIME_CONFIG [--apply]; upgrade requires a fenced deployment");
  const positional=flags.filter(flag=>flag!=="--apply");
  if(command!=="opt-in"?positional.length!==0:positional.length!==1 || !/^[a-z][a-z0-9_-]{0,63}$/.test(positional[0]))throw new Error("Invalid CLI arguments");
  if(command==="opt-in") { console.log(JSON.stringify({deprecated:true,required:false,message:"Managed deployment automatically manages eligible native Bots"})); return; }
  const input = JSON.parse(await readFile(filename, "utf8"));
  const policy = ControlSettings.parse(input.llmControl);
  const snapshot = candidate(input.llm, policy);
  if (!flags.includes("--apply")) { console.log(JSON.stringify({ candidateHash: hash(snapshot), applied: false })); return; }
  const store = new ControlStore(process.env.AGUI_LLM_ADMIN_DATABASE_URL ?? "", policy);
  try {
    await store.ready();
    const actor=`cli:${(await store.pool.query("SELECT current_user AS actor")).rows[0].actor}`;
    const result=command==="upgrade" ? await upgradeRelease(store,input.llm) : await store.bootstrap(input.llm,actor,true);
    console.log(JSON.stringify(result));
  }
  finally { await store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "LLM control operation rejected"); process.exitCode = 1; });

import { BotThreads } from "../../frontend/BotThreads";
import { useState } from "react";
import { BotManagement, type BotItem } from "../../frontend/BotManagement";
import { createRoot } from "react-dom/client";
import { LLMManagement } from "../../frontend/LLMManagement";
function Acceptance(){
  const [bots,setBots]=useState<BotItem[]>([]);
  const [selected,setSelected]=useState<string>();
  return <><LLMManagement /><BotManagement bots={bots} onBots={setBots} onOpen={setSelected} />{selected && <BotThreads key={selected} botId={selected} visible />}</>;
}
createRoot(document.getElementById("root")!).render(<Acceptance />);

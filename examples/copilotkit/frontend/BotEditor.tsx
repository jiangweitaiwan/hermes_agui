import { useEffect, useState } from "react";
import type { BotInput, BotRecord, BotTemplate } from "../server/bots/types";
import type { BotItem } from "./BotManagement";

interface ChecklistProps {
  title: string;
  options: { id: string; name: string }[];
  values: string[];
  onChange: (values: string[]) => void;
}
function Checklist({ title, options, values, onChange }: ChecklistProps) {
  return <fieldset><legend>{title}</legend>{options.map(option => <label key={option.id}>
    <input type="checkbox" checked={values.includes(option.id)} onChange={() => onChange(values.includes(option.id)
      ? values.filter(value => value !== option.id) : [...values, option.id])} />{option.name}
  </label>)}</fieldset>;
}
interface BotEditorProps {
  editing?: BotRecord;
  templates: BotTemplate[];
  bots: BotItem[];
  busy: boolean;
  onSave: (input: BotInput) => Promise<void>;
  onCancel: () => void;
}
export function BotEditor({ editing, templates, bots, busy, onSave, onCancel }: BotEditorProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [toolsets, setToolsets] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  useEffect(() => {
    setName(editing?.name ?? ""); setDescription(editing?.description ?? "");
    setTemplateId(editing?.templateId ?? templates[0]?.id ?? ""); setSkills(editing?.skills ?? []);
    setToolsets(editing?.toolsets ?? []); setTargets(editing?.delegationTargets ?? []);
  }, [editing, templates]);
  const selected = templates.find(template => template.id === templateId);
  const options = (values: string[]) => values.map(value => ({ id: value, name: value }));
  return <form aria-label={editing ? "編輯 Bot" : "建立 Bot"} onSubmit={event => {
    event.preventDefault();
    if (selected && !busy) void onSave({ name, description, templateId, harness: selected.harness,
      skills: skills.filter(value => selected.skills.includes(value)),
      toolsets: toolsets.filter(value => selected.toolsets.includes(value)),
      delegationTargets: targets.filter(id => bots.some(bot => bot.id === id && bot.status === "active" && bot.id !== editing?.id)) });
  }}>
    <h3>{editing ? "編輯 Bot" : "建立 Bot"}</h3>
    {editing && <p>{selected?.llmManaged ? "模型／Provider 繼承 active agent_primary；全域發布於下一個新回合生效。" : "模型、工具與角色設定會在新對話生效；既有對話保留已載入的設定。"}</p>}
    <label>Bot 名稱<input value={name} onChange={e => setName(e.target.value)} maxLength={100} required /></label>
    <label>說明<textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} /></label>
    <label>Harness／模型<select value={templateId} onChange={e => {
      setTemplateId(e.target.value); setSkills([]); setToolsets([]);
    }}>{templates.filter(t => !editing || t.harness === editing.harness).map(t =>
      <option key={t.id} value={t.id}>{t.name} · {t.harness} · {t.llmManaged ? "繼承 active release · agent_primary" : `啟動時範本：${t.provider}/${t.model}`}</option>)}</select></label>
    <Checklist title="Skills" options={options(selected?.skills ?? [])} values={skills} onChange={setSkills} />
    <Checklist title="Toolsets" options={options(selected?.toolsets ?? [])} values={toolsets} onChange={setToolsets} />
    <Checklist title="可委派的 Bot" options={bots.filter(bot => bot.status === "active" && bot.id !== editing?.id)}
      values={targets} onChange={setTargets} />
    <button disabled={busy || !selected}>{editing ? "儲存 Bot" : "建立 Bot"}</button>
    {editing && <button type="button" disabled={busy} onClick={onCancel}>取消編輯</button>}
  </form>;
}

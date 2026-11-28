import { expect, test } from "vitest";
import { credentialURL } from "../server/storage/clean-reset";
import { validateCredentialInventory } from "../server/storage/clean-operations";

test.each(["user=owner","dbname=other","hostaddr=192.0.2.1","host=x&host=y","service=owner"])("libpq override %s cannot bypass credential identity checks",query=>{
  expect(()=>credentialURL(`postgresql://hermes_host:secret@localhost/hermes?${query}`)).toThrow("overrides");
});
test("every mounted old DSN must be a known application role, including Secret aliases",()=>{
  const env="AGUI_OLD_HOST_URL",roles=["hermes_host"],urls:string[]=[];
  process.env[env]="postgresql://owner:secret@localhost/hermes?host=/cloudsql/p:r:i";
  try {
    expect(()=>validateCredentialInventory([{env,role:"hermes_host"}],JSON.stringify([env]),"AGUI_OLD_",roles,urls)).toThrow("role mismatch");
    process.env[env]="postgresql://hermes_host:secret@localhost/hermes?host=/cloudsql/p:r:i";
    expect(()=>validateCredentialInventory([{env,role:"hermes_host"}],JSON.stringify([env,"AGUI_OLD_EXTRA_URL"]),"AGUI_OLD_",roles,urls)).toThrow("Every mounted");
    validateCredentialInventory([{env,role:"hermes_host"}],JSON.stringify([env]),"AGUI_OLD_",roles,urls);
    expect(urls).toHaveLength(1);
  }finally {delete process.env[env];}
});

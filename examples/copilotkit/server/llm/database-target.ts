/** Credentials may differ; ledger and control plane must use the same explicit database destination. */
export function databaseTarget(connectionString:string){
  const url=new URL(connectionString.replace(/@\//,"@localhost/"));
  if(!["postgres:","postgresql:"].includes(url.protocol))throw new Error("PostgreSQL destination required");
  const host=url.searchParams.get("host")??url.hostname;
  const database=decodeURIComponent(url.pathname.slice(1));
  if(!host || !database)throw new Error("Explicit database destination required");
  return JSON.stringify([host,(url.searchParams.get("port")??url.port)||"5432",database,url.searchParams.get("hostaddr")]);
}

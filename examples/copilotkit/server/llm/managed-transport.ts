import { request } from "node:https";
import { lookup } from "node:dns";
import { Readable } from "node:stream";
import { ControlError } from "./control-contract";
import { isIPv4,isIP } from "node:net";

const blockedNetworks:[string,number][]=[
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],
  ["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4],
];
const ipNumber=(address:string)=>address.split(".").reduce((value,part)=>(value*256+Number(part))>>>0,0);

export function publicIPv4(address: string) {
  if(!isIPv4(address))return false;
  const value=ipNumber(address);
  return !blockedNetworks.some(([network,bits])=>(value>>>(32-bits))===(ipNumber(network)>>>(32-bits)));
}
/** DNS is checked inside TLS connection lookup, preventing a second unchecked DNS resolution. */
export const managedTransport: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || isIP(url.hostname) || url.hostname.includes(":")) throw new ControlError(422, "Managed HTTPS transport required");
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, { family:4,method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)),
      signal: init?.signal ?? undefined, lookup: (hostname, _options, callback) => {
        lookup(hostname, { family: 4, all: true }, (error, addresses) => {
          if (error) { callback(error, "", 4); return; }
          if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) { callback(new Error("Managed destination denied"), "", 4); return; }
          callback(null, addresses[0].address, 4);
        });
      } }, incoming => {
      const status=incoming.statusCode??500;
      if(status<200 || status>599){incoming.destroy();reject(new Error("Invalid provider status"));return;}
      // Never follow redirects or read their bodies.
      if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) {
        incoming.destroy(); reject(new Error("Provider redirect denied")); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      if(status===204 || status===205){incoming.destroy();resolve(new Response(null,{status,headers}));return;}
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
    });
    outgoing.on("error", reject);
    outgoing.end(init?.body);
  });
};

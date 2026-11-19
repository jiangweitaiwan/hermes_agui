import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { Identity } from "./bots/types";

const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return !url.hostname.includes("*") && url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
});
export const CloudSchema = z.object({
  hosts: z.array(z.string().min(1).refine(value => !value.includes("*") && !value.includes("/"))).min(1), origins: z.array(httpsUrl).min(1),
  firebaseProject: z.string().min(1),
  members: z.array(z.object({ uid: z.string().min(1), ownerId: z.string().min(1), principal: z.string().min(1), projectId: z.string().min(1) }).strict()).min(1),
  serviceAudience: httpsUrl, serviceAccounts: z.array(z.string().email()).min(1),
  hostAudience: httpsUrl,
}).strict();
export type CloudSettings = z.infer<typeof CloudSchema>;
let settings: CloudSettings | undefined;
const identities = new WeakMap<Request, Identity>();
const auth = new GoogleAuth();
const verifier = new OAuth2Client();
const clients = new Map<string, ReturnType<GoogleAuth["getIdTokenClient"]>>();
export function configureCloud(value: unknown) {
  if (value !== undefined && (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST)) throw new Error("Cloud mode forbids emulator authentication/storage");
  settings = value === undefined ? undefined : CloudSchema.parse(value);
  return settings;
}
export function cloudSettings() { return settings; }
export function cloudIdentity(request: Request) { return identities.get(request); }
export function allowedOrigin(origin: string | null) { return !origin || !!settings?.origins.includes(origin); }
export async function serviceHeaders(audience: string): Promise<Record<string, string>> {
  let client = clients.get(audience);
  if (!client) { client = auth.getIdTokenClient(audience); clients.set(audience, client); }
  try {
    const headers = await (await client).getRequestHeaders();
    const token = headers.get("authorization");
    if (!token) throw new Error("ADC ID token unavailable");
    return { "X-Serverless-Authorization": token };
  } catch (error) { clients.delete(audience); throw error; }
}
export async function hostFetch(input: string | URL | Request, init?: RequestInit) {
  if (!settings) return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== new URL(settings.hostAudience).origin) throw new Error("Host destination denied");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  Object.entries(await serviceHeaders(settings.hostAudience)).forEach(([key, value]) => headers.set(key, value));
  return fetch(input, { ...init, headers, redirect: "error" });
}
async function verifyFirebase(token: string) {
  const projectId = settings!.firebaseProject;
  const name = `hermes-${projectId}`;
  const app = getApps().find(app => app.name === name) ?? initializeApp({ projectId }, name);
  return getAuth(app).verifyIdToken(token);
}
/** Only verified, server-mapped identities reach the existing synchronous ACL layer. */
export async function authenticateBrowser(request: Request) {
  if (!settings) return true;
  if (!allowedOrigin(request.headers.get("origin"))) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length > 16384) return false;
  try {
    const payload = await verifyFirebase(authorization.slice(7));
    const member = settings.members.find(member => member.uid === payload?.sub);
    const authTime = (payload as unknown as { auth_time?: number } | undefined)?.auth_time;
    if (!member || !payload?.sub || !payload.exp || payload.exp <= Date.now() / 1000 ||
        !authTime || !Number.isFinite(authTime) || authTime > Date.now() / 1000) return false;
    identities.set(request, { ownerId: member.ownerId, principal: member.principal, projectId: member.projectId });
    return true;
  } catch { return false; }
}
export async function authenticateService(request: Request) {
  if (!settings || request.headers.has("origin")) return false;
  const token = request.headers.get("x-hermes-service-identity");
  if (!token || token.length > 16384) return false;
  try {
    const payload = (await verifier.verifyIdToken({ idToken: token, audience: settings.serviceAudience })).getPayload();
    return !!payload?.exp && payload.exp > Date.now() / 1000 && payload.email_verified === true && !!payload.email && settings.serviceAccounts.includes(payload.email) &&
      ["accounts.google.com", "https://accounts.google.com"].includes(payload.iss);
  } catch { return false; }
}

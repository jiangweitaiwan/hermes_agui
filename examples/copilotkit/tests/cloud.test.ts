import { afterEach, expect, test, vi } from "vitest";
import { CloudSchema, authenticateBrowser, authenticateService, configureCloud, hostFetch } from "../server/cloud";
import { BotAuthentication } from "../server/bots/auth";
import { sameOrigin } from "../server/bots/api";
import { TasksSchema } from "../server/graph/tasks";
import { parse } from "pg-connection-string";
import { readFileSync } from "node:fs";
const deployment = JSON.parse(readFileSync(new URL("../../../deploy/gcp/runtime.example.json", import.meta.url), "utf8"));
afterEach(() => { configureCloud(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
test("cloud deployment schemas and Unix socket DSN are accepted by production parsers", () => {
  expect(CloudSchema.parse(deployment.cloud).members[0].principal).toBe("owner");
  expect(TasksSchema.parse(deployment.tasks).deadlineSeconds).toBe(600);
  expect(parse("postgresql://runtime:secret@localhost/hermes?host=/cloudsql/project:asia-east1:instance").host).toBe("/cloudsql/project:asia-east1:instance");
  expect(() => CloudSchema.parse({ ...deployment.cloud, origins: ["https://*.vercel.app"] })).toThrow();
});
test("cloud rejects local credentials, cookies, anonymous callbacks and unapproved destinations", async () => {
  configureCloud(deployment.cloud);
  const auth = new BotAuthentication([{ ownerId: "owner", principal: "owner", projectId: "workspace", token: "legacy-token" }]);
  const request = new Request("https://RUNTIME_SERVICE.run.app/api/bots", { headers: { Authorization: "Bearer legacy-token", Cookie: "hermes_session=local" } });
  expect(auth.authenticate(request)).toBeUndefined();
  expect(auth.login(request, "legacy-token").status).toBe(404);
  expect(await authenticateBrowser(new Request(request.url))).toBe(false);
  expect(await authenticateService(new Request("https://RUNTIME_SERVICE.run.app/internal/graph/completions"))).toBe(false);
  expect(sameOrigin(new Request(request.url, { headers: { Origin: "https://preview.vercel.app" } }))).toBe(false);
  expect(sameOrigin(new Request(request.url, { headers: { Origin: "https://YOUR_APP.vercel.app" } }))).toBe(true);
  await expect(hostFetch("https://attacker.example/internal/bots")).rejects.toThrow("Host destination denied");
});

test("Firebase Admin failures, expiry and server membership gate the existing ACL", async () => {
  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  configureCloud(deployment.cloud);
  const projectId = deployment.cloud.firebaseProject;
  const name = `hermes-${projectId}`;
  const app = getApps().find(app => app.name === name) ?? initializeApp({ projectId }, name);
  const now = Math.floor(Date.now() / 1000);
  const verify = vi.spyOn(getAuth(app), "verifyIdToken").mockImplementation(async token => {
    if (["wrong-audience", "bad-signature"].includes(token)) throw new Error("Firebase rejected token");
    return { sub: token === "unlisted" ? "unlisted" : "FIREBASE_UID", exp: token === "expired" ? now - 1 : now + 600,
      auth_time: now, uid: "FIREBASE_UID", aud: projectId, iat: now, iss: `https://securetoken.google.com/${projectId}` } as any;
  });
  const request = (value: string) => new Request("https://RUNTIME_SERVICE.run.app/api/bots", { headers: { Authorization: `Bearer ${value}`, Origin: "https://YOUR_APP.vercel.app" } });
  const valid = request("valid");
  expect(await authenticateBrowser(valid)).toBe(true);
  const auth = new BotAuthentication([{ token: "", ownerId: "owner", principal: "owner", projectId: "workspace" }]);
  expect(auth.authenticate(valid)?.principal).toBe("owner");
  for (const invalid of ["expired", "wrong-audience", "unlisted", "bad-signature"]) {
    expect(await authenticateBrowser(request(invalid))).toBe(false);
  }
  expect(verify).toHaveBeenCalledTimes(5);
});

test("Host transport keeps business authorization separate from ADC IAM identity", async () => {
  const { GoogleAuth } = await import("google-auth-library");
  vi.spyOn(GoogleAuth.prototype, "getIdTokenClient").mockResolvedValue({ getRequestHeaders: async () => new Headers({ authorization: "Bearer google-id-token" }) } as any);
  const transport = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", transport);
  configureCloud(deployment.cloud);
  await hostFetch("https://HOST_SERVICE.run.app/internal/bots/a", { headers: { Authorization: "Bearer management-credential" } });
  const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer management-credential");
  expect(headers.get("X-Serverless-Authorization")).toBe("Bearer google-id-token");
  vi.unstubAllGlobals();
});

test("production cloud mode rejects Firebase emulator bypass", () => {
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
  expect(() => configureCloud(deployment.cloud)).toThrow("forbids emulator");
  vi.unstubAllEnvs();
});

test("public Runtime callback requires the verified service audience and allowlisted identity", async () => {
  const { OAuth2Client } = await import("google-auth-library");
  configureCloud(deployment.cloud);
  const now = Math.floor(Date.now() / 1000);
  const verify = vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(async options => {
    expect(options.audience).toBe(deployment.cloud.serviceAudience);
    if (options.idToken === "wrong-audience") throw new Error("audience rejected");
    return { getPayload: () => ({ exp: options.idToken === "expired" ? now - 1 : now + 600,
      iss: options.idToken === "wrong-issuer" ? "https://untrusted.example" : "https://accounts.google.com",
      email_verified: options.idToken !== "unverified", email: options.idToken === "unlisted" ? "other@example.test" : deployment.cloud.serviceAccounts[0],
    }) } as any;
  });
  const request = (token: string, origin = false) => new Request("https://RUNTIME_SERVICE.run.app/internal/graph/completions", {
    headers: { "X-Hermes-Service-Identity": token, ...(origin ? { Origin: deployment.cloud.origins[0] } : {}) },
  });
  expect(await authenticateService(request("valid"))).toBe(true);
  for (const token of ["wrong-audience", "expired", "wrong-issuer", "unverified", "unlisted"]) {
    expect(await authenticateService(request(token))).toBe(false);
  }
  expect(await authenticateService(request("valid", true))).toBe(false);
  expect(verify).toHaveBeenCalledTimes(6);
});

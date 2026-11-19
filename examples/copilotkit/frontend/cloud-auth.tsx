import { useState, type ReactNode } from "react";
const env = import.meta.env;
const api = env.VITE_RUNTIME_URL as string | undefined;
const apiKey = env.VITE_FIREBASE_API_KEY as string | undefined;
export const cloudEnabled = !!api;
const nativeFetch = globalThis.fetch.bind(globalThis);
let session: { idToken: string; refreshToken: string; expires: number } | undefined;
let refresh: Promise<void> | undefined;
let sessionVersion = 0;
async function bearer() {
  if (!session) throw new Error("請先登入");
  if (session.expires < Date.now() + 60000) {
    refresh ??= (async () => {
      const version = sessionVersion;
      const response = await nativeFetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey!)}`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session!.refreshToken }),
      });
      if (!response.ok) { session = undefined; throw new Error("登入已過期，請重新登入"); }
      const value = await response.json();
      if (version !== sessionVersion) throw new Error("登入狀態已改變");
      session = { idToken: value.id_token, refreshToken: value.refresh_token, expires: Date.now() + Number(value.expires_in) * 1000 };
    })().finally(() => { refresh = undefined; });
    await refresh;
  }
  return session!.idToken;
}
/** One authenticated transport covers CopilotKit streams and the existing management/Graph fetches. */
if (api) {
  if (!apiKey || new URL(api).protocol !== "https:") throw new Error("Configure HTTPS Runtime URL and Firebase client API key");
  globalThis.fetch = async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input), location.href);
    const isApi = original.pathname.startsWith("/api/") && [location.origin, new URL(api).origin].includes(original.origin);
    if (!isApi) return nativeFetch(input, init);
    const target = new URL(original.pathname + original.search, api);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Authorization", `Bearer ${await bearer()}`);
    return nativeFetch(input instanceof Request ? new Request(target, input) : target, { ...init, headers, credentials: "omit", redirect: "error" });
  };
}
export function CloudLogin({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  if (!cloudEnabled) return children;
  if (signedIn) return <><button onClick={() => { sessionVersion++; session = undefined; setSignedIn(false); }}>登出</button>{children}</>;
  return <form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await nativeFetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey!)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      if (!response.ok) throw new Error("登入失敗");
      const value = await response.json();
      sessionVersion++;
      session = { idToken: value.idToken, refreshToken: value.refreshToken, expires: Date.now() + Number(value.expiresIn) * 1000 };
      setPassword(""); setSignedIn(true);
    } catch { setError("登入失敗，請確認帳號與 Firebase 設定"); }
    finally { setBusy(false); }
  }}><h1>Hermes Workspace</h1>
    <label>Email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>密碼<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    <button disabled={busy}>登入</button>{error && <p role="alert">{error}</p>}
  </form>;
}

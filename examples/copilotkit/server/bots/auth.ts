import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Identity } from "./types";
export interface UserCredential extends Identity { token: string }
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export class BotAuthentication {
  private sessions = new Map<string, { identity: Identity; expires: number }>();
  constructor(private users: UserCredential[]) {
    if (users.some(user => users.some(other => user.ownerId === other.ownerId && user.principal !== other.principal))) {
      throw new Error("An owner must map to one authenticated principal");
    }
    if (!users.length || users.some(u => !u.token || !u.ownerId || !u.principal || !u.projectId) ||
      new Set(users.map(u => u.token)).size !== users.length) throw new Error("Configure unique Bot user credentials");
  }
  authenticate(request: Request): Identity | undefined {
    const authorization = request.headers.get("authorization") ?? "";
    const user = this.users.find(user => equal(authorization, `Bearer ${user.token}`));
    if (user) return { ownerId: user.ownerId, principal: user.principal, projectId: user.projectId };
    const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("hermes_session="))?.slice(15);
    const session = cookie ? this.sessions.get(cookie) : undefined;
    return session && session.expires > Date.now() ? session.identity : undefined;
  }
  login(request: Request, token: string): Response {
    const user = this.users.find(user => equal(token, user.token));
    if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
    for (const [id, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 1024) return Response.json({ error: "Session capacity reached" }, { status: 503 });
    const session = randomBytes(32).toString("hex");
    const { ownerId, principal, projectId } = user;
    this.sessions.set(session, { identity: { ownerId, principal, projectId }, expires: Date.now() + 8 * 3600_000 });
    return Response.json({ ownerId, projectId }, { headers: { "Set-Cookie":
      `hermes_session=${session}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${new URL(request.url).protocol === "https:" ? "; Secure" : ""}` } });
  }
}

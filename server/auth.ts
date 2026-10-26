import { NextFunction, Request, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { LocalStore, Role, StoredUser } from "./store";

export type Principal = { kind: "user" | "api_key"; id: number; name: string; role: Role };
const jwtSecret = () => new TextEncoder().encode(process.env.CASAMBI_JWT_SECRET || process.env.JWT_SECRET || "development-only-change-me");

/** Signs a short-lived local JWT for the Raspberry Pi appliance. `tv` ties it to the account's current token version. */
export async function issueToken(user: StoredUser, store: LocalStore): Promise<string> {
  return new SignJWT({ username: user.username, role: user.role, kind: "user", tv: store.tokenVersion(user.id) })
    .setProtectedHeader({ alg: "HS256" }).setSubject(String(user.id)).setIssuedAt().setExpirationTime("8h").sign(jwtSecret());
}

/** Resolves either a signed browser JWT or a revocable API key to a principal. */
export async function authenticate(request: Request, store: LocalStore): Promise<Principal | null> {
  const apiKey = request.header("x-api-key");
  if (apiKey) {
    const key = store.authenticateApiKey(apiKey);
    if (key) return { kind: "api_key", id: key.id, name: `api-key:${key.label}`, role: key.role };
  }
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  try {
    const result = await jwtVerify(authorization.slice(7), jwtSecret(), { algorithms: ["HS256"] });
    if (result.payload.kind !== "user" || !result.payload.sub) return null;
    // Re-read the account: a role change, password reset, or removed account takes effect immediately, not when the 8 h token expires.
    const user = store.getUserById(Number(result.payload.sub));
    if (!user || (result.payload.tv ?? 0) !== store.tokenVersion(user.id)) return null;
    return { kind: "user", id: user.id, name: user.username, role: user.role };
  } catch { return null; }
}

/** Middleware factory guarding routes by local appliance role. */
export function requireAuth(store: LocalStore, role?: Role) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const principal = await authenticate(request, store);
    if (!principal) return response.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid JWT or API key is required." } });
    if (role === "admin" && principal.role !== "admin") return response.status(403).json({ error: { code: "FORBIDDEN", message: "admin role is required." } });
    response.locals.principal = principal;
    return next();
  };
}

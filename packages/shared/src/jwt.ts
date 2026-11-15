import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { TOKEN_AUDIENCE, TOKEN_ISSUER, TOKEN_TTL_SECONDS } from "./constants";

/** Claims we accept after decoding (section 9: "JWT claims: shape check"). */
export const AccessClaims = z.object({
  sub: z.string().uuid(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});
export type AccessClaims = z.infer<typeof AccessClaims>;

const key = (secret: string) => new TextEncoder().encode(secret);

/** Short-lived token. The web app mints it from a valid NextAuth session. */
export async function signAccessToken(
  secret: string,
  claims: AccessClaims,
  ttlSeconds = TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

/** Throws on bad signature, wrong issuer/audience, expiry, or bad claim shape. */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ["HS256"],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
  return AccessClaims.parse(payload);
}

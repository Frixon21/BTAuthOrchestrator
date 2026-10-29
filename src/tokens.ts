import { importPKCS8, SignJWT } from "jose";

export interface SessionIdentityClaims {
  sub: string;
  email: string;
  upn: string;
  btv?: number;
}

export interface TokenSigningKey {
  kid: string;
  algorithm: string;
  privateKeyPem: string;
}

export async function mintSessionToken(
  claims: SessionIdentityClaims,
  signingKey: TokenSigningKey,
  issuer: string,
  now: Date | number,
): Promise<string> {
  if (signingKey.algorithm !== "RS256") {
    throw new Error(`Unsupported signing algorithm: ${signingKey.algorithm}`);
  }
  const nowDate = typeof now === "number" ? new Date(now) : new Date(now.getTime());
  if (!Number.isFinite(nowDate.getTime())) throw new Error("Invalid token issuance time.");

  const iat = Math.floor(nowDate.getTime() / 1_000);
  const exp = nextLocalMidnightEpochSeconds(nowDate);
  const privateKey = await importPKCS8(signingKey.privateKeyPem, "RS256");

  return new SignJWT({ sub: claims.sub, email: claims.email, upn: claims.upn, ...(claims.btv === undefined ? {} : { btv: claims.btv }) })
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(issuer)
    .sign(privateKey);
}

export function nextLocalMidnightEpochSeconds(now: Date | number): number {
  const issuance = typeof now === "number" ? new Date(now) : new Date(now.getTime());
  if (!Number.isFinite(issuance.getTime())) throw new Error("Invalid token issuance time.");

  const midnight = new Date(issuance.getTime());
  midnight.setHours(24, 0, 0, 0);
  const exp = Math.floor(midnight.getTime() / 1_000);
  const iat = Math.floor(issuance.getTime() / 1_000);
  if (exp <= iat) throw new Error("Token expiration must be after issuance.");
  return exp;
}

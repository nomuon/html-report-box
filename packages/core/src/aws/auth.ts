/**
 * CognitoAuthVerifier — AuthVerifier backed by aws-jwt-verify.
 *
 * Verifies the Cognito ID token from "Authorization: Bearer <jwt>" (the ID
 * token carries the display name; the access token does not). Admin status
 * comes from membership of the "admin" group in the "cognito:groups" claim.
 * The verifier is injectable so unit tests never fetch a real JWKS.
 *
 * Self-contained in @hrb/core (no api-package dependency).
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { AuthConfig } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { AuthUser, AuthVerifier } from "../ports.ts";

export const COGNITO_ADMIN_GROUP = "admin";
export const GROUPS_CLAIM = "cognito:groups";

export interface CognitoIdTokenPayload {
  sub: string;
  name?: string;
  email?: string;
  [claim: string]: unknown;
}

/** What CognitoAuthVerifier needs from aws-jwt-verify (fake-able in tests). */
export interface JwtVerifierLike {
  verify(token: string): Promise<CognitoIdTokenPayload>;
}

/** "ap-northeast-1_AbCdEf" → "ap-northeast-1". */
export function regionFromUserPoolId(userPoolId: string): string {
  const sep = userPoolId.indexOf("_");
  if (sep <= 0) {
    throw new DomainError("internal", `cannot derive region from user pool id: ${userPoolId}`);
  }
  return userPoolId.slice(0, sep);
}

export interface CognitoAuthVerifierOptions {
  userPoolId: string;
  clientId: string;
  /** Hosted UI domain advertised in GET /config. */
  domain: string;
  /** Defaults to the user pool id's region prefix. */
  region?: string;
  adminGroup?: string;
  /** Injectable for tests; defaults to a real aws-jwt-verify ID-token verifier. */
  verifier?: JwtVerifierLike;
}

export class CognitoAuthVerifier implements AuthVerifier {
  private readonly userPoolId: string;
  private readonly clientId: string;
  private readonly domain: string;
  private readonly region: string;
  private readonly adminGroup: string;
  private readonly verifier: JwtVerifierLike;

  constructor(options: CognitoAuthVerifierOptions) {
    this.userPoolId = options.userPoolId;
    this.clientId = options.clientId;
    this.domain = options.domain;
    this.region = options.region ?? regionFromUserPoolId(options.userPoolId);
    this.adminGroup = options.adminGroup ?? COGNITO_ADMIN_GROUP;
    this.verifier =
      options.verifier ??
      (CognitoJwtVerifier.create({
        userPoolId: options.userPoolId,
        clientId: options.clientId,
        tokenUse: "id",
      }) as unknown as JwtVerifierLike);
  }

  async verify(headers: Record<string, string | undefined>): Promise<AuthUser | null> {
    const header = headers["authorization"];
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    const token = match?.[1];
    if (!token) return null;

    let payload: CognitoIdTokenPayload;
    try {
      payload = await this.verifier.verify(token);
    } catch {
      // Expired / malformed / wrong audience — treated as unauthenticated;
      // routes decide whether that is fatal.
      return null;
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

    const rawGroups = payload[GROUPS_CLAIM];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === "string")
      : [];
    const name =
      (typeof payload.name === "string" && payload.name.length > 0 && payload.name) ||
      (typeof payload.email === "string" && payload.email.length > 0 && payload.email) ||
      payload.sub;

    return {
      sub: payload.sub,
      name,
      isAdmin: groups.includes(this.adminGroup),
    };
  }

  authConfig(): AuthConfig {
    return {
      mode: "cognito",
      region: this.region,
      userPoolId: this.userPoolId,
      clientId: this.clientId,
      domain: this.domain,
    };
  }
}

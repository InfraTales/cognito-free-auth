import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { JwksCache } from 'aws-jwt-verify/jwk';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';

/** Cognito tokens are about 1 KB. Anything far bigger isn't one, so don't spend CPU on it. */
export const MAX_TOKEN_LENGTH = 8192;

/**
 * Seconds of clock difference we tolerate on exp and nbf. Lambda and Cognito keep accurate
 * clocks, so this only covers a token that expires while the request is in flight.
 */
export const CLOCK_SKEW_SECONDS = 5;

export interface VerifierOptions {
  userPoolId: string;
  clientId: string;
  /** Tests pass a cache whose fetcher points at a local JWKS server. */
  jwksCache?: JwksCache;
}

export interface Caller {
  sub: string;
  username: string;
  scopes: string[];
}

export type AccessTokenVerifier = { verify(token: string): Promise<CognitoAccessTokenPayload> };

/**
 * One verifier per Lambda environment. It downloads the user pool's public keys (JWKS) on
 * first use and keeps them in memory. It fetches again only when a token names a key ID it
 * hasn't seen, which is how Cognito key rotation reaches us.
 */
export function createAccessTokenVerifier(opts: VerifierOptions): AccessTokenVerifier {
  return CognitoJwtVerifier.create(
    {
      userPoolId: opts.userPoolId,
      // Access tokens only. An ID token proves who signed in, to the app that asked for it.
      // It isn't meant as an API credential, and it carries aud instead of client_id.
      tokenUse: 'access',
      // Tokens issued to other app clients in the same pool are refused.
      clientId: opts.clientId,
      graceSeconds: CLOCK_SKEW_SECONDS,
    },
    opts.jwksCache ? { jwksCache: opts.jwksCache } : undefined,
  );
}

/**
 * Pulls the token out of "Authorization: Bearer <token>". The scheme name is case-insensitive
 * (RFC 9110), and function URLs pass header names in lowercase.
 */
export function bearerToken(headers: Record<string, string | undefined> | undefined): string | undefined {
  const value = headers?.authorization;
  if (!value) return undefined;
  const match = /^bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/i.exec(value.trim());
  if (!match?.[1] || match[1].length > MAX_TOKEN_LENGTH) return undefined;
  return match[1];
}

export async function authenticate(verifier: AccessTokenVerifier, token: string): Promise<Caller> {
  const payload = await verifier.verify(token);
  return {
    sub: payload.sub,
    username: payload.username,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
  };
}

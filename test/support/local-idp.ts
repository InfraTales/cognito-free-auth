/**
 * A stand-in for the parts of Cognito that token verification touches: RSA signing keys and an
 * HTTPS endpoint that serves the public half as a JWKS. Tokens are signed here with the claims
 * Cognito puts in real access and ID tokens, so the real aws-jwt-verify code checks them.
 */
import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SimpleFetcher } from 'aws-jwt-verify/https';
import { SimpleJwksCache, SimplePenaltyBox } from 'aws-jwt-verify/jwk';

export const REGION = 'us-east-1';
export const USER_POOL_ID = 'us-east-1_TestPool1';
export const CLIENT_ID = 'testclientid1234567890abcd';
export const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

export function newSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signJwt(key: SigningKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const data = `${b64url({ kid: key.kid, alg: 'RS256', ...header })}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(data).sign(key.privateKey).toString('base64url');
  return `${data}.${signature}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Claims shaped like a Cognito access token from the SRP or USER_AUTH flow. */
export function accessClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    sub: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    iss: ISSUER,
    client_id: CLIENT_ID,
    origin_jti: 'origin-jti-1',
    event_id: 'event-1',
    token_use: 'access',
    scope: 'aws.cognito.signin.user.admin',
    auth_time: now,
    exp: now + 900,
    iat: now,
    jti: 'jti-1',
    username: 'alice',
    ...overrides,
  };
}

/** Claims shaped like a Cognito ID token. Note aud instead of client_id. */
export function idClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    sub: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    email_verified: true,
    iss: ISSUER,
    'cognito:username': 'alice',
    origin_jti: 'origin-jti-1',
    aud: CLIENT_ID,
    event_id: 'event-1',
    token_use: 'id',
    auth_time: now,
    exp: now + 900,
    iat: now,
    jti: 'jti-2',
    email: 'alice@example.com',
    ...overrides,
  };
}

/** HTTPS JWKS server on 127.0.0.1 with a throwaway self-signed certificate. */
export class LocalJwksServer {
  readonly keys: SigningKey[] = [];
  fetches = 0;
  private server?: Server;
  private dir?: string;
  private cert = '';
  private port = 0;

  constructor(...keys: SigningKey[]) {
    this.keys.push(...keys);
  }

  async start(): Promise<void> {
    this.dir = mkdtempSync(path.join(tmpdir(), 'jwks-'));
    const keyFile = path.join(this.dir, 'key.pem');
    const certFile = path.join(this.dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    this.cert = readFileSync(certFile, 'utf8');
    this.server = createServer({ key: readFileSync(keyFile), cert: this.cert }, (req, res) => {
      if (req.url === `/${USER_POOL_ID}/.well-known/jwks.json`) {
        this.fetches += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: this.keys.map((k) => k.publicJwk) }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * A JWKS cache that uses aws-jwt-verify's own HTTPS fetcher and penalty box. Only the host
   * changes: requests for Cognito's JWKS URL go to this server instead.
   */
  jwksCache(penaltySeconds = 10): SimpleJwksCache {
    const real = new SimpleFetcher({ defaultRequestOptions: { ca: this.cert } });
    const cognitoPrefix = `https://cognito-idp.${REGION}.amazonaws.com/`;
    return new SimpleJwksCache({
      penaltyBox: new SimplePenaltyBox({ waitSeconds: penaltySeconds }),
      fetcher: {
        fetch: (uri, options, data) => {
          if (!uri.startsWith(cognitoPrefix)) throw new Error(`unexpected JWKS URI ${uri}`);
          return real.fetch(`https://localhost:${this.port}/${uri.slice(cognitoPrefix.length)}`, options, data);
        },
      },
    });
  }
}

/**
 * Token verification against a local HTTPS JWKS server, with keys made in the test. The
 * verifier is the one the Lambda function uses: createAccessTokenVerifier with aws-jwt-verify's
 * real fetcher, cache and penalty box. Only the JWKS host differs.
 */
import { CLOCK_SKEW_SECONDS, createAccessTokenVerifier, type AccessTokenVerifier } from '../../src/auth';
import {
  CLIENT_ID,
  LocalJwksServer,
  USER_POOL_ID,
  accessClaims,
  idClaims,
  newSigningKey,
  signJwt,
} from '../support/local-idp';

const key1 = newSigningKey('key-1');
const server = new LocalJwksServer(key1);
let verifier: AccessTokenVerifier;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  // A fresh cache per test, so each one starts like a cold Lambda environment.
  verifier = createAccessTokenVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, jwksCache: server.jwksCache() });
  server.fetches = 0;
});
afterEach(() => jest.restoreAllMocks());

const rejection = async (token: string) => {
  try {
    await verifier.verify(token);
  } catch (err) {
    return (err as Error).constructor.name;
  }
  throw new Error('token was accepted');
};

test('accepts a valid access token and returns its claims', async () => {
  const payload = await verifier.verify(signJwt(key1, accessClaims()));
  expect(payload).toMatchObject({ sub: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', username: 'alice', token_use: 'access' });
});

test('downloads the JWKS once and reuses it', async () => {
  for (let i = 0; i < 5; i++) await verifier.verify(signJwt(key1, accessClaims({ jti: `jti-${i}` })));
  expect(server.fetches).toBe(1);
});

test('refuses a token from another user pool (wrong issuer)', async () => {
  const otherPool = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool';
  // aws-jwt-verify 5 accepts two issuer spellings per pool, so it looks the issuer up in a list.
  // An unknown issuer surfaces as ParameterValidationError, not JwtInvalidIssuerError.
  await expect(verifier.verify(signJwt(key1, accessClaims({ iss: otherPool })))).rejects.toThrow(
    `issuer not configured: ${otherPool}`,
  );
  expect(server.fetches).toBe(0); // refused before any key download
});

test('refuses a token issued to a different app client', async () => {
  expect(await rejection(signJwt(key1, accessClaims({ client_id: 'someotherclient' })))).toBe('CognitoJwtInvalidClientIdError');
});

test('refuses an ID token sent as an access token', async () => {
  expect(await rejection(signJwt(key1, idClaims()))).toBe('CognitoJwtInvalidTokenUseError');
});

test('refuses an ID token even when someone adds client_id to it', async () => {
  expect(await rejection(signJwt(key1, idClaims({ client_id: CLIENT_ID })))).toBe('CognitoJwtInvalidTokenUseError');
});

test('refuses an expired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  expect(await rejection(signJwt(key1, accessClaims({ iat: now - 3600, exp: now - 60 })))).toBe('JwtExpiredError');
});

test('refuses a token whose payload was changed after signing', async () => {
  const [header, , signature] = signJwt(key1, accessClaims()).split('.');
  const forged = Buffer.from(JSON.stringify(accessClaims({ sub: 'someone-else' }))).toString('base64url');
  expect(await rejection(`${header}.${forged}.${signature}`)).toBe('JwtInvalidSignatureError');
});

test('refuses a token signed by a different key that reuses a known kid', async () => {
  const attacker = newSigningKey('key-1');
  expect(await rejection(signJwt(attacker, accessClaims()))).toBe('JwtInvalidSignatureError');
});

test('refuses unsigned and HMAC tokens (algorithm confusion)', async () => {
  const none = signJwt(key1, accessClaims(), { alg: 'none' });
  const hmac = signJwt(key1, accessClaims(), { alg: 'HS256' });
  expect(await rejection(none)).toMatch(/Jwt(InvalidSignatureAlgorithm|Parse)Error/);
  expect(await rejection(hmac)).toMatch(/Jwt(InvalidSignatureAlgorithm|Parse)Error/);
});

describe('key rotation and unknown key IDs', () => {
  test('fetches the JWKS again when a token names a new key, then caches that too', async () => {
    await verifier.verify(signJwt(key1, accessClaims()));
    const key2 = newSigningKey('key-2');
    server.keys.push(key2); // Cognito publishes the new key
    try {
      await verifier.verify(signJwt(key2, accessClaims()));
      await verifier.verify(signJwt(key2, accessClaims({ jti: 'again' })));
      expect(server.fetches).toBe(2);
    } finally {
      server.keys.pop();
    }
  });

  test('a made-up kid costs one fetch, then the penalty box blocks more fetches', async () => {
    const stranger = newSigningKey('not-in-jwks');
    expect(await rejection(signJwt(stranger, accessClaims()))).toBe('KidNotFoundInJwksError');
    expect(await rejection(signJwt(stranger, accessClaims()))).toBe('WaitPeriodNotYetEndedJwkError');
    expect(await rejection(signJwt(stranger, accessClaims()))).toBe('WaitPeriodNotYetEndedJwkError');
    expect(server.fetches).toBe(1);
  });

  test('valid tokens still pass while an unknown kid is in the penalty box', async () => {
    await verifier.verify(signJwt(key1, accessClaims())); // warm the cache
    await rejection(signJwt(newSigningKey('nope'), accessClaims()));
    await expect(verifier.verify(signJwt(key1, accessClaims()))).resolves.toBeDefined();
  });
});

describe('clock skew', () => {
  const at = (offsetSeconds: number) => {
    const token = signJwt(key1, accessClaims({ exp: 2_000_000_000, iat: 2_000_000_000 - 900 }));
    jest.spyOn(Date, 'now').mockReturnValue((2_000_000_000 + offsetSeconds) * 1000);
    return token;
  };

  test(`accepts a token that expired up to ${CLOCK_SKEW_SECONDS} seconds ago`, async () => {
    await expect(verifier.verify(at(CLOCK_SKEW_SECONDS - 1))).resolves.toBeDefined();
  });

  test(`refuses a token that expired more than ${CLOCK_SKEW_SECONDS} seconds ago`, async () => {
    expect(await rejection(at(CLOCK_SKEW_SECONDS + 1))).toBe('JwtExpiredError');
  });

  test('tolerates a not-before time a few seconds ahead, but not a minute ahead', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verifier.verify(signJwt(key1, accessClaims({ nbf: now + 2 })))).resolves.toBeDefined();
    expect(await rejection(signJwt(key1, accessClaims({ nbf: now + 60 })))).toBe('JwtNotBeforeError');
  });
});

/**
 * The handler end to end, with the real verifier and local JWKS server, and an in-memory notes
 * store. test/local runs the same flows against DynamoDB Local.
 */
import { createApi } from '../../src/api';
import { bearerToken, createAccessTokenVerifier, MAX_TOKEN_LENGTH } from '../../src/auth';
import { MAX_NOTE_LENGTH } from '../../src/notes';
import { CLIENT_ID, LocalJwksServer, USER_POOL_ID, accessClaims, idClaims, newSigningKey, signJwt } from '../support/local-idp';
import { request } from '../support/events';
import { MemoryNotes } from '../support/memory-notes';

const key = newSigningKey('key-1');
const server = new LocalJwksServer(key);
beforeAll(() => server.start());
afterAll(() => server.stop());

const ALICE = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const BOB = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const tokenFor = (sub: string, extra: Record<string, unknown> = {}) => signJwt(key, accessClaims({ sub, ...extra }));

function setup() {
  const logs: Record<string, unknown>[] = [];
  const notes = new MemoryNotes();
  const handle = createApi({
    verifier: createAccessTokenVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, jwksCache: server.jwksCache() }),
    notes,
    log: (e) => logs.push(e),
  });
  return { handle, notes, logs };
}

const body = (res: { body?: string }) => JSON.parse(res.body ?? '{}');

test('GET /me returns who the token belongs to', async () => {
  const { handle } = setup();
  const res = await handle(request('GET', '/me', tokenFor(ALICE)));
  expect(res.statusCode).toBe(200);
  expect(body(res)).toEqual({ sub: ALICE, username: 'alice', scopes: ['aws.cognito.signin.user.admin'] });
  expect(res.headers?.['cache-control']).toBe('no-store');
});

test('no token gets 401 with a Bearer challenge', async () => {
  const { handle } = setup();
  const res = await handle(request('GET', '/me'));
  expect(res.statusCode).toBe(401);
  expect(res.headers?.['www-authenticate']).toBe('Bearer');
});

test('a bad token gets 401 invalid_token, and the log says why without the token', async () => {
  const { handle, logs } = setup();
  const token = signJwt(key, idClaims({ sub: ALICE }));
  const res = await handle(request('GET', '/notes', token));
  expect(res.statusCode).toBe(401);
  expect(res.headers?.['www-authenticate']).toBe('Bearer error="invalid_token"');
  expect(logs).toEqual([{ msg: 'token rejected', reason: 'CognitoJwtInvalidTokenUseError' }]);
  expect(JSON.stringify(logs)).not.toContain(token.split('.')[2]);
});

test('an expired token never reaches the data store', async () => {
  const { handle, notes } = setup();
  const now = Math.floor(Date.now() / 1000);
  const res = await handle(request('GET', '/notes', tokenFor(ALICE, { iat: now - 3600, exp: now - 600 })));
  expect(res.statusCode).toBe(401);
  expect(notes.calls).toBe(0);
});

test('each user sees and deletes only their own notes', async () => {
  const { handle } = setup();
  const created = await handle(request('POST', '/notes', tokenFor(ALICE), { text: 'alice secret' }));
  expect(created.statusCode).toBe(201);
  const { id } = body(created);

  expect(body(await handle(request('GET', '/notes', tokenFor(BOB))))).toEqual({ notes: [] });
  expect((await handle(request('DELETE', `/notes/${id}`, tokenFor(BOB)))).statusCode).toBe(404);

  const aliceNotes = body(await handle(request('GET', '/notes', tokenFor(ALICE)))).notes;
  expect(aliceNotes).toHaveLength(1);
  expect(aliceNotes[0]).toMatchObject({ id, text: 'alice secret' });
  expect((await handle(request('DELETE', `/notes/${id}`, tokenFor(ALICE)))).statusCode).toBe(204);
});

test.each([
  ['no body', undefined],
  ['not JSON', 'not json'],
  ['empty text', { text: '   ' }],
  ['text too long', { text: 'x'.repeat(MAX_NOTE_LENGTH + 1) }],
  ['wrong type', { text: 42 }],
])('POST /notes refuses %s', async (_name, payload) => {
  const { handle } = setup();
  const event = request('POST', '/notes', tokenFor(ALICE));
  event.body = typeof payload === 'string' ? payload : payload === undefined ? undefined : JSON.stringify(payload);
  expect((await handle(event)).statusCode).toBe(400);
});

test('a malformed note ID is a 404 and never reaches the store', async () => {
  const { handle, notes } = setup();
  expect((await handle(request('DELETE', '/notes/..%2Fother', tokenFor(ALICE)))).statusCode).toBe(404);
  expect(notes.calls).toBe(0);
});

test('a store failure is a 500 with no details', async () => {
  const { handle, notes, logs } = setup();
  notes.failNext = true;
  const res = await handle(request('GET', '/notes', tokenFor(ALICE)));
  expect(res.statusCode).toBe(500);
  expect(body(res)).toEqual({ message: 'Internal error' });
  expect(logs).toEqual([{ msg: 'request failed', error: 'Error' }]);
});

test('unknown routes are 404 for signed-in users', async () => {
  const { handle } = setup();
  expect((await handle(request('GET', '/admin', tokenFor(ALICE)))).statusCode).toBe(404);
});

describe('bearerToken', () => {
  const jwt = 'aaa.bbb.ccc';
  test.each([
    [undefined, undefined],
    [{}, undefined],
    [{ authorization: jwt }, undefined],
    [{ authorization: `Basic ${jwt}` }, undefined],
    [{ authorization: `Bearer ${jwt} extra` }, undefined],
    [{ authorization: 'Bearer not-a-jwt' }, undefined],
    [{ authorization: `Bearer ${jwt}` }, jwt],
    [{ authorization: `bearer ${jwt}` }, jwt],
  ])('%j -> %s', (headers, expected) => {
    expect(bearerToken(headers)).toBe(expected);
  });

  test('ignores oversized tokens', () => {
    const big = `${'a'.repeat(MAX_TOKEN_LENGTH)}.b.c`;
    expect(bearerToken({ authorization: `Bearer ${big}` })).toBeUndefined();
  });
});

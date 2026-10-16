/**
 * The real handler, the real verifier with a local JWKS server, and the real NotesStore against
 * DynamoDB Local. Start it first: docker run -d -p 8014:8000 amazon/dynamodb-local:3.3.2
 * and set AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8014.
 */
import { randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { createApi } from '../../src/api';
import { createAccessTokenVerifier } from '../../src/auth';
import { NotesStore, PARTITION_KEY, SORT_KEY } from '../../src/notes';
import { request } from '../support/events';
import { CLIENT_ID, LocalJwksServer, USER_POOL_ID, accessClaims, newSigningKey, signJwt } from '../support/local-idp';

if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
  throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB to your DynamoDB Local URL, e.g. http://localhost:8014');
}

const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const table = `notes-${randomUUID()}`;
const key = newSigningKey('key-1');
const server = new LocalJwksServer(key);
const ALICE = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const BOB = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const tokenFor = (sub: string) => signJwt(key, accessClaims({ sub }));
const body = (res: { body?: string }) => JSON.parse(res.body ?? '{}');

let handle: ReturnType<typeof createApi>;

beforeAll(async () => {
  await server.start();
  await client.send(
    new CreateTableCommand({
      TableName: table,
      KeySchema: [
        { AttributeName: PARTITION_KEY, KeyType: 'HASH' },
        { AttributeName: SORT_KEY, KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: PARTITION_KEY, AttributeType: 'S' },
        { AttributeName: SORT_KEY, AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  handle = createApi({
    verifier: createAccessTokenVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, jwksCache: server.jwksCache() }),
    notes: new NotesStore(table, client),
    log: () => undefined,
  });
});

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: table }));
  await server.stop();
  client.destroy();
});

test('create, list newest first, delete', async () => {
  const first = body(await handle(request('POST', '/notes', tokenFor(ALICE), { text: 'one' })));
  await new Promise((r) => setTimeout(r, 5));
  const second = body(await handle(request('POST', '/notes', tokenFor(ALICE), { text: 'two' })));
  const listed = body(await handle(request('GET', '/notes', tokenFor(ALICE)))).notes;
  expect(listed.map((n: { id: string }) => n.id)).toEqual([second.id, first.id]);

  expect((await handle(request('DELETE', `/notes/${first.id}`, tokenFor(ALICE)))).statusCode).toBe(204);
  expect((await handle(request('DELETE', `/notes/${first.id}`, tokenFor(ALICE)))).statusCode).toBe(404);
});

test("one user can't read or delete another user's notes", async () => {
  const note = body(await handle(request('POST', '/notes', tokenFor(ALICE), { text: 'private' })));
  expect(body(await handle(request('GET', '/notes', tokenFor(BOB))))).toEqual({ notes: [] });
  expect((await handle(request('DELETE', `/notes/${note.id}`, tokenFor(BOB)))).statusCode).toBe(404);
  const stillThere = body(await handle(request('GET', '/notes', tokenFor(ALICE)))).notes;
  expect(stillThere.some((n: { id: string }) => n.id === note.id)).toBe(true);
});

test('50 concurrent creates by one user all land, each with its own ID', async () => {
  const carol = 'aaaaaaaa-bbbb-cccc-dddd-000000000003';
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => handle(request('POST', '/notes', tokenFor(carol), { text: `n${i}` }))),
  );
  expect(results.every((r) => r.statusCode === 201)).toBe(true);
  expect(new Set(results.map((r) => body(r).id)).size).toBe(50);
  expect(body(await handle(request('GET', '/notes', tokenFor(carol)))).notes).toHaveLength(50);
});

test('a colliding note ID is refused by the condition, never overwritten', async () => {
  const fixedNow = () => new Date('2026-10-15T00:00:00.000Z');
  const fixedId = () => '00000000-0000-4000-8000-000000000000';
  const store = new NotesStore(table, client, fixedNow, fixedId);
  const dave = 'aaaaaaaa-bbbb-cccc-dddd-000000000004';
  await store.create(dave, 'original');
  await expect(store.create(dave, 'overwrite attempt')).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  expect((await store.list(dave)).map((n) => n.text)).toEqual(['original']);
});

test('deleting a note that was never there reports false', async () => {
  const store = new NotesStore(table, client);
  expect(await store.delete(ALICE, `0000000000000-${randomUUID()}`)).toBe(false);
});

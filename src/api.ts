import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authenticate, bearerToken, type AccessTokenVerifier, type Caller } from './auth';
import { MAX_NOTE_LENGTH, NOTE_ID, type Notes } from './notes';

export interface Deps {
  verifier: AccessTokenVerifier;
  notes: Notes;
  log?: (entry: Record<string, unknown>) => void;
}

type Result = APIGatewayProxyStructuredResultV2;

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

// RFC 6750: say which scheme we expect, and for a bad token, that it was a bad token.
const unauthorized = (reason?: 'invalid_token') =>
  json(401, { message: 'Unauthorized' }, { 'www-authenticate': reason ? `Bearer error="${reason}"` : 'Bearer' });

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

/**
 * The whole API. Every route needs a valid Cognito access token, and every route works on the
 * caller's own data only, keyed by the token's `sub`.
 */
export function createApi(deps: Deps) {
  const log = deps.log ?? defaultLog;

  return async function handle(event: APIGatewayProxyEventV2): Promise<Result> {
    const token = bearerToken(event.headers);
    if (!token) return unauthorized();

    let caller: Caller;
    try {
      caller = await authenticate(deps.verifier, token);
    } catch (err) {
      // Log why, never the token. aws-jwt-verify's error classes leave `name` as "Error", so
      // the class name is what tells an expired token from a forged one.
      log({ msg: 'token rejected', reason: errorClass(err) });
      return unauthorized('invalid_token');
    }

    try {
      return await route(event, caller);
    } catch (err) {
      log({ msg: 'request failed', error: errorClass(err) });
      return json(500, { message: 'Internal error' });
    }
  };

  async function route(event: APIGatewayProxyEventV2, caller: Caller): Promise<Result> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (method === 'GET' && path === '/me') {
      return json(200, { sub: caller.sub, username: caller.username, scopes: caller.scopes });
    }
    if (method === 'GET' && path === '/notes') {
      return json(200, { notes: await deps.notes.list(caller.sub) });
    }
    if (method === 'POST' && path === '/notes') {
      const text = readText(event);
      if (text === undefined) {
        return json(400, { message: `Send JSON like {"text": "..."} with 1 to ${MAX_NOTE_LENGTH} characters` });
      }
      return json(201, await deps.notes.create(caller.sub, text));
    }
    const del = /^\/notes\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && del?.[1]) {
      const id = del[1];
      if (!NOTE_ID.test(id)) return json(404, { message: 'Not found' });
      return (await deps.notes.delete(caller.sub, id)) ? { statusCode: 204 } : json(404, { message: 'Not found' });
    }
    return json(404, { message: 'Not found' });
  }
}

const errorClass = (err: unknown) => (err instanceof Error ? err.constructor.name : 'unknown');

function readText(event: APIGatewayProxyEventV2): string | undefined {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const text = (parsed as { text?: unknown }).text;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_NOTE_LENGTH ? trimmed : undefined;
}

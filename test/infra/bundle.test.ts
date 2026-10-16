/**
 * Lambda loads index.js and calls index.handler. Check the bundle is one self-contained file,
 * and that it loads and answers the way the runtime would call it.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUNDLE_DIR } from '../../infra/lib/auth-stack';

test('index.js sits at the package root, with only its source map beside it', () => {
  expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
});

test('the bundle imports nothing outside Node.js itself', () => {
  // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain.
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const builtins = new Set(builtinModules);
  const external = Object.values(meta.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('the bundle includes aws-jwt-verify and the DynamoDB client', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  const inputs = Object.keys(meta.inputs);
  expect(inputs.some((i) => i.includes('node_modules/aws-jwt-verify/'))).toBe(true);
  expect(inputs.some((i) => i.includes('node_modules/@aws-sdk/client-dynamodb/'))).toBe(true);
});

describe('loading the bundle', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
  });

  test('exports a handler that refuses a request with no token, without network calls', async () => {
    process.env.USER_POOL_ID = 'us-east-1_Example1';
    process.env.USER_POOL_CLIENT_ID = 'exampleclientid';
    process.env.NOTES_TABLE = 'notes';
    const mod = require(path.join(BUNDLE_DIR, 'index.js'));
    expect(typeof mod.handler).toBe('function');
    const res = await mod.handler({ headers: {}, rawPath: '/me', requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(401);
  });

  test('fails at cold start, with the variable name, when config is missing', () => {
    delete process.env.USER_POOL_ID;
    process.env.USER_POOL_CLIENT_ID = 'exampleclientid';
    process.env.NOTES_TABLE = 'notes';
    jest.isolateModules(() => {
      expect(() => require(path.join(BUNDLE_DIR, 'index.js'))).toThrow('USER_POOL_ID');
    });
  });
});

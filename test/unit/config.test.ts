import { loadConfig, requireEnv } from '../../src/config';

const good = { USER_POOL_ID: 'eu-west-1_AbC123', USER_POOL_CLIENT_ID: 'client', NOTES_TABLE: 'notes' };

test('reads the three settings', () => {
  expect(loadConfig(good)).toEqual({ userPoolId: 'eu-west-1_AbC123', clientId: 'client', notesTable: 'notes' });
});

test.each(['USER_POOL_ID', 'USER_POOL_CLIENT_ID', 'NOTES_TABLE'])('names %s when it is missing or blank', (name) => {
  expect(() => loadConfig({ ...good, [name]: undefined })).toThrow(name);
  expect(() => loadConfig({ ...good, [name]: '  ' })).toThrow(name);
});

test.each(['client', 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbC123', 'us-east-1-AbC'])(
  'refuses a user pool ID that is really something else: %s',
  (value) => {
    expect(() => loadConfig({ ...good, USER_POOL_ID: value })).toThrow("doesn't look like a user pool ID");
  },
);

test('requireEnv returns the value as is', () => {
  expect(requireEnv('X', { X: 'value' })).toBe('value');
});

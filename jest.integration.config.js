// The real handler against DynamoDB Local and a local JWKS server. `npm run test:int`.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/local'],
  testMatch: ['**/*.int.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};

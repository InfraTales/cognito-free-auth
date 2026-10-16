module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // test/local runs against DynamoDB Local: `npm run test:int`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/local/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};

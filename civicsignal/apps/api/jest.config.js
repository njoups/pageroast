module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e)\\.ts$',
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
  // Test files share one PostgreSQL database and one Redis database (the scheduler test claims every due source),
  // so they must run serially however jest is invoked.
  maxWorkers: 1,
};

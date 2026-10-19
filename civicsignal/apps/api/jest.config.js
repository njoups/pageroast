module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e)\\.ts$',
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
};

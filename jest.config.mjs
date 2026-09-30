/**
 * Jest ESM config cho ag-render-worker.
 * Chạy bằng: node --experimental-vm-modules node_modules/.bin/jest
 * (đã khai trong npm scripts "test")
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  rootDir: 'src',
  testMatch: ['**/__tests__/**/*.test.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
      },
    ],
  },
  moduleNameMapper: {
    // Map .js extensions back to .ts sources (ESM import style).
    // Exclude paths that go through node_modules (they're real .js files).
    '^(\\.{1,2}/(?!.*node_modules).*)\\.js$': '$1',
  },
};

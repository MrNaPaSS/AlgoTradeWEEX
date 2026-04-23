/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.js'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/app.js',
        '!src/**/index.js'
    ],
    coverageThreshold: {
        global: {
            branches: 70,
            functions: 80,
            lines: 80,
            statements: 80
        }
    },
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
    setupFiles: ['<rootDir>/tests/helpers/setupEnv.js'],
    testTimeout: 15000,
    verbose: true,
    clearMocks: true,
    restoreMocks: true
};

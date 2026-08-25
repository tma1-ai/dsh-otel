import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    // The e2e tiers install the packed tarball and boot a real Loader; give
    // them room beyond the 5s default.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
})

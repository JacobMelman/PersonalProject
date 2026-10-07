import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
  define: { __E2E__: false },
});

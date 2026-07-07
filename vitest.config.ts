import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Top level only — fixture repos contain their own *.test.* files that are
    // test DATA, not tests of this package.
    include: ["test/*.test.ts"],
    testTimeout: 20000,
  },
});

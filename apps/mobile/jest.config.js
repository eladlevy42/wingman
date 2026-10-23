// Component/rendering tests for apps/mobile (#507, ADR-0035).
//
// This runner exists alongside Vitest rather than replacing it. Vitest owns the
// plain-TypeScript logic (`*.test.ts`); Jest owns anything that has to actually
// render (`*.test.tsx`), because React Native Testing Library needs a real
// React Native — Flow-typed source, lazy `require`s in `react-native/index.js`,
// and a native-module surface that only `jest-expo` assembles correctly. The
// two suites are split by file extension so neither can pick up the other's
// files.
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/**/*.test.tsx"],
  // Reanimated 4 delegates to react-native-worklets, whose `.native.ts` entry
  // calls into a real native module and crashes under Jest. The package ships
  // this resolver to route its own imports to the non-native implementations.
  resolver: "react-native-worklets/jest/resolver.js",
  moduleNameMapper: {
    "^~/(.*)$": "<rootDir>/$1",
    // lucide-react-native's `react-native` export condition points at a single
    // ESM barrel of every icon, which Jest cannot require and Babel spends ~45s
    // compiling on a cold cache. The package ships an equivalent CJS build, so
    // resolve to that instead of transforming the barrel.
    "^lucide-react-native$":
      "<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js",
  },
  // pnpm stores every package under `node_modules/.pnpm/<name>@<version>/`, and
  // then again under a nested `node_modules/<name>/`. jest-expo's default
  // pattern allows `.pnpm` through but re-tests at that nested segment, so any
  // package not on its list is ignored after all — which is why
  // `@rn-primitives/slot` arrived as raw JSX. Anchoring on `.pnpm/` gives one
  // decision per package. The segment straight after it is the package name
  // (scoped names use `+` in place of `/`). Everything listed ships
  // untranspiled JSX or Flow and must go through Babel.
  transformIgnorePatterns: [
    "node_modules/\\.pnpm/(?!(@react-native|@rn-primitives|@expo|expo|react-native|nativewind|react-native-css-interop))",
  ],
};

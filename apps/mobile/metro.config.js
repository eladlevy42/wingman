// Metro configuration for this pnpm/Turborepo monorepo.
//
// Two things differ from a standalone Expo app:
//  1. watchFolders must include the workspace root so Metro picks up changes in
//     packages/shared (which ships raw TypeScript — see its package.json "main":
//     "./src/index.ts" — so Metro, not tsc, is what transpiles it).
//  2. nodeModulesPaths must list both the app's own node_modules and the root's,
//     because pnpm hoists shared dependencies to the workspace root.
//
// Deliberately NOT setting resolver.disableHierarchicalLookup: Expo's monorepo
// guide recommends it, but that guide targets Yarn/npm workspaces where every
// dependency is hoisted flat. pnpm instead nests each package's deps behind
// symlinks in node_modules/.pnpm, which requires walking up from the requiring
// file — exactly what disabling hierarchical lookup prevents.
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// NativeWind compiles global.css (the design tokens) into the bundle and
// teaches Metro how to resolve className props.
module.exports = withNativeWind(config, { input: "./global.css" });

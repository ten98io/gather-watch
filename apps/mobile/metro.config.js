// Metro config for a pnpm monorepo (Expo SDK 53 / RN 0.79).
//
// Why this is non-default:
//  - pnpm installs workspace packages (@playin/*) as SYMLINKS from
//    apps/mobile/node_modules to ../../packages/*. Metro must watch the real
//    files, so the workspace root becomes a watchFolder.
//  - Resolution must try the app's own node_modules first (where expo, react,
//    react-native live), then the workspace root node_modules (where pnpm
//    hoists shared dev tooling). This is Expo's documented monorepo setup.
//  - RN 0.79 enables package `exports` by default; @playin/* publish
//    dist/{index.js,index.cjs} via exports, so `pnpm build` (turbo ^build)
//    must run before `expo start`. See README.md.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;

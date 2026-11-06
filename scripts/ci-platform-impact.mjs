import { isDeepStrictEqual } from 'node:util';

export const platforms = ['android', 'macos', 'linuxNode'];
// Reviewed implementation boundary: returns server-side execution health;
// wire schemas, authorization and native dispatch protocols live elsewhere.
const serverInternal = new Set(['item-execution-blockers.ts', 'item-execution-blockers.test.ts']);
const androidWeb = new Set(['android-bridge.ts', 'android-update.ts', 'android-update.test.ts',
  'AndroidUpdateNotice.tsx', 'SdkFeedback.tsx', 'overlay.tsx', 'App.tsx']);
const scripts = {
  android: ['publish-android-internal.sh', 'publish-android-sdk.sh', 'check-android-contract.mjs'],
  macos: ['build-macos-app.sh', 'sign-macos-app.sh', 'publish-macos.sh', 'macos-ci-cache.mjs',
    'macos-ci-cache.test.mjs', 'macos-ci-watchdog.py', 'macos-ci-watchdog.test.mjs', 'macos-permissions.test.mjs', 'check-macos-contract.mjs'],
  linuxNode: ['build-node.mjs', 'test-node-install.mjs', 'publish-linux.sh', 'publish-linux.mjs', 'linux-release-tools.mjs', 'linux-release.test.mjs', 'enable-linux-release.mjs'],
};

// null means evidence is not sufficiently narrow. Do not use release ledger
// paths here: artifact provenance and validation inputs are different contracts.
export function productPlatforms(before, after) {
  if (![before, after].every(v => v && typeof v === 'object' && !Array.isArray(v))) return null;
  const selected = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return null;
    if (['android', 'macos', 'linuxNode'].includes(key)) selected.add(key);
    else if (key === 'web' && [before.web, after.web].every(v => v && Object.keys(v).join() === 'version' && /^\d+\.\d+\.\d+$/.test(v.version))) continue;
    else return null;
  }
  return [...selected];
}

export function pathPlatforms(path) {
  if (/^(docs\/.*\.md|[^/]+\.md)$/.test(path)
    || /^docs\/review-evidence\/.*\.(png|jpg|jpeg|webp)$/.test(path)
    || /^release-notes\/web\/\d+\.\d+\.\d+\.md$/.test(path)
    || path.startsWith('tests/ui/')) return [];
  for (const [prefix, platform] of [['apps/android/', 'android'], ['sdks/android-feedback/', 'android'],
    ['apps/macos/', 'macos'], ['apps/node/', 'linuxNode']]) if (path.startsWith(prefix)) return [platform];
  for (const platform of platforms) if (scripts[platform].some(file => path === `scripts/${file}`)) return [platform];
  if (path.startsWith('services/server/src/') && serverInternal.has(path.slice('services/server/src/'.length))) return [];
  if (path.startsWith('apps/web/')) {
    // The macOS package reads the generated product icon from this tree.
    if (path.startsWith('apps/web/public/icon')) return ['android', 'macos'];
    if (path === 'apps/web/vite.config.ts' || androidWeb.has(path.slice('apps/web/src/'.length))) return ['android'];
    return [];
  }
  return null;
}

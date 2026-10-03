// Bundle the preload script as CommonJS.
//
// Why: package.json has "type": "module", so every .js file in dist-electron is
// treated as ESM. Electron loads preload scripts through its own loader which
// does NOT support `import` in .js preloads (and never in sandboxed ones), so
// `window.claw` was never defined and the UI could not talk to the main process.
// A `.cjs` bundle is always loaded as CommonJS regardless of "type".
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'electron/preload.ts')],
  outfile: join(root, 'dist-electron/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron'],
  logLevel: 'info',
});

// tsc also emits an ESM preload.js; it is never loaded, remove it to avoid confusion.
rmSync(join(root, 'dist-electron/preload.js'), { force: true });

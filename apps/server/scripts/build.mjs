// Bundle the server (including @salem/engine's TypeScript source) into one ESM file for Docker
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Real npm dependencies are installed at runtime with npm ci; only workspace code gets bundled
  external: ['@colyseus/*', 'express'],
  // Lets CommonJS dependencies inside the bundle still use require
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});

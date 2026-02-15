import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOOKS_DIR = path.join('src', 'hooks');
const OUT_DIR = 'dist';

// Find all hook entry points (files that don't start with _)
const hookFiles = fs.readdirSync(HOOKS_DIR)
  .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
  .map(f => path.join(HOOKS_DIR, f));

if (hookFiles.length === 0) {
  console.log('No hook entry points found in src/hooks/. Skipping build.');
  process.exit(0);
}

console.log(`Building ${hookFiles.length} hooks:`);
hookFiles.forEach(f => console.log(`  ${f}`));

await esbuild.build({
  entryPoints: hookFiles,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: OUT_DIR,
  outExtension: { '.js': '.mjs' },
  external: ['better-sqlite3'],
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

console.log('Build complete.');

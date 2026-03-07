import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = 'dist';

function discoverEntryPoints(dir: string, prefix?: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const entries: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.startsWith('_')) continue;
    const name = (prefix || '') + path.basename(f, '.ts');
    entries[name] = path.join(dir, f);
  }
  return entries;
}

// Additional CLI entry points (not hooks, but built alongside them)
const cliEntryPoints: Record<string, string> = {};
for (const file of [
  path.join('src', 'gsd', 'phase-transition-cli.ts'),
  path.join('src', 'cli', 'setup.ts'),
]) {
  if (fs.existsSync(file)) {
    cliEntryPoints[path.basename(file, '.ts')] = file;
  }
}

const namedEntryPoints: Record<string, string> = {
  ...discoverEntryPoints(path.join('src', 'hooks')),
  ...discoverEntryPoints(path.join('src', 'cm-adapter', 'hooks'), 'cm-'),
  ...cliEntryPoints,
};

// Check for duplicate names (would indicate a prefix collision)
const allEntryPoints = Object.values(namedEntryPoints);

if (allEntryPoints.length === 0) {
  console.log('No entry points found. Skipping build.');
  process.exit(0);
}

console.log(`Building ${allEntryPoints.length} entry points:`);
allEntryPoints.forEach(f => console.log(`  ${f}`));

await esbuild.build({
  entryPoints: namedEntryPoints,
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

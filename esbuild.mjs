import { build, context } from 'esbuild';
import { rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

// A visible build stamp, so which bundle Chrome is actually running is never
// a guess: it shows on the extension card and in every console line.
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

try {
  await rm('dist', { recursive: true, force: true });
} catch {
  // some sandboxed filesystems disallow unlink; esbuild overwrites in place
}
await mkdir('dist', { recursive: true });
// copy by content rather than cp(), which unlinks first and fails on read-restricted mounts
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await writeFile(dest, await readFile(src));
  }
}
await copyTree('public', 'dist');

{
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  manifest.version_name = `${manifest.version} · built ${stamp}`;
  await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}

const shared = {
  bundle: true,
  define: { __BUILD__: JSON.stringify(stamp) },
  target: 'chrome120',
  platform: 'browser',
  outdir: 'dist',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

const configs = [
  // service worker + extension pages load as ES modules
  {
    ...shared,
    format: 'esm',
    entryPoints: {
      background: 'src/background.js',
      options: 'src/options.js',
      popup: 'src/popup.js',
    },
  },
  // content scripts cannot be modules
  {
    ...shared,
    format: 'iife',
    entryPoints: { content: 'src/content.js', shield: 'src/shield.js' },
  },
];

if (watch) {
  for (const c of configs) {
    const ctx = await context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map(build));
  console.log(`\n  build stamp: ${stamp}\n`);
}

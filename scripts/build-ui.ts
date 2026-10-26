import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
export async function buildUI() {
  const input = path.resolve('src/ui/effects.tsx');
  const output = path.resolve('src/ui/vendor-effects.js');
  const newest = Math.max(...await Promise.all([input, 'src/ui/agent-progress.ts', 'src/ui/site-progress.ts', 'package-lock.json'].map(async file => (await stat(file)).mtimeMs)));
  const prior = await stat(output).catch(() => null);
  if (prior && prior.mtimeMs >= newest) return;
  await build({ entryPoints: [input], outfile: output, bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['es2022'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildUI();

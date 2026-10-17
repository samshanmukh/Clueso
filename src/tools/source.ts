import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.svg']);
const excluded = new Set(['node_modules', 'dist', 'build', 'artifacts', 'coverage', 'vendor']);

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export async function readSourceFile(sourceRoot: string, requestedPath: string) {
  const root = await realpath(sourceRoot);
  const resolved = resolve(root, requestedPath);
  if (!within(root, resolved) || relative(root, resolved).split(sep).some((p) => p.startsWith('.') || excluded.has(p))) throw new Error('Source path is outside the approved code scope.');
  if (!extensions.has(extname(resolved).toLowerCase())) throw new Error('Only supported code and asset text files may be inspected.');
  const actual = await realpath(resolved);
  if (!within(root, actual)) throw new Error('Source symlink escapes the approved root.');
  const info = await stat(actual);
  if (!info.isFile() || info.size > 256000) throw new Error('Source file is unsupported or exceeds the size limit.');
  const content = await readFile(actual, 'utf8');
  return { path: relative(root, actual), content: content.slice(0, 16000), truncated: content.length > 16000 };
}

export async function searchSource(sourceRoot: string, query: string) {
  if (!query.trim() || query.length > 200) throw new Error('Source search requires a literal query of 1–200 characters.');
  const root = await realpath(sourceRoot);
  const results: { path: string; line: number; text: string }[] = [];
  let filesScanned = 0;
  let stopped = false;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12 || stopped) return;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (stopped) break;
      if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && extensions.has(extname(path).toLowerCase())) {
        if (filesScanned >= 300) { stopped = true; break; }
        filesScanned++;
        const info = await stat(path);
        if (info.size > 256000) continue;
        const content = await readFile(path, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(query)) {
          results.push({ path: relative(root, path), line: i + 1, text: lines[i]!.slice(0, 500) });
          if (results.length >= 50) { stopped = true; break; }
        }
      }
    }
  }
  await walk(root, 0);
  return { query, results, filesScanned, limits: { maxFiles: 300, maxResults: 50, maxDepth: 12, maxFileBytes: 256000 }, completeCoverage: false, limitReached: stopped };
}

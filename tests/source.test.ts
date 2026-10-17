import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceFile, searchSource } from '../src/tools/source.ts';

test('source tools stay in authorized code root and exclude secrets, dependencies and external symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clueso-source-'));
  try {
    const project = join(root, 'project');
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await writeFile(join(project, 'Footer.tsx'), 'const logo = "official.svg";\nexport { logo };');
    await writeFile(join(project, '.env'), 'API_KEY=official.svg');
    await writeFile(join(project, 'node_modules', 'ignored.ts'), 'official.svg');
    await writeFile(join(root, 'outside.ts'), 'private');
    await symlink(join(root, 'outside.ts'), join(project, 'escape.ts'));
    assert.match((await readSourceFile(project, 'Footer.tsx')).content, /official.svg/);
    await assert.rejects(() => readSourceFile(project, '../outside.ts'), /outside/);
    await assert.rejects(() => readSourceFile(project, '.env'), /scope/);
    await assert.rejects(() => readSourceFile(project, 'escape.ts'), /escapes/);
    const results = await searchSource(project, 'official.svg');
    assert.deepEqual(results.results.map((row) => row.path), ['Footer.tsx']);
    assert.equal(await readFile(join(root, 'outside.ts'), 'utf8'), 'private');
  } finally { await rm(root, { recursive: true, force: true }); }
});

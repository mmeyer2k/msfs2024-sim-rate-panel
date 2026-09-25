import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function buildAndRead() {
  execFileSync(process.execPath, ['tools/build-layout.mjs'], { cwd: ROOT });
  const layoutText = await readFile(new URL('../layout.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
  );
  return { layoutText, layout: JSON.parse(layoutText), manifest };
}

test('the layout lists every shipped file, and nothing else', async () => {
  const { layout } = await buildAndRead();
  const paths = layout.content.map((entry) => entry.path).sort();
  assert.deepStrictEqual(paths, [
    'html_ui/efb_ui/efb_apps/SimRateApp/Assets/Icons/SimRate.svg',
    'html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.css',
    'html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.js'
  ]);
});

test('the layout keeps real case, because Wine may be case-sensitive', async () => {
  const { layout } = await buildAndRead();
  const js = layout.content.find((entry) => entry.path.endsWith('.js'));
  assert.ok(js.path.includes('SimRateApp/SimRateApp.js'), js.path);
});

test('FILETIME dates survive as exact integers', async () => {
  const { layoutText, layout } = await buildAndRead();
  const entry = layout.content.find((item) => item.path.endsWith('SimRateApp.js'));
  const stats = await stat(new URL('../' + entry.path, import.meta.url));
  const exact = (BigInt(Math.round(stats.mtimeMs)) * 10000n + 116444736000000000n).toString();

  // A FILETIME is past Number.MAX_SAFE_INTEGER, so it only survives if the
  // generator wrote it as a literal rather than through JSON.stringify.
  assert.ok(Number(exact) > Number.MAX_SAFE_INTEGER);
  assert.strictEqual(exact.length, 18);
  assert.match(layoutText, new RegExp(`"date":\\s*${exact}(,|\\s|$)`, 'm'));
});

test('sizes are real and the manifest total matches their sum', async () => {
  const { layout, manifest } = await buildAndRead();
  const total = layout.content.reduce((sum, entry) => sum + entry.size, 0);
  assert.ok(total > 0);
  assert.strictEqual(manifest.total_package_size, String(total));
});

test('the manifest declares itself a Community MISC package', async () => {
  const { manifest } = await buildAndRead();
  assert.strictEqual(manifest.content_type, 'MISC');
  assert.strictEqual(manifest.export_type, 'Community');
  assert.strictEqual(manifest.title, 'Sim Rate Panel');
  assert.deepStrictEqual(manifest.dependencies, []);
});

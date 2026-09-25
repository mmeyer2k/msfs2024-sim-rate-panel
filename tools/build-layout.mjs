#!/usr/bin/env node
/**
 * Regenerates layout.json and manifest.json's total_package_size.
 * Run after changing anything under html_ui/, then restart the sim.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Only these trees are shipped; docs/, test/ and tools/ stay on disk only. */
const CONTENT_DIRS = ['html_ui'];

/** 1601-01-01 to 1970-01-01, in 100 ns ticks. */
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walk(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

const files = [];
for (const dir of CONTENT_DIRS) {
  files.push(...await walk(join(ROOT, dir)));
}
files.sort();

const content = [];
let total = 0;
for (const file of files) {
  const stats = await stat(file);
  total += stats.size;
  content.push({
    // Real case, forward slashes: Wine over ext4 can be case-sensitive.
    path: relative(ROOT, file).split(sep).join('/'),
    size: stats.size,
    // Parked as a string and unquoted below - a FILETIME does not survive
    // JSON.stringify as a Number.
    date: `@@${BigInt(Math.round(stats.mtimeMs)) * 10000n + FILETIME_EPOCH_OFFSET}@@`
  });
}

const layout = JSON.stringify({ content }, null, 2).replace(/"@@(\d+)@@"/g, '$1');
await writeFile(join(ROOT, 'layout.json'), layout + '\n', 'utf8');

const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.total_package_size = String(total);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`layout.json: ${content.length} files, ${total} bytes`);

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const releaseDirectory = resolve('release');
const outputPath = join(releaseDirectory, 'SHA256SUMS.txt');

const entries = await readdir(releaseDirectory, { withFileTypes: true });
const files = entries
  .filter(
    (entry) =>
      entry.isFile() &&
      (entry.name.toLowerCase().endsWith('.exe') || entry.name.toLowerCase().endsWith('.blockmap')),
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error('No installer or blockmap files found under release/.');
  process.exit(1);
}

const lines = [];
for (const name of files) {
  const bytes = await readFile(join(releaseDirectory, name));
  const digest = createHash('sha256').update(bytes).digest('hex');
  lines.push(`${digest}  ${name}`);
}

await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${outputPath} (${files.length} file(s)).`);

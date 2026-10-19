import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMatrixMarkdown } from '../src/authz/permissions';

const path = join(__dirname, '..', '..', '..', 'docs', 'SECURITY.md');
const doc = readFileSync(path, 'utf8');
const [before, rest] = doc.split('<!-- MATRIX:START -->');
const after = rest!.split('<!-- MATRIX:END -->')[1];
writeFileSync(path, `${before}<!-- MATRIX:START -->\n${renderMatrixMarkdown()}\n<!-- MATRIX:END -->${after}`);
console.log('SECURITY.md access-control matrix updated');

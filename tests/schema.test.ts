import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaSql } from '../src/worker/schema';

describe('schema', () => {
  it('migrations/0001_init.sql matches the schema the Worker applies (run `npm run schema`)', () => {
    expect(readFileSync('migrations/0001_init.sql', 'utf8')).toBe(schemaSql());
  });
  it('wrangler config names the Worker as it exists in Cloudflare (budget-game) and needs no database ID', () => {
    const cfg = readFileSync('wrangler.jsonc', 'utf8');
    expect(cfg).toMatch(/"name":\s*"budget-game"/);
    expect(cfg).not.toMatch(/"database_id"/);
  });
  it('gitignore keeps statements, CSVs and secrets out of git', () => {
    const g = readFileSync('.gitignore', 'utf8');
    for (const p of ['*.pdf', '*.csv', '.dev.vars', 'private-fixtures/*', '.env']) expect(g).toContain(p);
  });
});

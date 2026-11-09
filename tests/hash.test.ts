import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256HexSync } from '../src/shared/hash';

describe('sha256HexSync', () => {
  it('matches the standard SHA-256 for many lengths and characters', () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'ABA-812|2026-11-10||café ••• 812 £5|1.23|99.00|0', '🙂 ខ្មែរ 漢字'];
    for (const s of samples) expect(sha256HexSync(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

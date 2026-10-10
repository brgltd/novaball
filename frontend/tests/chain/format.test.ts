import { describe, expect, it } from 'vitest';

import { formatNova, hexColor, shortAddress } from '../../src/chain/format';

const NOVA = 10n ** 18n;

describe('formatNova', () => {
  it('formats whole and fractional amounts', () => {
    expect(formatNova(0n)).toBe('0');
    expect(formatNova(100n * NOVA)).toBe('100');
    expect(formatNova(875n * 10n ** 17n)).toBe('87.5');
    expect(formatNova(1234567n * NOVA)).toBe('1,234,567');
    expect(formatNova(15n * 10n ** 16n, 2)).toBe('0.15');
  });
  it('signs negatives and never shows dust as 0', () => {
    expect(formatNova(-20n * NOVA)).toBe('-20');
    expect(formatNova(1n)).toBe('0.1');
  });
  it('handles missing values', () => {
    expect(formatNova(null)).toBe('—');
    expect(formatNova(undefined)).toBe('—');
  });
});

describe('helpers', () => {
  it('shortens addresses and formats colors', () => {
    expect(shortAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe('0x7099…79C8');
    expect(shortAddress(null)).toBe('—');
    expect(hexColor(0xb3122e)).toBe('#b3122e');
    expect(hexColor(0x0d0f14)).toBe('#0d0f14');
  });
});

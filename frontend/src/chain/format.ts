/** Display helpers for NOVA amounts and addresses. */

/** 18-decimals wei → "1,234.5" (up to `decimals` fraction digits, trailing zeros trimmed). */
export function formatNova(wei: bigint | null | undefined, decimals = 1): string {
  if (wei === null || wei === undefined) return '—';
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const scale = 10n ** BigInt(18 - decimals);
  let frac = decimals > 0 ? ((v % 10n ** 18n) / scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  if (frac === '' && decimals > 0 && whole === 0n && v > 0n) frac = ''.padEnd(decimals - 1, '0') + '1'; // dust shows as 0.1, never 0
  const w = whole.toLocaleString('en-US');
  return `${neg ? '-' : ''}${w}${frac ? `.${frac}` : ''}`;
}

/** 0x1234…abcd */
export function shortAddress(a: string | null | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

export function hexColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

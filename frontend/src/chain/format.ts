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

/** ETH amounts for gas: "0.012", "0.000026" (2 significant digits below 0.01), "0". */
export function formatEth(wei: bigint | null | undefined): string {
  if (wei === null || wei === undefined) return '—';
  if (wei === 0n) return '0';
  const eth = Number(wei) / 1e18;
  if (eth >= 0.01) return eth.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (eth < 1e-6) return '<0.000001';
  return eth.toPrecision(2).replace(/\.?0+$/, '');
}

/** 0x1234…abcd */
export function shortAddress(a: string | null | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

export function hexColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

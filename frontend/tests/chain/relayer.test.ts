/** Relayer request handling that never reaches the chain: routing, CORS, validation, rate limits. */
import { describe, expect, it } from 'vitest';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { REPORT_DOMAIN, REPORT_TYPES } from '../../src/chain/api';
import { ANVIL_RELAYER_KEY, createRelayer, loadDeployment } from '../../server/relayer';

const deployment = loadDeployment(31337)!;
const relayer = createRelayer({ chainId: 31337, privateKey: ANVIL_RELAYER_KEY, deployment, rpcUrl: 'http://127.0.0.1:1', log: () => {} });

const match = {
  player: '0x000000000000000000000000000000000000dEaD',
  callsign: 'JUDGE',
  team: 0,
  points: 240,
  seed: 123,
  stateHash: 456,
  teamSize: 2,
  difficulty: 'rookie',
  durationSec: 120,
  score: [2, 1],
  winner: 0,
  overtime: false,
};

const post = (route: string, body: unknown, ip = '10.0.0.1') =>
  relayer.handle(new Request(`http://x/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-novaball-client-ip': ip }, body: JSON.stringify(body) }));

describe('relayer', () => {
  it('uses the deployment written by Deploy.s.sol', () => {
    expect(deployment.chainId).toBe(31337);
    expect(relayer.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('answers CORS preflights and unknown routes', async () => {
    const pre = await relayer.handle(new Request('http://x/api/match', { method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const nf = await relayer.handle(new Request('http://x/api/nope', { method: 'POST', body: '{}' }));
    expect(nf.status).toBe(404);
  });

  it.each([
    ['a bad address', { player: '0x123' }, 'player'],
    ['a bad callsign', { callsign: 'NOPE<script>' }, 'callsign'],
    ['an unknown difficulty', { difficulty: 'godlike' }, 'difficulty'],
    ['a winner that contradicts the score', { winner: 1 }, 'winner'],
    ['a fractional score', { points: 1.5 }, 'points'],
    ['a short match', { durationSec: 30 }, 'durationSec'],
  ])('rejects a match report with %s', async (_, patch, field) => {
    const res = await post('match', { ...match, ...patch }, `ip-${field}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('bad_request');
    expect(body.message).toContain(field);
  });

  it('rejects malformed purchases', async () => {
    const res = await post('purchase', { buyer: match.player, itemId: 1, maxPrice: '100', deadline: 1, signature: 'not-hex' }, 'ip-p');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('signature');
  });

  it('rejects non-JSON bodies', async () => {
    const res = await relayer.handle(new Request('http://x/api/match', { method: 'POST', body: 'hello', headers: { 'x-novaball-client-ip': 'ip-json' } }));
    expect(res.status).toBe(400);
  });

  const sign = (pk: `0x${string}`, m: typeof match) =>
    privateKeyToAccount(pk).signTypedData({
      domain: { ...REPORT_DOMAIN, chainId: 31337 },
      types: REPORT_TYPES,
      primaryType: 'MatchReport',
      message: { player: m.player as `0x${string}`, seed: BigInt(m.seed), stateHash: BigInt(m.stateHash), points: BigInt(m.points) },
    });

  it('rejects reports not signed by the player', async () => {
    const res = await post('match', { ...match, signature: await sign(generatePrivateKey(), match) }, 'ip-sig1');
    expect(res.status).toBe(401);
  });

  it('rejects a report whose signed points were changed', async () => {
    const pk = generatePrivateKey();
    const m = { ...match, player: privateKeyToAccount(pk).address };
    const res = await post('match', { ...m, points: 3000, signature: await sign(pk, m) }, 'ip-sig2');
    expect(res.status).toBe(401);
  });

  it('rejects an expired reward session', async () => {
    const session = privateKeyToAccount(generatePrivateKey());
    const m = { ...match, player: privateKeyToAccount(generatePrivateKey()).address };
    const signature = await session.signTypedData({ domain: { ...REPORT_DOMAIN, chainId: 31337 }, types: REPORT_TYPES, primaryType: 'MatchReport', message: { player: m.player, seed: 123n, stateHash: 456n, points: 240n } });
    const res = await post('match', { ...m, signature, session: { key: session.address, expires: 1000, signature: '0x00' } }, 'ip-sig3');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/expired/);
  });

  it('accepts a player-signed report (then needs the chain)', async () => {
    const pk = generatePrivateKey();
    const m = { ...match, player: privateKeyToAccount(pk).address };
    const res = await post('match', { ...m, signature: await sign(pk, m) }, 'ip-sig4');
    expect(res.status).toBeGreaterThanOrEqual(500); // signature OK; the test RPC is unreachable
  });

  it('rate-limits a flooding client', async () => {
    let last = 0;
    for (let i = 0; i < 62; i++) last = (await post('match', { ...match, callsign: '' }, 'ip-flood')).status;
    expect(last).toBe(429);
  });
});

/** Relayer request handling that never reaches the chain: routing, CORS, validation, rate limits. */
import { describe, expect, it } from 'vitest';

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
  relayer.handle(new Request(`http://x/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }));

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
    const res = await relayer.handle(new Request('http://x/api/match', { method: 'POST', body: 'hello', headers: { 'x-forwarded-for': 'ip-json' } }));
    expect(res.status).toBe(400);
  });

  it('rate-limits a flooding client', async () => {
    let last = 0;
    for (let i = 0; i < 62; i++) last = (await post('match', { ...match, callsign: '' }, 'ip-flood')).status;
    expect(last).toBe(429);
  });
});

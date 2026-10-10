#!/usr/bin/env node
// One command for the whole local stack:  npm run dev:local
//   1. starts anvil on :8545 (unless one is already running), persisting its state in contracts/.anvil/
//   2. deploys the contracts if they are not on that chain yet (contracts/script/Deploy.s.sol)
//   3. starts the Vite dev server — the game + an /rpc proxy to anvil
//   --fresh   start from an empty chain and redeploy (after changing the contracts)
// Needs Foundry (https://getfoundry.sh). Ctrl+C stops everything.
// Your browser wallet: add the network (the game offers it: chain 31337, RPC http://127.0.0.1:8545), then use the
// wallet panel's GET 10 TEST ETH for gas. After a --fresh restart, reset the wallet's activity/nonce for that network.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const contracts = fileURLToPath(new URL('../../contracts/', import.meta.url));
const RPC = 'http://127.0.0.1:8545';
const children = [];
const fresh = process.argv.includes('--fresh');
const viteArgs = process.argv.slice(2).filter((a) => a !== '--fresh');

const log = (m) => console.log(`\x1b[36m[dev:local]\x1b[0m ${m}`);

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await res.json()).result;
}

async function chainUp() {
  try {
    return Number(await rpc('eth_chainId')) === 31337;
  } catch {
    return false;
  }
}

function need(bin) {
  if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.error(`\n${bin} not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup\n`);
    process.exit(1);
  }
}

function stopAll() {
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
}
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

// ---------------------------------------------------------------- 1. anvil
if (await chainUp()) {
  log('anvil already running on :8545');
} else {
  need('anvil');
  if (fresh) rmSync(`${contracts}.anvil`, { recursive: true, force: true });
  mkdirSync(`${contracts}.anvil`, { recursive: true });
  log('starting anvil (state persisted in contracts/.anvil/state.json)');
  const anvil = spawn('anvil', ['--silent', '--state', `${contracts}.anvil/state.json`, '--state-interval', '5'], { stdio: 'inherit' });
  children.push(anvil);
  anvil.on('exit', (code) => code && log(`anvil exited (${code})`));
  for (let i = 0; i < 50 && !(await chainUp()); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await chainUp())) {
    console.error('anvil did not start');
    stopAll();
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 2. contracts
const deploymentFile = `${frontend}src/chain/deployments/31337.json`;
let deployed = false;
if (existsSync(deploymentFile) && !fresh) {
  const { nova } = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  deployed = ((await rpc('eth_getCode', [nova, 'latest'])) ?? '0x') !== '0x';
}
if (deployed) {
  log('contracts already deployed on the local chain');
} else {
  need('forge');
  log('deploying contracts…');
  const r = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC, '--broadcast'], { cwd: contracts, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout);
    stopAll();
    process.exit(1);
  }
  for (const line of r.stdout.split('\n')) if (/^\s+(NOVA|Garage|Arena)\s/.test(line)) log(line.trim());
}

// ---------------------------------------------------------------- 3. game
log('starting the game (Vite) — anvil is proxied at /rpc');
const vite = spawn(process.execPath, [`${frontend}node_modules/vite/bin/vite.js`, ...viteArgs], {
  cwd: frontend,
  stdio: 'inherit',
  env: { ...process.env, VITE_CHAIN_ID: '31337' },
});
children.push(vite);
vite.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});

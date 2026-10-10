/** A relayer created on first use (and re-created after a failure, e.g. a deployment file appearing later). */
import { createRelayer, optionsFromEnv } from './relayer.ts';

export function lazyRelayer(env: Record<string, string | undefined>, defaultChainId: number, deploymentsDir?: string, log?: (m: string) => void) {
  let relayer: ReturnType<typeof createRelayer> | null = null;
  return async (req: Request): Promise<Response> => {
    if (!relayer) {
      const opts = optionsFromEnv(env, defaultChainId, deploymentsDir);
      if ('error' in opts) {
        return new Response(JSON.stringify({ error: 'unavailable', message: `Relayer not configured: ${opts.error}` }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        });
      }
      relayer = createRelayer({ ...opts, log });
      (log ?? console.log)(`[relayer] chain ${relayer.chainId} · game server ${relayer.address}`);
    }
    return relayer.handle(req);
  };
}

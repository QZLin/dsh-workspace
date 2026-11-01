import { resolveEndpoint } from './src/endpoint.js';
import { createWorkspaceIpcServer } from './src/server.js';

export const name = 'dsh-workspace-ipc';
export const inject = ['workspaceRegistry'];

/** Runs inside the already-active Host profile; never starts another DSH. */
export async function apply(ctx, config = {}) {
  await ctx.effect(async () => {
    const endpoint = resolveEndpoint({ dshHome: config.dshHome, endpoint: config.endpoint });
    const ipc = await createWorkspaceIpcServer({
      registry: ctx.workspaceRegistry,
      endpoint,
      logger: ctx.logger,
    });
    // Return the cleanup before logging, so a logging failure cannot leak the
    // listener. The effect awaits startup and owns every pipe/socket connection.
    try { ctx.logger.info(`Workspace IPC listening on ${endpoint}`); } catch { /* optional diagnostic */ }
    return () => ipc.dispose();
  }, 'dsh-workspace-ipc local listener');
}

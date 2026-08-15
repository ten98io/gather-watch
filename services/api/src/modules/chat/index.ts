/**
 * Chat module entry — mirrors src/modules/auth/index.ts but with WS handlers.
 * `serviceFor` keeps ONE ChatService per Deps (WeakMap) so REST routes and
 * WS handlers share the rate limiters and notifier. The orchestrator
 * registers this module in src/modules/index.ts.
 */
import type { Deps, ModulePlugin } from '../types';
import { ChatService } from './service';
import { chatRoutes } from './routes';

const services = new WeakMap<Deps, ChatService>();

/** The one shared ChatService for a Deps instance. */
export function serviceFor(deps: Deps): ChatService {
  let service = services.get(deps);
  if (service === undefined) {
    service = new ChatService(deps);
    services.set(deps, service);
  }
  return service;
}

export const chatModule: ModulePlugin = {
  name: 'chat',
  routes: chatRoutes,
  wsHandlers: {
    'chat.send': async (event, ctx) => {
      await serviceFor(ctx.deps).send(ctx.roomId, ctx.auth, event.payload);
    },
    'chat.edit': async (event, ctx) => {
      await serviceFor(ctx.deps).edit(
        ctx.roomId,
        ctx.auth,
        event.payload.messageId,
        event.payload.body,
      );
    },
    'chat.delete': async (event, ctx) => {
      await serviceFor(ctx.deps).remove(ctx.roomId, ctx.auth, event.payload.messageId);
    },
    'chat.react': async (event, ctx) => {
      await serviceFor(ctx.deps).react(
        ctx.roomId,
        ctx.auth,
        event.payload.messageId,
        event.payload.emoji,
        event.payload.op,
      );
    },
    'chat.typing': (event, ctx) => {
      serviceFor(ctx.deps).typing(ctx.roomId, ctx.auth, event.payload.typing);
    },
    'chat.read': async (event, ctx) => {
      await serviceFor(ctx.deps).read(ctx.roomId, ctx.auth, event.payload.lastReadSeq);
    },
    'chat.delivered': async (event, ctx) => {
      await serviceFor(ctx.deps).delivered(ctx.roomId, ctx.auth, event.payload.lastDeliveredSeq);
    },
    'emote.burst': (event, ctx) => {
      serviceFor(ctx.deps).emote(ctx.roomId, ctx.auth, event.payload);
    },
  },
};
export default chatModule;

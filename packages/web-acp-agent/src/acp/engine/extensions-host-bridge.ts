import type { SessionBridge } from '../../agent/extensions';
import type { ExtensionPayload } from '../../storage/session-store';
import type { AcpAdapterServices } from './services';

/**
 * Host-side bridge that implements `pi.session.*` against the
 * agent's session store. `appendEntry` / `sendMessage` persist a
 * typed `extension` row; the host rebuilds it as a muted assistant
 * message via `reconstructMessages` on `session/load`. Live
 * rendering of extension entries during the emitting turn is
 * intentionally deferred — the streaming reducer's single
 * `streamingMessage` slot does not have a clean affordance for
 * out-of-band chunks, and the Phase 8 contract is "survives reload"
 * not "renders live". Add a dedicated wire seam later if a use
 * case needs live extension surfacing.
 *
 * Stateless: the registry passes the active `sessionId`
 * explicitly. Calls outside an active dispatch are rejected by
 * the registry's `requireActive` guards before they reach here.
 */
export interface HostBridgeArgs {
  services: AcpAdapterServices;
}

export function createExtensionsHostBridge(args: HostBridgeArgs): SessionBridge {
  const { services } = args;
  return {
    async appendEntry(sessionId: string, extensionName: string, customType: string, data: unknown) {
      if (!services.store) return;
      const payload: ExtensionPayload = { extensionName, customType, data };
      try {
        await services.store.recordExtension(sessionId, payload);
      } catch (err) {
        console.error('[extensions-host-bridge] recordExtension failed:', err);
      }
    },
    async setName(sessionId: string, name: string) {
      const trimmed = name.trim();
      if (services.store) {
        await services.store.setTitle(sessionId, trimmed.length === 0 ? null : trimmed);
      }
    },
    getName(_sessionId: string): string | null {
      // The store is async; the host caches title elsewhere if it
      // needs synchronous access. For now this is best-effort and
      // returns null. Extensions that care can call setName and
      // track their own value.
      return null;
    },
    async setLabel(
      sessionId: string,
      extensionName: string,
      entryId: string,
      label: string | undefined
    ) {
      const seq = parseEntryId(entryId);
      if (seq === null) {
        console.warn(
          `[extensions-host-bridge] '${extensionName}' setLabel: invalid entryId '${entryId}'`
        );
        return;
      }
      if (!services.store) return;
      try {
        await services.store.setExtensionLabel(sessionId, seq, label);
      } catch (err) {
        console.error('[extensions-host-bridge] setExtensionLabel failed:', err);
      }
    },
    async sendMessage(sessionId: string, extensionName: string, text: string) {
      if (!services.store) return;
      const payload: ExtensionPayload = {
        extensionName,
        customType: 'message',
        data: { text },
      };
      try {
        await services.store.recordExtension(sessionId, payload);
      } catch (err) {
        console.error('[extensions-host-bridge] recordExtension failed:', err);
      }
    },
    async sendUserMessage(_sessionId: string, extensionName: string, _text: string) {
      // Phase 8 lands the API surface; extension-injected user
      // messages re-enter the prompt-driver loop and need careful
      // coordination with the inflight-mutex guard. Defer the
      // actual injection to a follow-up phase — log + no-op so
      // ports of `event-bus.ts` etc. don't crash.
      console.warn(
        `[extensions-host-bridge] '${extensionName}' sendUserMessage is not yet wired (Phase 8 stub)`
      );
    },
  };
}

function parseEntryId(entryId: string): number | null {
  const match = /^seq:(\d+)$/.exec(entryId);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

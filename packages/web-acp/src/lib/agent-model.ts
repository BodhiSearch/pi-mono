import type { ClientState } from '@bodhiapp/bodhi-js-react';
import { isDirectState } from '@bodhiapp/bodhi-js-react';

export function getServerUrlOrThrow(state: ClientState): string {
  if (!isDirectState(state) || !state.url) {
    throw new Error(
      'Chat requires a Bodhi server connection. Open Settings to connect to a server.'
    );
  }
  return state.url;
}

// Public PKCE-only client registered at developer.getbodhi.app.
export const APP_CLIENT_ID = 'bodhi-app-f181a4d1-d7af-43f4-965a-0a8efd453d86';

export const DEFAULT_AUTH_SERVER_URL = 'https://main-id.getbodhi.app/realms/bodhi';

export const DEFAULT_CALLBACK_PORT = 5173;

export const DEFAULT_SCOPES = ['openid', 'email', 'profile', 'roles'] as const;

export function buildScopeString(accessRequestId: string, accessRequestScope?: string): string {
  const scope = accessRequestScope ?? `access_request:${accessRequestId}`;
  return [...DEFAULT_SCOPES, scope].join(' ');
}

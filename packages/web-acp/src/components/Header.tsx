import { useBodhi, LoginOptionsBuilder, BodhiBadge } from '@bodhiapp/bodhi-js-react';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import StatusIndicator from './StatusIndicator';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * Resolve the upstream MCP URL that the login flow requests access to
 * before approval. Production / dev builds read from
 * `VITE_MCP_EVERYTHING_URL`. E2E tests inject
 * `window.__mcpEverythingUrl` via Playwright's `addInitScript` so the
 * harness can point login at the everything-server fixture it spun up
 * in `global-setup.ts`. When nothing is configured we skip
 * `addMcpServer` entirely; the app still works against whatever MCP
 * instances already exist on the Bodhi server.
 */
function resolveEverythingMcpUrl(): string | undefined {
  if (typeof window !== 'undefined') {
    const override = (window as unknown as { __mcpEverythingUrl?: unknown }).__mcpEverythingUrl;
    if (typeof override === 'string' && override.length > 0) return override;
  }
  const fromEnv = import.meta.env.VITE_MCP_EVERYTHING_URL as string | undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

/**
 * Public Exa DeepWiki MCP. Hardcoded because it's a stable public
 * endpoint with no per-environment variation; an env override is
 * still honoured so deployments can pin to a self-hosted mirror or
 * disable it entirely by setting an empty string.
 */
const DEEPWIKI_MCP_URL_DEFAULT = 'https://mcp.deepwiki.com/mcp';

function resolveDeepwikiMcpUrl(): string | undefined {
  const fromEnv = import.meta.env.VITE_MCP_DEEPWIKI_URL as string | undefined;
  if (typeof fromEnv === 'string') {
    return fromEnv.length > 0 ? fromEnv : undefined;
  }
  return DEEPWIKI_MCP_URL_DEFAULT;
}

export default function Header() {
  const {
    clientState,
    isReady,
    isServerReady,
    isInitializing,
    setupState,
    auth,
    isAuthenticated,
    isAuthLoading,
    login,
    logout,
    showSetup,
  } = useBodhi();

  const handleLogin = async () => {
    const builder = new LoginOptionsBuilder().setFlowType('redirect').setRole('scope_user_user');
    const mcpUrl = resolveEverythingMcpUrl();
    if (mcpUrl) {
      builder.addMcpServer(mcpUrl);
    }
    const deepwikiUrl = resolveDeepwikiMcpUrl();
    if (deepwikiUrl) {
      builder.addMcpServer(deepwikiUrl);
    }
    const loginOptions = builder.build();
    const authState = await login(loginOptions);
    if (authState?.status === 'error' && authState.error) {
      toast.error(authState.error.message);
    }
  };

  const isSettingsLoading = isInitializing || setupState !== 'ready';

  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
      <div className="flex items-center gap-2">
        <BodhiBadge size="sm" variant="light" />
        <h1 className="text-lg font-semibold" data-testid="app-title">
          Hikma App
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 border-r border-gray-200 pr-3">
          <StatusIndicator
            label="Client"
            status={isReady}
            tooltip={isReady ? 'Client ready' : 'Client not ready'}
          />
          <StatusIndicator
            label="Server"
            status={isServerReady}
            tooltip={isServerReady ? 'Server ready' : 'Server not ready'}
          />
          <span className="text-xs text-gray-600" title="Connection mode">
            mode={clientState.mode || 'unknown'}
          </span>
        </div>

        <Button
          data-testid="btn-settings"
          onClick={showSetup}
          variant="ghost"
          size="icon"
          title="Settings"
        >
          {isSettingsLoading ? <Spinner /> : <Settings />}
        </Button>

        <section
          data-testid="section-auth"
          data-teststate={isAuthenticated ? 'authenticated' : 'unauthenticated'}
        >
          {isAuthenticated ? (
            <div className="flex items-center gap-2">
              <span
                data-testid="span-auth-name"
                className="text-sm text-gray-700"
                title={auth.user?.email}
              >
                {auth.user?.name || auth.user?.email || 'User'}
              </span>
              <Button data-testid="btn-auth-logout" onClick={logout} variant="ghost">
                Logout
              </Button>
            </div>
          ) : (
            <Button data-testid="btn-auth-login" onClick={handleLogin} disabled={isAuthLoading}>
              {isAuthLoading ? <Spinner /> : 'Login'}
            </Button>
          )}
        </section>
      </div>
    </header>
  );
}

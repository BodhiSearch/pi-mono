import { useBodhi, LoginOptionsBuilder, BodhiBadge } from '@bodhiapp/bodhi-js-react';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import StatusIndicator from './StatusIndicator';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { loadRequestedMcps } from '@/mcp/requested-mcps-store';

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

  /**
   * Build the login options from the persisted requested-MCPs IDB
   * list. A brand-new user has an empty list → first login requests
   * zero MCP scopes; further `addMcpServer` calls happen via the
   * `/mcp add` built-in (M4 phase B), which mutates the IDB list and
   * re-triggers `auth.login` with the updated set.
   */
  const handleLogin = async () => {
    const builder = new LoginOptionsBuilder().setFlowType('redirect').setRole('scope_user_user');
    const requestedUrls = await loadRequestedMcps();
    for (const url of requestedUrls) {
      builder.addMcpServer(url);
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
          data-test-state={isAuthenticated ? 'authenticated' : 'unauthenticated'}
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

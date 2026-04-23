import { useBodhi, LoginOptionsBuilder } from '@bodhiapp/bodhi-js-react';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import StatusIndicator from './StatusIndicator';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

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
    const loginOptions = new LoginOptionsBuilder()
      .setFlowType('redirect')
      .setRole('scope_user_user')
      .addMcpServer('https://mcp.exa.ai/mcp')
      .build();
    const authState = await login(loginOptions);
    if (authState?.status === 'error' && authState.error) {
      toast.error(authState.error.message);
    }
  };

  const isSettingsLoading = isInitializing || setupState !== 'ready';

  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold" data-testid="app-title">
          Demo Chat
        </h1>
        <span className="text-sm text-gray-500" data-testid="app-subtitle">
          powered by Bodhi Browser Extension
        </span>
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

import {
  BODHI_EXEC_VARIANT,
  setAppStatus,
  setClientCredentials,
  setCreatedBy,
} from '@bodhiapp/app-bindings';
import { mkdtempSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const isCI = process.env.CI === 'true';

export interface BodhiServerConfig {
  authUrl?: string;
  authRealm?: string;
  clientId?: string;
  clientSecret?: string;
  port?: number;
  host?: string;
  home?: string;
  appStatus?: string;
  logLevel?: string;
  logToStdout?: boolean;
  binPath?: string;
  createdBy?: string;
  timeout?: number;
  keepAliveSecs?: number;
}

export class BodhiServerManager {
  private server: {
    start(): Promise<void>;
    stop(): Promise<void>;
    isRunning(): Promise<boolean>;
  } | null = null;
  private config: BodhiServerConfig;
  private actualPort: number | null = null;
  private tempHome: string | null = null;

  constructor(config: BodhiServerConfig = {}) {
    this.config = {
      timeout: 30000,
      logLevel: 'debug',
      logToStdout: false,
      host: '127.0.0.1',
      keepAliveSecs: 30 * 60,
      ...config,
    };
  }

  async start(): Promise<string> {
    if (this.server) {
      throw new Error('Server is already running');
    }

    const port = this.config.port || (await this.findAvailablePort());
    this.actualPort = port;
    const serverUrl = `http://localhost:${port}`;

    if (!this.config.home) {
      this.tempHome = mkdtempSync(join(tmpdir(), 'bodhi-test-'));
    }

    this.server = await this.createBodhiServerDirect();
    await this.server.start();

    const running = await this.server.isRunning();
    if (!running) {
      throw new Error('Bodhi server failed to start');
    }

    await this.waitForHealthCheck(serverUrl);
    console.log(`[bodhi-server] Server started at ${serverUrl}`);
    return serverUrl;
  }

  private async createBodhiServerDirect() {
    const appBindings = await import('@bodhiapp/app-bindings');
    const {
      createNapiAppOptions,
      setEnvVar,
      setSystemSetting,
      setAppSetting,
      BodhiServer,
      BODHI_HOST,
      BODHI_PORT,
      BODHI_ENV_TYPE,
      BODHI_APP_TYPE,
      BODHI_VERSION,
      BODHI_LOG_LEVEL,
      BODHI_LOG_STDOUT,
      BODHI_AUTH_URL,
      BODHI_AUTH_REALM,
      BODHI_EXEC_LOOKUP_PATH,
      BODHI_KEEP_ALIVE_SECS,
      BODHI_DEPLOYMENT,
      BODHI_HOME,
      BODHI_ENCRYPTION_KEY,
    } = appBindings;

    let napiConfig = createNapiAppOptions();

    const home = this.config.home || this.tempHome!;
    napiConfig = setEnvVar(napiConfig, 'HOME', home);
    napiConfig = setEnvVar(napiConfig, BODHI_HOME, home);
    napiConfig = setEnvVar(napiConfig, BODHI_HOST, this.config.host!);
    napiConfig = setEnvVar(napiConfig, BODHI_PORT, this.actualPort!.toString());

    if (isCI) {
      napiConfig = setEnvVar(napiConfig, 'LLAMA_ARG_N_PARALLEL', '1');
    }

    napiConfig = setSystemSetting(napiConfig, BODHI_ENV_TYPE, 'development');
    napiConfig = setSystemSetting(napiConfig, BODHI_APP_TYPE, 'container');
    napiConfig = setSystemSetting(napiConfig, BODHI_VERSION, '1.0.0-test');
    napiConfig = setSystemSetting(napiConfig, BODHI_DEPLOYMENT, 'standalone');

    if (this.config.authUrl) {
      napiConfig = setSystemSetting(napiConfig, BODHI_AUTH_URL, this.config.authUrl);
    }
    if (this.config.authRealm) {
      napiConfig = setSystemSetting(napiConfig, BODHI_AUTH_REALM, this.config.authRealm);
    }

    napiConfig = setAppSetting(napiConfig, BODHI_LOG_LEVEL, this.config.logLevel!);
    napiConfig = setAppSetting(napiConfig, BODHI_LOG_STDOUT, this.config.logToStdout!.toString());

    if (!this.config.binPath) {
      throw new Error(
        'binPath is required. Set BODHI_EXEC_LOOKUP_PATH in .env.test or pass binPath to BodhiServerManager.'
      );
    }
    napiConfig = setAppSetting(napiConfig, BODHI_EXEC_LOOKUP_PATH, this.config.binPath);
    napiConfig = setAppSetting(napiConfig, BODHI_EXEC_VARIANT, 'cpu');
    napiConfig = setAppSetting(
      napiConfig,
      BODHI_KEEP_ALIVE_SECS,
      this.config.keepAliveSecs!.toString()
    );

    if (this.config.appStatus) {
      napiConfig = setAppStatus(napiConfig, this.config.appStatus);
    }
    if (this.config.clientId && this.config.clientSecret) {
      napiConfig = setClientCredentials(napiConfig, this.config.clientId, this.config.clientSecret);
    }
    if (this.config.createdBy) {
      napiConfig = setCreatedBy(napiConfig, this.config.createdBy);
    }

    napiConfig = setEnvVar(napiConfig, BODHI_ENCRYPTION_KEY, 'test-encryption-key-for-e2e');

    return new BodhiServer(napiConfig);
  }

  private findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  private async waitForHealthCheck(serverUrl: string): Promise<void> {
    const startTime = Date.now();
    const timeout = this.config.timeout!;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`${serverUrl}/ping`);
        if (response.ok) {
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Bodhi server failed to start within ${timeout}ms`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      try {
        await this.server.stop();
      } catch (error) {
        console.error('[bodhi-server] Error stopping server:', error);
      }
      this.server = null;
      this.actualPort = null;
    }

    if (this.tempHome) {
      try {
        const { rmSync } = await import('fs');
        rmSync(this.tempHome, { recursive: true, force: true });
      } catch (error) {
        console.warn('[bodhi-server] Could not clean up temp directory:', error);
      }
      this.tempHome = null;
    }
  }

  getServerUrl(): string | null {
    return this.actualPort ? `http://localhost:${this.actualPort}` : null;
  }
}

interface EnvironmentVariables {
  readonly PORT: string
  readonly TEMPO_HOME: string
  readonly TEMPO_AUTH_URL: string
  readonly CHANNEL_DB_PATH: string
  readonly TEMPO_WALLET_SERVICES_URL: string
  readonly TEMPO_WALLET_FUND_TIMEOUT_MS: string
  readonly TEMPO_WALLET_DISABLE_BROWSER_OPEN: string
  readonly TEMPO_WALLET_FUND_POLL_INTERVAL_MS: string
}

// Node.js `process.env` auto-completion
declare namespace NodeJS {
  interface ProcessEnv extends EnvironmentVariables {
    readonly NODE_ENV: 'development' | 'production' | 'test'
  }
}

// Bun `Bun.env` auto-completion
declare namespace Bun {
  interface Env extends EnvironmentVariables {
    readonly NODE_ENV: 'development' | 'production' | 'test'
  }
}

// Bun/vite `import.meta.env` auto-completion
interface ImportMetaEnv extends EnvironmentVariables {
  readonly MODE: 'development' | 'production' | 'test'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

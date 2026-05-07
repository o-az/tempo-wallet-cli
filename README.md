# Tempo Wallet

TypeScript CLI for Tempo wallet identity and custody operations.

Use the local entrypoint directly while developing:

```sh
node ./src/index.ts --help
```

## Install

```sh
bun install
```

## Choose a Network

The CLI defaults to Tempo mainnet. Use `--network testnet` for Tempo Moderato.

```sh
node ./src/index.ts whoami
node ./src/index.ts --network testnet whoami
```

Supported network names:

- `tempo` or `mainnet`
- `tempo-moderato`, `moderato`, or `testnet`

## Log In

Open the Tempo wallet auth flow and connect a wallet:

```sh
node ./src/index.ts login
```

For testnet:

```sh
node ./src/index.ts --network testnet login
```

If you are on a remote machine or do not want the CLI to open a browser:

```sh
node ./src/index.ts login --no-browser
```

Check the active wallet and balance:

```sh
node ./src/index.ts whoami
```

## Create or Import a Local Wallet

Create a local wallet without browser login:

```sh
node ./src/index.ts init
```

Create a hardware-backed local root wallet when supported by the platform:

```sh
node ./src/index.ts init --hardware-encryption
```

Import an existing private key:

```sh
node ./src/index.ts import --private-key 0x...
```

Import a discoverable wallet by address:

```sh
node ./src/index.ts import --address 0x...
```

List imported and discoverable wallets:

```sh
node ./src/index.ts list
```

## Manage Keys

List local wallet keys:

```sh
node ./src/index.ts keys
```

Create a revocable local access key from a local root wallet:

```sh
node ./src/index.ts keys create
```

Refresh a passkey wallet access key:

```sh
node ./src/index.ts refresh
```

Disconnect the current passkey wallet:

```sh
node ./src/index.ts logout
```

## Fund a Wallet

Open the funding flow for the current wallet and wait for the balance to change:

```sh
node ./src/index.ts fund
```

Fund a specific address:

```sh
node ./src/index.ts fund --address 0x...
```

On testnet, this opens the Moderato deposit/faucet flow:

```sh
node ./src/index.ts --network testnet fund
```

## Transfer Tokens

Send a TIP-20 token:

```sh
node ./src/index.ts transfer <amount> <token> <recipient>
```

Preview a transfer without submitting it:

```sh
node ./src/index.ts transfer 1.00 0xTOKEN 0xRECIPIENT --dry-run
```

Pay fees with a different token:

```sh
node ./src/index.ts transfer 1.00 0xTOKEN 0xRECIPIENT --fee-token 0xFEE_TOKEN
```

## Payment Sessions

List local payment sessions:

```sh
node ./src/index.ts sessions
```

Sync local session state:

```sh
node ./src/index.ts sessions sync
```

Close a session by URL, origin, or channel ID:

```sh
node ./src/index.ts sessions close <url-or-origin-or-channel-id>
```

Preview close targets:

```sh
node ./src/index.ts sessions close <url-or-origin-or-channel-id> --dry-run
```

## Browse MPP Services

List services:

```sh
node ./src/index.ts services
```

Search services:

```sh
node ./src/index.ts services --search image
```

Show one service:

```sh
node ./src/index.ts services <service-id>
```

## Output Formats

Use structured output for scripts and agents:

```sh
node ./src/index.ts whoami --format json
node ./src/index.ts services --format yaml
node ./src/index.ts whoami --schema
```

Short aliases are also supported:

```sh
node ./src/index.ts whoami -j
node ./src/index.ts whoami -t
```

## Configuration

Useful environment variables:

- `TEMPO_HOME`: override where wallet data is stored.
- `TEMPO_AUTH_URL`: override the wallet auth URL.
- `TEMPO_SERVICES_URL`: override the MPP service directory URL.
- `TEMPO_WALLET_DISABLE_BROWSER_OPEN`: disable browser opening.
- `TEMPO_WALLET_FUND_TIMEOUT_MS`: funding wait timeout.
- `TEMPO_WALLET_FUND_POLL_INTERVAL_MS`: funding balance poll interval.
- `TEMPO_WALLET_POLL_INTERVAL_MS`: auth polling interval.

## Debug

Collect support info:

```sh
node ./src/index.ts debug
```

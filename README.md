# CONIC (CKB Over Nostr Intend Coordination)

CONIC is an intention layer for CKB over Nostr.

## Stack

- Runtime: Node 24+ or Bun 1.3+
- Package manager: `pnpm`
- Language: TypeScript
- Testing: Vitest

## Local Dev Services

This repo includes a local CKB devnet powered by `offckb` and a local Nostr relay via Docker.

Build the devnet image:

```sh
pnpm run devnet:build
```

Start both services:

```sh
pnpm run devnet:up
```

Other lifecycle commands:

```sh
pnpm run devnet:stop
pnpm run devnet:start
pnpm run devnet:restart
pnpm run devnet:recreate
```

Default endpoints:

- CKB RPC: `http://127.0.0.1:28114`
- Nostr relay: `ws://127.0.0.1:8080`

## Install

```sh
pnpm install
```

## Checks

`test:unit` and `test:coinjoin` automatically:

1. start `conic-ckb-node` and `nostr-relay`
2. run the test command
3. stop both services when the command exits

If you want to run the raw commands without the Docker wrapper, use:

```sh
pnpm run test:unit:raw
pnpm run test:coinjoin:raw
```

Repository preflight:

```sh
pnpm run preflight
```

Wrapped unit suite:

```sh
pnpm run test:unit
```

Full CoinJoin integration flow:

```sh
pnpm run test:coinjoin
```

You can also run it directly with:

```sh
pnpm run test:coinjoin:raw
```

## Devnet Script Metadata

`DevnetCkbService` and the CKB smoke/integration helpers try to export devnet system scripts from `offckb` first:

```sh
offckb system-scripts --export-style ccc
```

If `offckb` is not installed on the host, the code falls back to:

```sh
docker exec conic-ckb-node offckb system-scripts --export-style ccc
```

This is important because CCC's default public-testnet metadata does not match the local devnet.

Do not set `CI=true` locally to force a different code path. The current implementation always attempts the OffCKB/devnet script export first and only falls back if that export is unavailable.

## Cleanup

Stop and remove local dev services:

```sh
docker compose -f docker-compose.dev.yml down -v --remove-orphans
```

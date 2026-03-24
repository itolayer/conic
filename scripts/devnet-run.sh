#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 1
fi

wait_for_ckb_rpc() {
  local rpc_url="${CKB_RPC_URL:-http://127.0.0.1:28114}"
  local deadline=$((SECONDS + 60))

  while (( SECONDS < deadline )); do
    if curl -fsS \
      -H 'content-type: application/json' \
      -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_block_number","params":[]}' \
      "${rpc_url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "CKB devnet RPC did not become ready at ${rpc_url} within 60 seconds" >&2
  return 1
}

cleanup() {
  docker compose -f docker-compose.dev.yml stop conic-ckb-node nostr-relay >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

docker compose -f docker-compose.dev.yml up -d conic-ckb-node nostr-relay
wait_for_ckb_rpc

"$@"

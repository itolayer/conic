#!/usr/bin/env bash
set -euo pipefail

OFFCKB_VERSION="${OFFCKB_CKB_VERSION:-0.205.0}"
OFFCKB_CONFIG_DIR="${HOME:-/offckb-home}/.config/offckb-nodejs"
DEVNET_DIR="${HOME:-/offckb-home}/.local/share/offckb-nodejs/devnet"
MINER_CONFIG_PATH="${DEVNET_DIR}/ckb-miner.toml"

mkdir -p "${OFFCKB_CONFIG_DIR}"
if [[ ! -f "${OFFCKB_CONFIG_DIR}/settings.json" ]]; then
  echo "{\"bins\": {\"defaultCKBVersion\": \"${OFFCKB_VERSION}\"}}" > "${OFFCKB_CONFIG_DIR}/settings.json"
fi

if [[ $# -eq 0 ]]; then
  set -- offckb node "${OFFCKB_VERSION}"
fi

child_pid=""

initialize_devnet_config() {
  if [[ -f "${MINER_CONFIG_PATH}" ]]; then
    return
  fi

  offckb node "${OFFCKB_VERSION}" >/tmp/offckb-init.log 2>&1 &
  local init_pid=$!

  for _ in $(seq 1 60); do
    if [[ -f "${MINER_CONFIG_PATH}" ]]; then
      break
    fi
    sleep 1
  done

  kill -TERM "${init_pid}" 2>/dev/null || true
  pkill -f '/ckb run -C' 2>/dev/null || true
  pkill -f '/ckb miner -C' 2>/dev/null || true
  wait "${init_pid}" 2>/dev/null || true
}

apply_devnet_tuning() {
  initialize_devnet_config

  offckb devnet config --set miner.client.poll_interval=1000 >/tmp/offckb-config.log 2>&1 || true
  if [[ -f "${MINER_CONFIG_PATH}" ]]; then
    sed -i 's/poll_interval = .*/poll_interval = 1_000/' "${MINER_CONFIG_PATH}"
    sed -i 's/value = .*/value = 1_000/' "${MINER_CONFIG_PATH}"
  fi
}

shutdown() {
  trap - TERM INT

  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    kill -TERM "${child_pid}" 2>/dev/null || true
  fi

  pkill -f '/ckb run -C' 2>/dev/null || true
  pkill -f '/ckb miner -C' 2>/dev/null || true

  if [[ -n "${child_pid}" ]]; then
    wait "${child_pid}" 2>/dev/null || true
  fi
}

trap shutdown TERM INT

apply_devnet_tuning

"$@" &
child_pid=$!
wait "${child_pid}"

#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -lt 1 ]; then
  echo '用法: ./scripts/start-shen-local.sh /绝对路径/模型环境文件.env [其他外部配置.env]' >&2
  exit 1
fi
for file do
  case "$file" in /*) ;; *) echo '环境文件须为绝对路径' >&2; exit 1 ;; esac
  [ -f "$file" ] || { echo '指定的环境文件不存在' >&2; exit 1; }
done
CHAT_HOST=127.0.0.1
PORT=4334
CHAT_STORAGE_MODE=browser
CHAT_PUBLIC_ORIGIN=http://localhost:4334
CHAT_CATALOG_PATH="$PWD/data/public-catalog.sqlite"
CHAT_DB_PATH="$PWD/data/unused-private.sqlite"
CHAT_LOCAL_NO_AUTH=1
ARK_THINKING=disabled
ARK_REASONING_EFFORT=
export CHAT_HOST PORT CHAT_STORAGE_MODE CHAT_PUBLIC_ORIGIN CHAT_CATALOG_PATH CHAT_DB_PATH CHAT_LOCAL_NO_AUTH ARK_THINKING ARK_REASONING_EFFORT
# Keep configuration paths as individual argv entries, with no eval or shell interpolation.
set -- "$@" --
while [ "$1" != -- ]; do
  file=$1
  shift
  set -- "$@" "--env-file=$file"
done
shift
exec node --env-file=config/runtime.env "$@" server.mjs

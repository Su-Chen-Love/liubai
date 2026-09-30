#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 22.13 或更高版本。'
  read -k 1
  exit 1
fi
if [ ! -d node_modules/vinext ]; then
  npm ci --no-audit --no-fund || exit 1
fi
npm run local

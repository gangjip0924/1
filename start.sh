#!/usr/bin/env sh
# 태생 설계도 실행 (macOS/Linux 개발용). Windows에서는 start.bat을 쓴다.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 18 이상이 필요합니다."; exit 1; }
( sleep 2; (xdg-open http://127.0.0.1:41234/ || open http://127.0.0.1:41234/) >/dev/null 2>&1 ) &
exec node server.js

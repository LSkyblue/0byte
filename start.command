#!/bin/zsh
cd "$(dirname "$0")"
echo "启动 0byte…（这个窗口别关，电脑也别让它睡）"
exec caffeinate -i node server.mjs

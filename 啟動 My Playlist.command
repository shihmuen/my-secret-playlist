#!/bin/zsh
# My Playlist Widget 啟動器：雙擊即可開啟桌面播放器
cd "$(dirname "$0")"
# 已經在跑就不重複開
if pgrep -f "my-playlist/node_modules/electron" > /dev/null; then
  echo "My Playlist 已經在桌面上囉"
  exit 0
fi
nohup npm start > /dev/null 2>&1 &
echo "My Playlist 啟動中…（本視窗可關閉）"

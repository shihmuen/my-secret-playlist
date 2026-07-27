// My Playlist — Electron 主程序
// 職責：開一個無邊框透明小視窗 + 每秒用 AppleScript 問 Music App 播放狀態

const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let win = null;
let lastId = null;

// ── AppleScript：讀取正在播放的資訊（一行一個欄位） ──
const NOW_SCRIPT = `
tell application "Music"
  set st to player state
  if st is playing or st is paused then
    set t to current track
    return (st as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (player position as text) & linefeed & (duration of t as text) & linefeed & (persistent ID of t)
  else
    return "stopped"
  end if
end tell`;

// ── AppleScript：把目前這首的封面存成圖檔 ──
function artScript(filePath) {
  return `
tell application "Music"
  set t to current track
  if (count of artworks of t) > 0 then
    set d to raw data of artwork 1 of t
    set f to open for access POSIX file "${filePath}" with write permission
    set eof f to 0
    write d to f
    close access f
    return "ok"
  else
    return "none"
  end if
end tell`;
}

function osa(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

async function poll() {
  if (!win) return;
  const out = await osa(NOW_SCRIPT);

  if (!out || out === "stopped") {
    win.webContents.send("now-playing", { state: "stopped" });
    return;
  }

  const [state, name, artist, pos, dur, id] = out.split("\n");
  let art = path.join(os.tmpdir(), `my-playlist-art-${id}.png`);

  if (id !== lastId) {
    if (!fs.existsSync(art)) {
      const ok = await osa(artScript(art));
      if (ok !== "ok") art = null;
    }
    lastId = id;
  } else if (!fs.existsSync(art)) {
    art = null;
  }

  win.webContents.send("now-playing", {
    state,
    name,
    artist,
    pos: parseFloat(pos),
    dur: parseFloat(dur),
    id,
    art,
  });
}

// ── 播放控制（白名單指令） ──
const COMMANDS = {
  playpause: "playpause",
  next: "next track",
  prev: "previous track",
};
ipcMain.on("control", (_e, cmd) => {
  if (COMMANDS[cmd]) osa(`tell application "Music" to ${COMMANDS[cmd]}`);
});

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 580,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.loadFile("widget.html");
  win.on("closed", () => (win = null));
}

app.whenReady().then(() => {
  createWindow();
  poll();
  setInterval(poll, 1000);
});

app.on("window-all-closed", () => app.quit());

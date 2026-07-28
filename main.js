// My Playlist — Electron 主程序
// 職責：開一個無邊框透明小視窗 + 每秒用 AppleScript 問 Music App 播放狀態

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let win = null;
let lastId = null;

// ── AppleScript：讀取正在播放的資訊（一行一個欄位） ──
const NOW_SCRIPT = `
tell application "Music"
  set ps to player state
  if ps is playing or ps is paused then
    set t to current track
    return (ps as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (player position as text) & linefeed & (duration of t as text) & linefeed & (persistent ID of t)
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

// log 與位置紀錄放 userData（打包成 .app 後 __dirname 是唯讀的）
const userDir = () => app.getPath("userData");
const LOG = () => path.join(userDir(), "debug.log");
const POS_FILE = () => path.join(userDir(), "position.json");
function osa(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        fs.appendFile(LOG(), `[${new Date().toISOString()}] osascript error: ${(stderr || err.message).trim()}\n`, () => {});
      }
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

// ── 假毛玻璃：抓桌布圖，連同視窗座標送給畫面對位 ──
const WALL_SCRIPT = `tell application "System Events" to get picture of current desktop`;
let wallPath = null;
let wallSrcKey = null;

async function fetchWallpaper() {
  let p = await osa(WALL_SCRIPT);
  if (!p) return;
  p = p.trim();
  let key;
  try { key = p + ":" + fs.statSync(p).mtimeMs; } catch (e) { return; }
  if (key === wallSrcKey) return;   // 桌布沒換就不重做
  // 原圖可能超大（百 MB 級）或 HEIC；統一縮成 1600px JPEG（模糊用，細節無感）
  const out = path.join(os.tmpdir(), "my-playlist-wall.jpg");
  await new Promise((r) => execFile("sips", ["-s", "format", "jpeg", "-Z", "1600", p, "--out", out], () => r()));
  if (!fs.existsSync(out)) return;
  wallSrcKey = key;
  wallPath = out;
  sendGlass();
}

function sendGlass() {
  if (!win || !wallPath) return;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  win.webContents.send("glass", {
    path: wallPath,
    dw: d.bounds.width,
    dh: d.bounds.height,
    wx: b.x - d.bounds.x,
    wy: b.y - d.bounds.y,
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

// ── 視窗位置＋大小記憶：拖到哪、縮多大，下次開就照舊 ──
const ASPECT = 380 / 420;

function loadBounds() {
  try {
    const p = JSON.parse(fs.readFileSync(POS_FILE(), "utf8"));
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch (e) {}
  return null;
}

function saveBounds() {
  if (!win) return;
  const b = win.getBounds();
  fs.writeFile(POS_FILE(), JSON.stringify(b), () => {});
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved?.width || 380,
    height: saved?.height || 420,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 240,
    minHeight: 265,
    maxWidth: 800,
    maxHeight: 884,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,              // 從視窗邊緣拖曳縮放
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.setAspectRatio(ASPECT);     // 鎖定比例，縮放不變形
  win.loadFile("widget.html");
  win.webContents.on("did-finish-load", sendGlass);
  win.on("move", sendGlass);      // 拖曳中即時對位模糊桌布
  win.on("resize", sendGlass);
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.on("closed", () => (win = null));
}

app.whenReady().then(() => {
  createWindow();
  poll();
  setInterval(poll, 1000);
  fetchWallpaper();
  setInterval(fetchWallpaper, 60000);   // 桌布換了最慢一分鐘內跟上
});

app.on("window-all-closed", () => app.quit());

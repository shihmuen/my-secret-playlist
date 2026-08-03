// My Playlist — Electron 主程序
// 職責：開一個無邊框透明小視窗 + 每秒用 AppleScript 問 Music App 播放狀態

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("child_process");

const isWin = process.platform === "win32";
const fs = require("fs");
const os = require("os");
const path = require("path");

let win = null;
let lastId = null;

// ── AppleScript：讀取正在播放的資訊（一行一個欄位）──
// 「is running」防護：避免 tell 到沒開的 App 把它整個叫起來
const MUSIC_SCRIPT = `
if application "Music" is running then
  tell application "Music"
    set ps to player state
    if ps is playing or ps is paused then
      set t to current track
      return (ps as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (player position as text) & linefeed & (duration of t as text) & linefeed & (persistent ID of t)
    end if
  end tell
end if
return "stopped"`;

// Spotify 的接口幾乎同構：duration 是毫秒、封面直接給網址
const SPOTIFY_SCRIPT = `
if application "Spotify" is running then
  tell application "Spotify"
    set ps to player state
    if ps is playing or ps is paused then
      set t to current track
      return (ps as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (player position as text) & linefeed & (((duration of t) / 1000) as text) & linefeed & (id of t) & linefeed & (artwork url of t)
    end if
  end tell
end if
return "stopped"`;

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

function parseNow(out, src) {
  if (!out || out === "stopped") return null;
  const parts = out.split("\n");
  if (parts.length < 6) return null;
  const [state, name, artist, pos, dur, id, artUrl] = parts;
  return { state, name, artist, pos: parseFloat(pos), dur: parseFloat(dur), id, artUrl: artUrl || null, src };
}

// 下載 Spotify 封面（https，跟一層轉址）
function download(url, dest) {
  return new Promise((resolve) => {
    const get = (u, hops) => {
      if (hops > 2) return resolve(false);
      require("https").get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on("finish", () => ws.close(() => resolve(true)));
        ws.on("error", () => resolve(false));
      }).on("error", () => resolve(false));
    };
    get(url, 0);
  });
}

const hasSpotify = () => fs.existsSync("/Applications/Spotify.app");
let lastSrc = null;

// 檔案存在還不夠：抽封面失敗時會留下 0 byte 的空檔，沿用它畫面就是空的
function hasBytes(p) {
  try { return fs.statSync(p).size > 0; } catch (e) { return false; }
}

// ── 封面備援：iTunes Search API ──
// Apple Music 串流曲目（class 為 "URL track"、沒加進資料庫的）AppleScript 讀到的
// artworks 是空的——Music App 畫面上那張是它自己連網抓的，不在本機物件裡。
// 拿歌手＋歌名去 Apple 官方的 Search API 查同一張圖（免金鑰）。
const noArtOnline = new Set();   // 查無結果的別一直重打

function itunesArt(artist, name) {
  return new Promise((resolve) => {
    const term = `${artist || ""} ${name || ""}`.trim();
    if (!term) return resolve(null);
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    const req = require("https").get(url, { headers: { "User-Agent": "my-playlist" } }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => {
        try {
          const r = JSON.parse(s).results[0];
          // artworkUrl100 換成 600x600 才夠碟片放大用
          resolve(r && r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.") : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
  });
}

async function poll() {
  if (!win) return;
  const m = parseNow(await osa(MUSIC_SCRIPT), "music");
  const s = hasSpotify() ? parseNow(await osa(SPOTIFY_SCRIPT), "spotify") : null;

  // 誰在播誰上場；兩邊都有聲音（或都暫停）時，跟著上一次的來源避免跳動
  const candidates = [m, s].filter(Boolean);
  const playing = candidates.filter((c) => c.state === "playing");
  const paused = candidates.filter((c) => c.state === "paused");
  const pick = (arr) => arr.find((c) => c.src === lastSrc) || arr[0];
  const cur = playing.length ? pick(playing) : paused.length ? pick(paused) : null;

  if (!cur) {
    lastSrc = null;
    win.webContents.send("now-playing", { state: "stopped" });
    return;
  }
  lastSrc = cur.src;

  // 封面：Music 用 raw data 抽檔、Spotify 下載網址圖；一律轉 data URL（canvas 取色需要）
  const key = (cur.src + "-" + cur.id).replace(/[^A-Za-z0-9_-]/g, "");
  const artFile = path.join(os.tmpdir(), `my-playlist-art-${key}.png`);

  if (cur.id !== lastId) {
    if (!hasBytes(artFile)) {
      if (cur.src === "music") await osa(artScript(artFile));
      else if (cur.artUrl) await download(cur.artUrl, artFile);
    }
    // 本機真的沒有（串流曲目）→ 上網補一張
    if (!hasBytes(artFile) && !noArtOnline.has(key)) {
      const u = await itunesArt(cur.artist, cur.name);
      if (u) await download(u, artFile);
      if (!hasBytes(artFile)) noArtOnline.add(key);
    }
    lastId = cur.id;
  }

  let art = null;
  if (artCache.has(key)) {
    art = artCache.get(key);
  } else if (hasBytes(artFile)) {
    // 這個檔可能是 AppleScript 抽出來的原始資料、也可能是網路下載的 JPEG，
    // 副檔名不代表內容 → 看檔頭決定 MIME，別讓 canvas 取色因為型別不符失敗
    const buf = fs.readFileSync(artFile);
    const mime = buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : "image/png";
    art = `data:${mime};base64,` + buf.toString("base64");
    artCache.set(key, art);
    if (artCache.size > 20) artCache.delete(artCache.keys().next().value);
  }

  win.webContents.send("now-playing", {
    state: cur.state,
    name: cur.name,
    artist: cur.artist,
    pos: cur.pos,
    dur: cur.dur,
    id: cur.id,
    src: cur.src,
    art,
  });
}
const artCache = new Map();

// ── Windows 資料來源：長駐 PowerShell 讀系統媒體佈告欄（SMTC），一行一筆 JSON ──
let winProc = null;

function startWinSource() {
  winProc = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "smtc.ps1")],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let buf = "";
  winProc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handleWinNow(JSON.parse(line)); } catch (e) {}
    }
  });
  winProc.stderr.on("data", (d) =>
    fs.appendFile(LOG(), `[${new Date().toISOString()}] smtc: ${d.toString().trim()}\n`, () => {})
  );
  winProc.on("exit", () => {
    winProc = null;
    setTimeout(startWinSource, 3000);   // 意外死掉就重啟
  });
}

function handleWinNow(j) {
  if (!win) return;
  if (j.state === "stopped") {
    win.webContents.send("now-playing", { state: "stopped" });
    return;
  }
  let art = null;
  if (typeof j.art === "string" && j.art) {
    if (artCache.has(j.id)) {
      art = artCache.get(j.id);
    } else if (fs.existsSync(j.art)) {
      art = "data:image/jpeg;base64," + fs.readFileSync(j.art).toString("base64");
      artCache.set(j.id, art);
      if (artCache.size > 20) artCache.delete(artCache.keys().next().value);
    }
  }
  win.webContents.send("now-playing", {
    state: j.state,
    name: j.title,
    artist: j.artist,
    pos: j.pos,
    dur: j.dur,
    id: j.id,
    src: "smtc",
    art,
  });
}

// ── 播放控制（白名單指令；依平台與目前來源路由） ──
const COMMANDS = {
  playpause: "playpause",
  next: "next track",
  prev: "previous track",
};
ipcMain.on("control", (_e, cmd) => {
  if (!COMMANDS[cmd]) return;
  if (isWin) {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "smtc-cmd.ps1"), cmd],
      { timeout: 8000, windowsHide: true },
      () => {}
    );
    return;
  }
  const target = lastSrc === "spotify" ? "Spotify" : "Music";
  osa(`tell application "${target}" to ${COMMANDS[cmd]}`);
});

// ── 右下角把手縮放：鎖比例、限制範圍 ──
ipcMain.on("resize-to", (_e, w) => {
  if (!win || !Number.isFinite(w)) return;
  const width = Math.max(240, Math.min(800, Math.round(w)));
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width, height: Math.round(width / ASPECT) });
});
ipcMain.on("resize-end", () => saveBounds());

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
      // widget 常被其他視窗蓋住；不關掉節流的話動畫會被凍結、換片動作卡住
      backgroundThrottling: false,
    },
  });
  win.setAspectRatio(ASPECT);     // 鎖定比例，縮放不變形
  win.loadFile("widget.html");
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.on("closed", () => (win = null));
}

// ── 新版本提醒：定期問 GitHub 最新 Release，比自己新就通知畫面 ──
const SITE_URL = "https://my-secret-playlist.vercel.app";

function isNewer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function checkUpdate() {
  const req = require("https").get(
    {
      hostname: "api.github.com",
      path: "/repos/shihmuen/my-secret-playlist/releases/latest",
      headers: { "User-Agent": "my-playlist", Accept: "application/vnd.github+json" },
    },
    (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => {
        try {
          const tag = (JSON.parse(s).tag_name || "").replace(/^v/, "");
          if (tag && isNewer(tag, app.getVersion()) && win) {
            win.webContents.send("update-available", tag);
          }
        } catch (e) {}
      });
    }
  );
  req.on("error", () => {});
}

ipcMain.on("open-download", () => shell.openExternal(SITE_URL));

app.whenReady().then(() => {
  createWindow();
  if (isWin) {
    startWinSource();
  } else {
    poll();
    setInterval(poll, 1000);
  }
  setTimeout(checkUpdate, 5000);              // 開機後五秒查一次
  setInterval(checkUpdate, 6 * 3600 * 1000);  // 之後每六小時
});

app.on("window-all-closed", () => app.quit());

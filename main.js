/* 谱领航 TabPilot 桌面版（Electron 壳）
 * 自定义 app:// 协议：
 *  - standard+secure → 页面处于安全上下文，麦克风 getUserMedia 可用
 *  - supportFetchAPI → alphaTab 能 fetch 本地音色 vendor/sonivox.sf3（file:// 下会被 CORS 拦截）
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

// 本应用为 2D 界面（SVG/canvas），软件渲染完全够用；
// 禁用硬件加速 + 进程内 GPU，避免 GPU 驱动/沙箱异常时启动崩溃，提升兼容性
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function serve(url) {
  // app://local/index.html → ROOT/index.html（防目录穿越）
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return new Response('not found', { status: 404 });
  }
  const ext = path.extname(abs).toLowerCase();
  return new Response(fs.readFileSync(abs), {
    headers: { 'content-type': MIME[ext] || 'application/octet-stream' },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 500,
    title: '谱领航 TabPilot · 吉他谱跟随',
    icon: path.join(ROOT, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadURL('app://local/index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => serve(req.url));

  // 放行麦克风（跟随功能需要）
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'audioCapture', 'fullscreen', 'notifications'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return ['media', 'audioCapture', 'fullscreen', 'notifications'].includes(permission);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

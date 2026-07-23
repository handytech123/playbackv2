const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

let mainWindow;
let serverProcess;
let logFile;

app.commandLine.appendSwitch("high-dpi-support", "1");
app.commandLine.appendSwitch("enable-gpu-rasterization");

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

const localUserDataDir = appUserDataDir();
fs.mkdirSync(localUserDataDir, { recursive: true });
app.setPath("userData", localUserDataDir);

async function createWindow() {
  const port = await findOpenPort(Number(process.env.PORT || 5312));
  const appUrl = `http://127.0.0.1:${port}`;

  log(`Starting Playback App V2 at ${appUrl}`);
  startServer(port);
  await waitForServer(appUrl);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Playback App V2",
    backgroundColor: "#111417",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    if (input.key === "F5" || ((input.control || input.meta) && key === "r")) {
      event.preventDefault();
      mainWindow.reload();
    }
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  await mainWindow.loadURL(appUrl);
}

ipcMain.handle("dialog:select-wav-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select WAV file",
    properties: ["openFile"],
    filters: [
      { name: "WAV files", extensions: ["wav"] }
    ]
  });

  return result.canceled ? "" : result.filePaths[0];
});

ipcMain.handle("dialog:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select folder",
    properties: ["openDirectory"]
  });

  return result.canceled ? "" : result.filePaths[0];
});

function startServer(port) {
  const serverPath = path.join(app.getAppPath(), "server.js");
  const dataDir = appDataDir();
  migratePackagedDataDir(dataDir);

  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      PLAYBACK_DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  serverProcess.stdout.on("data", (chunk) => {
    log(`[server] ${chunk.toString().trim()}`);
  });

  serverProcess.stderr.on("data", (chunk) => {
    log(`[server error] ${chunk.toString().trim()}`);
  });

  serverProcess.on("exit", (code) => {
    log(`Server exited with code ${code}.`);
    if (code !== 0 && !app.isQuiting) {
      dialog.showErrorBox("Playback server stopped", `The local server exited with code ${code}.`);
    }
  });
}

function findOpenPort(startPort) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const tester = net.createServer()
        .once("error", () => tryPort(port + 1))
        .once("listening", () => {
          tester.close(() => resolve(port));
        })
        .listen(port);
    };

    tryPort(startPort);
  });
}

function waitForServer(url) {
  const deadline = Date.now() + 10000;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server did not start at ${url}`));
          return;
        }
        setTimeout(attempt, 150);
      });

      req.setTimeout(1000, () => {
        req.destroy();
      });
    };

    attempt();
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  serverProcess = null;
}

function log(message) {
  try {
    if (!logFile) {
      logFile = path.join(appDataDir(), "logs", "electron.log");
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (error) {
    console.error(error);
  }
  console.log(message);
}

function appDataDir() {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), "data");
  }
  const appFolder = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return path.join(appFolder, "data");
}

function appUserDataDir() {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), "userData");
  }
  const appFolder = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return path.join(appFolder, "userData");
}

function migratePackagedDataDir(nextDataDir) {
  if (!app.isPackaged) return;
  const previousDataDir = path.join(app.getPath("userData"), "data");
  try {
    if (fs.existsSync(nextDataDir) || !fs.existsSync(previousDataDir)) return;
    fs.mkdirSync(path.dirname(nextDataDir), { recursive: true });
    fs.cpSync(previousDataDir, nextDataDir, { recursive: true });
  } catch (error) {
    log(`Data migration skipped: ${error.message}`);
  }
}

app.whenReady()
  .then(createWindow)
  .catch((error) => {
    dialog.showErrorBox("Playback App V2 failed to start", error.message);
    app.quit();
  });

app.on("before-quit", () => {
  app.isQuiting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

let mainWindow;
let serverProcess;
let serverPort;
let logFile;

app.commandLine.appendSwitch("high-dpi-support", "1");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-features", "WebMidi");

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
  serverPort = port;
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

  installApplicationMenu();
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "midi") {
      callback(true);
      return;
    }
    if (permission === "midiSysex") {
      callback(false);
      return;
    }
    callback(false);
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    if (input.key === "F5") {
      event.preventDefault();
      sendMenuCommand("reloadData");
    } else if ((input.control || input.meta) && key === "r") {
      event.preventDefault();
      mainWindow.reload();
    }
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  await mainWindow.loadURL(appUrl);
}

function installApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        menuCommand("Export Set Package", "exportSetPackage"),
        menuCommand("Import Set Package", "importSetPackage"),
        { type: "separator" },
        menuCommand("Save Draft", "saveDraft"),
        menuCommand("Confirm Set", "confirmSet"),
        { type: "separator" },
        { label: "Exit", role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        menuCommand("Undo", "undo"),
        { type: "separator" },
        menuCommand("Split At Playhead", "splitAtPlayhead"),
        menuCommand("Delete Selection", "deleteSelection"),
        menuCommand("Remove + Close Gap", "removeCloseGap")
      ]
    },
    {
      label: "View",
      submenu: [
        menuCommand("Reload App Data", "reloadData", "F5"),
        { type: "separator" },
        menuCommand("Toggle Mixer", "toggleMixer", "Ctrl+M"),
        menuCommand("Reset Mixer Height", "resetMixerHeight"),
        { type: "separator" },
        menuCommand("Zoom In", "zoomIn", "Ctrl+="),
        menuCommand("Zoom Out", "zoomOut", "Ctrl+-")
      ]
    },
    {
      label: "Library",
      submenu: [
        menuCommand("Refresh Library", "refreshLibrary"),
        menuCommand("Open Library Settings", "openLibrarySettings")
      ]
    },
    {
      label: "Playback",
      submenu: [
        menuCommand("Play", "play"),
        menuCommand("Pause", "pause"),
        menuCommand("Stop", "stop"),
        menuCommand("Return To Start", "seek", "Home"),
        { type: "separator" },
        menuCommand("Cue Next", "songTransition"),
        menuCommand("Test ProPresenter Next Slide", "testProPresenterMidi"),
        menuCommand("Toggle Pad", "togglePad"),
        menuCommand("Panic", "panic")
      ]
    },
    {
      label: "Audio",
      submenu: [
        menuCommand("Audio & Routing Settings", "openAudioSettings"),
        menuCommand("Refresh Audio Devices", "refreshAudioDevices"),
        menuCommand("Open Dante Matrix", "openDanteMatrix")
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open App Data Folder",
          click: () => shell.openPath(appDataDir())
        },
        {
          label: "Show Logs",
          click: () => shell.openPath(path.dirname(logFile || path.join(appDataDir(), "logs", "electron.log")))
        },
        { type: "separator" },
        {
          label: "About Playback App V2",
          click: () => dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "About Playback App V2",
            message: "Playback App V2",
            detail: `Version ${app.getVersion()}\nData: ${appDataDir()}`
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function menuCommand(label, command, accelerator) {
  return {
    label,
    accelerator,
    click: () => sendMenuCommand(command)
  };
}

function sendMenuCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("menu:command", command);
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

ipcMain.handle("set-package:save", async (_event, packagePayload) => {
  const safeDate = new Date().toISOString().slice(0, 10);
  const title = String(packagePayload?.summary?.titles?.[0] || "set").replace(/[<>:"/\\|?*]+/g, "-").slice(0, 48);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Set Package",
    defaultPath: path.join(defaultPackageFolder(), `${safeDate}-${title}.playbackset.zip`),
    filters: [
      { name: "Playback Set Package", extensions: ["zip"] },
      { name: "Zip files", extensions: ["zip"] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const zip = createSingleFileZip("playback-set-package.json", `${JSON.stringify(packagePayload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, zip);
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle("set-package:open", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Set Package",
    defaultPath: defaultPackageFolder(),
    properties: ["openFile"],
    filters: [
      { name: "Playback Set Package", extensions: ["zip"] },
      { name: "Zip files", extensions: ["zip"] },
      { name: "JSON files", extensions: ["json"] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  const text = filePath.toLowerCase().endsWith(".json")
    ? buffer.toString("utf8")
    : readSingleFileZip(buffer, "playback-set-package.json");
  return { ok: true, filePath, package: JSON.parse(text.replace(/^\uFEFF/, "")) };
});

ipcMain.handle("remote:configure-firewall", async () => {
  const port = Number(serverPort || process.env.PORT || 5312);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "The remote server port is invalid." };
  }
  const command = [
    `$rule = Start-Process -FilePath "$env:SystemRoot\\System32\\netsh.exe"`,
    "-Verb RunAs",
    "-ArgumentList @(",
    "'advfirewall','firewall','add','rule',",
    "'name=Playback-App-V2-Remote','dir=in','action=allow','protocol=TCP',",
    `'localport=${port}','profile=private,public','remoteip=localsubnet'`,
    ") -Wait -PassThru;",
    "exit $rule.ExitCode"
  ].join(" ");

  return new Promise((resolveConfigure) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", command
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    child.once("error", (error) => {
      resolveConfigure({ ok: false, error: error.message });
    });
    child.once("exit", (code) => {
      resolveConfigure(code === 0
        ? { ok: true, port, ruleName: "Playback-App-V2-Remote" }
        : { ok: false, error: errorText.trim() || "Administrator approval was canceled or Windows rejected the firewall rule." });
    });
  });
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

async function stopServer() {
  const child = serverProcess;
  if (!child || child.exitCode !== null) {
    serverProcess = null;
    return;
  }

  await requestServerShutdown().catch((error) => {
    log(`Graceful playback shutdown failed: ${error.message}`);
  });

  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
  }
  if (child.exitCode === null && !child.killed) child.kill();
  serverProcess = null;
}

function requestServerShutdown() {
  if (!serverPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: serverPort,
      path: "/api/runtime/shutdown",
      method: "POST"
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.setTimeout(3000, () => {
      request.destroy(new Error("Playback shutdown timed out."));
    });
    request.once("error", reject);
    request.end();
  });
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

function defaultPackageFolder() {
  const worshipFolder = "D:\\Dropbox\\Worship";
  return fs.existsSync(worshipFolder) ? worshipFolder : app.getPath("documents");
}

function createSingleFileZip(fileName, text) {
  const name = Buffer.from(fileName, "utf8");
  const source = Buffer.from(text, "utf8");
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const localRecord = Buffer.concat([local, name, compressed]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localRecord, centralRecord, end]);
}

function readSingleFileZip(buffer, expectedName) {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const dataStart = nameStart + fileNameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === expectedName) {
      if (method === 0) return data.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
      throw new Error("Unsupported package compression.");
    }
    offset = dataStart + compressedSize;
  }
  throw new Error("Playback set package data was not found.");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

app.whenReady()
  .then(createWindow)
  .catch((error) => {
    dialog.showErrorBox("Playback App V2 failed to start", error.message);
    app.quit();
  });

app.on("before-quit", (event) => {
  if (app.isQuiting) return;
  event.preventDefault();
  app.isQuiting = true;
  stopServer().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

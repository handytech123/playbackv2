import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 5312);
const ROOT = "D:\\Dropbox\\Worship\\Backing Tracks";
const VENDORS = ["Loop Community", "Multitracks"];
const DATA_DIR = process.env.PLAYBACK_DATA_DIR
  ? resolve(process.env.PLAYBACK_DATA_DIR)
  : join(__dirname, "data");
const LIBRARY_FILE = join(DATA_DIR, "library.json");
const SETLIST_FILE = join(DATA_DIR, "current-setlist.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const PLAYBACK_STATE_FILE = join(DATA_DIR, "playback-state.json");
const CONFIRMED_SET_FILE = join(DATA_DIR, "confirmed-set.json");
const ENGINE_MANIFEST_FILE = join(DATA_DIR, "playback-engine-manifest.json");
const ENGINE_STATUS_FILE = join(DATA_DIR, "engine-status.json");
const SET_METADATA_DIR = join(DATA_DIR, "set-metadata", "current");
const CACHE_DIR = join(DATA_DIR, "cache");
const ARRANGEMENT_CACHE_DIR = join(DATA_DIR, "arrangement-cache", "current");
const SONG_METADATA_DIR = join(DATA_DIR, "song-metadata");
const APP_PADS_DIR = join(__dirname, "pads");
const DYNAMIC_PAD_CACHE_DIR = join(CACHE_DIR, "dynamic-pads");
const PUBLIC_DIR = join(__dirname, "public");
const ENGINE_HELPER = "juce-audio-engine";
const ENGINE_PROTOCOL_VERSION = 1;
const ENGINE_HEARTBEAT_GRACE_MS = 3000;
const ENGINE_COMMAND_TIMEOUT_MS = 8000;
const WAVEFORM_BUCKETS = 1800;
const WAVEFORM_READ_FRAMES = 4096;
const WAVEFORM_MAX_STEMS = 24;
const ANALYZER_EXE_CANDIDATES = [
  process.env.WAV_SONG_ANALYZER_EXE,
  "D:\\WavSongAnalyzer\\dist\\python-analyzer\\song-analyzer\\song-analyzer.exe"
].filter(Boolean);
const ENGINE_HELPER_CANDIDATES = [
  process.env.JUCE_AUDIO_ENGINE_PATH,
  join(__dirname, "native", "juce-audio-engine", "bin", "win-x64", "juce-audio-engine.exe"),
  join(__dirname, "native", "juce-audio-engine", "build", "juce-audio-engine_artefacts", "Release", "juce-audio-engine.exe"),
  join(__dirname, "native", "juce-audio-engine", "build", "juce-audio-engine_artefacts", "Debug", "juce-audio-engine.exe")
].filter(Boolean);
let activePlaybackProcess = null;
let playbackCommandQueue = Promise.resolve();
let latestPlaybackMeters = {
  active: false,
  slot: null,
  title: "",
  stems: [],
  updatedAt: ""
};
const meterStreamClients = new Set();
let meterStreamTimer = null;
let meterStreamInFlight = false;
const PANIC_TRACK_FADE_DOWN_MS = 1000;
const PANIC_RECOVERY_FADE_MS = 4000;
const PANIC_TRACK_TARGET_DB = -60;
const PANIC_TRACK_GAIN = 0.001;
const PANIC_STATES = {
  NORMAL: "NORMAL",
  PANIC_HOLD: "PANIC_HOLD"
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav"
};

initializeRuntimeOnStartup().catch((error) => {
  console.error(`Startup runtime init failed: ${error.message}`);
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/library") {
      return json(res, await loadLibrary());
    }

    if (req.method === "POST" && url.pathname === "/api/library/refresh") {
      const autoAnalyzeLimit = url.searchParams.has("autoAnalyzeLimit")
        ? Math.max(0, Number(url.searchParams.get("autoAnalyzeLimit")) || 0)
        : 0;
      const library = await scanLibrary({ autoAnalyzeLimit });
      await saveLibrary(library);
      let setlist = syncSetlistWithLibrary(await loadCurrentSetlist(), library);
      setlist = await prepareSetlistCache(setlist);
      await saveCurrentSetlist(setlist);
      await ensureSetMetadata(setlist, { allowAnalysis: false });
      await cleanupSetlistGeneratedArtifacts(setlist);
      await markUnavailableSetlistSongsUnconfirmed(setlist, library);
      return json(res, { ...library, currentSetlist: setlist });
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      return json(res, await loadSettings());
    }

    if (req.method === "GET" && url.pathname === "/api/system/info") {
      return json(res, systemInfo());
    }

    if (req.method === "GET" && url.pathname === "/api/audio/devices") {
      return json(res, await loadAudioDevices());
    }

    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const settings = normalizeSettings(await readJsonBody(req));
      await saveSettings(settings);
      await refreshEngineManifestForMixer();
      await probeEngineReadiness(settings, ENGINE_MANIFEST_FILE);
      return json(res, settings);
    }

    if (req.method === "GET" && url.pathname === "/api/setlist/current") {
      return json(res, await loadCurrentSetlist());
    }

    if (req.method === "PUT" && url.pathname === "/api/setlist/current") {
      const body = await readJsonBody(req);
      const setlist = await prepareSetlistCache(normalizeSetlist(body));
      await saveCurrentSetlist(setlist);
      await ensureSetMetadata(setlist, { allowAnalysis: false });
      await cleanupSetlistGeneratedArtifacts(setlist);
      await markSetUnconfirmed(setlist);
      return json(res, setlist);
    }

    if (req.method === "GET" && url.pathname === "/api/playback/state") {
      return json(res, await playbackStateSnapshot());
    }

    if (req.method === "GET" && url.pathname === "/api/playback/meters") {
      return json(res, await playbackMeterSnapshot());
    }

    if (req.method === "GET" && url.pathname === "/api/playback/meter-stream") {
      return openMeterStream(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/playback/cache-report") {
      return json(res, await buildCacheReport(await loadCurrentSetlist()));
    }

    if (req.method === "GET" && url.pathname === "/api/system/check") {
      return json(res, await runSystemCheck());
    }

    if (req.method === "GET" && url.pathname === "/api/analyzer/cue-status") {
      return json(res, await cueAnalyzerStatus());
    }

    if (req.method === "POST" && url.pathname === "/api/analyzer/dynamic-cues") {
      const body = await readJsonBody(req);
      return json(res, await analyzeDynamicCuesForSlot(positiveNumber(body.slot)));
    }

    if (req.method === "GET" && url.pathname === "/api/engine/status") {
      return json(res, await loadEngineStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/engine/manifest") {
      return json(res, await loadEngineManifest());
    }

    if (req.method === "PUT" && url.pathname === "/api/engine/simulate") {
      const body = await readJsonBody(req);
      return json(res, await simulateEngineStatus(body.state, body.message));
    }

    if (req.method === "POST" && url.pathname === "/api/engine/heartbeat") {
      const body = await readJsonBody(req);
      return json(res, await recordEngineHeartbeat(body));
    }

    if (req.method === "POST" && url.pathname === "/api/playback/confirm-set") {
      return json(res, await confirmCurrentSet());
    }

    if (req.method === "PUT" && url.pathname === "/api/playback/mode") {
      const body = await readJsonBody(req);
      return json(res, await setPlaybackMode(body.mode));
    }

    if (req.method === "POST" && url.pathname === "/api/playback/command") {
      const body = await readJsonBody(req);
      return json(res, await handlePlaybackCommand(body.command, body));
    }

    if (req.method === "POST" && url.pathname === "/api/playback/live-mixer") {
      const body = await readJsonBody(req);
      return json(res, await applyLiveMixerUpdate(positiveNumber(body.slot), body.mixer || body));
    }

    if (req.method === "GET" && url.pathname === "/api/set-metadata/current") {
      return json(res, await readCurrentSetMetadata());
    }

    const metadataSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)$/);
    if (metadataSlotMatch && req.method === "PUT") {
      const body = await readJsonBody(req);
      return json(res, await saveSlotMetadata(Number(metadataSlotMatch[1]), body));
    }

    const waveformSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)\/waveform$/);
    if (waveformSlotMatch && req.method === "GET") {
      return json(res, await buildSlotWaveformSummary(Number(waveformSlotMatch[1]), Number(url.searchParams.get("buckets") || 900)));
    }

    const audioShiftSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)\/audio-shift$/);
    if (audioShiftSlotMatch && req.method === "POST") {
      const body = await readJsonBody(req);
      return json(res, await applySlotAudioShift(Number(audioShiftSlotMatch[1]), Number(body.seconds || 0)));
    }

    const mixerSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)\/mixer$/);
    if (mixerSlotMatch && req.method === "PUT") {
      const body = await readJsonBody(req);
      return json(res, await saveSlotMixer(Number(mixerSlotMatch[1]), body));
    }

    const songMatch = url.pathname.match(/^\/api\/songs\/([^/]+)$/);
    if (req.method === "GET" && songMatch) {
      const library = await loadLibrary();
      const song = library.songs.find((item) => item.id === songMatch[1]);
      if (!song) return json(res, { error: "Song not found." }, 404);
      return json(res, await loadSong(song));
    }

    const stemMatch = url.pathname.match(/^\/api\/stems\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && stemMatch) {
      return streamStem(req, res, stemMatch[1], stemMatch[2]);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, { error: error.message }, 500);
  }
}).listen(PORT, () => {
  console.log(`Playback App V2 running at http://localhost:${PORT}`);
});

async function loadLibrary() {
  try {
    const library = await readJsonFile(LIBRARY_FILE, null);
    if (library) return library;
    const scanned = await scanLibrary();
    await saveLibrary(scanned);
    return scanned;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const library = await scanLibrary();
    await saveLibrary(library);
    return library;
  }
}

async function saveLibrary(library) {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SONG_METADATA_DIR, { recursive: true });
  await writeFile(LIBRARY_FILE, `${JSON.stringify(library, null, 2)}\n`, "utf8");
}

async function loadSettings() {
  try {
    return normalizeSettings(await readJsonFile(SETTINGS_FILE, null));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const settings = normalizeSettings({});
    await saveSettings(settings);
    return settings;
  }
}

async function saveSettings(settings) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizeSettings(value = {}) {
  value = value || {};
  return {
    library: {
      rootPath: stringValue(value.library?.rootPath || ROOT)
    },
    audioEngine: {
      helper: ENGINE_HELPER,
      target: "cross-platform",
      selectedDeviceId: stringValue(value.audioEngine?.selectedDeviceId),
      selectedDeviceName: stringValue(value.audioEngine?.selectedDeviceName),
      missingDevicePolicy: "warn-and-wait",
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      sampleRate: [44100, 48000].includes(Number(value.audioEngine?.sampleRate)) ? Number(value.audioEngine.sampleRate) : 48000
    },
    routing: {
      activePresetId: stringValue(value.routing?.activePresetId || "tracks-click-cue"),
      presets: normalizeRoutingPresets(value.routing?.presets)
    },
    dynamicCue: {
      folderPath: stringValue(value.dynamicCue?.folderPath),
      outputBus: "dynamic-cue"
    },
    pads: {
      folderPath: stringValue(value.pads?.folderPath || APP_PADS_DIR),
      outputBus: "pads"
    },
    dynamicClick: {
      soundFolderPath: stringValue(value.dynamicClick?.soundFolderPath),
      clickSoundPath: stringValue(value.dynamicClick?.clickSoundPath || value.dynamicClick?.soundFolderPath),
      accentSoundPath: stringValue(value.dynamicClick?.accentSoundPath),
      outputBus: "click",
      editableInPerformance: false
    }
  };
}

function normalizeRoutingPresets(presets) {
  const defaults = [
    { id: "stereo", name: "Stereo", routes: { tracks: [1, 2], click: [1, 2], cues: [1, 2], pads: [1, 2], dynamicCue: [1, 2], iem: [1, 2] } },
    { id: "tracks-click-cue", name: "Tracks Click Cue", routes: { tracks: [1, 2], click: [3], cues: [4], pads: [1, 2], dynamicCue: [4], iem: [5, 6] } },
    { id: "dante-32", name: "Dante 32ch", routes: { tracks: [1, 2], click: [3], cues: [4], pads: [5, 6], dynamicCue: [4], iem: [7, 8] } }
  ];
  if (!Array.isArray(presets) || presets.length === 0) return defaults;
  return presets.map((preset, index) => {
    const defaultPreset = defaults.find((item) => item.id === preset.id) || null;
    const routes = { ...(preset.routes || {}) };
    if (!Array.isArray(routes.tracks) && Array.isArray(routes.music)) routes.tracks = routes.music;
    if (!Array.isArray(routes.cues) && Array.isArray(routes.cue)) routes.cues = routes.cue;
    if (!Array.isArray(routes.click) && Array.isArray(defaultPreset?.routes?.click)) routes.click = defaultPreset.routes.click;
    if (!Array.isArray(routes.pads) && Array.isArray(defaultPreset?.routes?.pads)) routes.pads = defaultPreset.routes.pads;
    if (!Array.isArray(routes.dynamicCue) && Array.isArray(defaultPreset?.routes?.dynamicCue)) routes.dynamicCue = defaultPreset.routes.dynamicCue;
    if (!Array.isArray(routes.iem) && Array.isArray(defaultPreset?.routes?.iem)) routes.iem = defaultPreset.routes.iem;
    return {
      id: stringValue(preset.id || `preset-${index + 1}`),
      name: stringValue(preset.name || `Preset ${index + 1}`),
      routes
    };
  });
}

function systemInfo() {
  return {
    dataDir: DATA_DIR,
    libraryRoot: ROOT,
    vendors: VENDORS,
    cacheDir: CACHE_DIR,
    songMetadataDir: SONG_METADATA_DIR,
    setMetadataDir: SET_METADATA_DIR
  };
}

async function loadAudioDevices() {
  const settings = await loadSettings();
  const selectedName = settings.audioEngine.selectedDeviceName;
  const helper = await runEngineCommand({ type: "listDevices", requestId: "list-devices" });
  const devices = Array.isArray(helper.response?.devices)
    ? helper.response.devices.map((device) => ({
      id: stringValue(device.id),
      name: stringValue(device.name),
      driver: stringValue(device.type),
      channels: null,
      available: true
    }))
    : [];
  const selectedDevice = selectEngineDevice(devices, selectedName);
  return {
    source: helper.ok ? "juce-helper" : "juce-helper-unavailable",
    selectedDeviceName: selectedName,
    helperPath: helper.helperPath,
    error: helper.ok ? "" : helper.error,
    devices: devices.map((device) => ({
      ...device,
      selected: selectedDevice ? device.id === selectedDevice.id : false
    }))
  };
}

async function loadCurrentSetlist() {
  try {
    return normalizeSetlist(await readJsonFile(SETLIST_FILE, null));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const setlist = normalizeSetlist({});
    await saveCurrentSetlist(setlist);
    return setlist;
  }
}

async function saveCurrentSetlist(setlist) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETLIST_FILE, `${JSON.stringify(setlist, null, 2)}\n`, "utf8");
}

async function loadPlaybackState() {
  try {
    return normalizePlaybackState(await readJsonFile(PLAYBACK_STATE_FILE, null));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = normalizePlaybackState({});
    await savePlaybackState(state);
    return state;
  }
}

async function savePlaybackState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PLAYBACK_STATE_FILE, `${JSON.stringify(normalizePlaybackState(state), null, 2)}\n`, "utf8");
}

async function resetRuntimePlaybackOnStartup() {
  const state = await loadPlaybackState();
  if (state.transport === "stopped" && !state.panic?.active) return;
  await savePlaybackState({
    ...state,
    transport: "stopped",
    currentTimeSeconds: 0,
    transportAnchorSeconds: 0,
    transportStartedAt: "",
    liveRepeat: {},
    panic: {},
    lastCommand: "startup",
    commandStatus: "",
    lastMessage: "Playback runtime reset after app start.",
    updatedAt: new Date().toISOString()
  });
}

async function initializeRuntimeOnStartup() {
  await resetRuntimePlaybackOnStartup();
  await probeEngineReadiness(await loadSettings(), ENGINE_MANIFEST_FILE);
}

async function loadEngineStatus() {
  try {
    return normalizeEngineStatus(await readJsonFile(ENGINE_STATUS_FILE, null));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const status = normalizeEngineStatus({});
    await saveEngineStatus(status);
    return status;
  }
}

async function saveEngineStatus(status) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ENGINE_STATUS_FILE, `${JSON.stringify(normalizeEngineStatus(status), null, 2)}\n`, "utf8");
}

async function loadEngineManifest() {
  try {
    return {
      exists: true,
      path: ENGINE_MANIFEST_FILE,
      manifest: JSON.parse(await readFile(ENGINE_MANIFEST_FILE, "utf8"))
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      exists: false,
      path: ENGINE_MANIFEST_FILE,
      manifest: null
    };
  }
}

function normalizeEngineStatus(value = {}) {
  const allowed = new Set(["offline", "starting", "ready", "device-missing", "crashed"]);
  const state = allowed.has(value.state) ? value.state : "offline";
  const lastHeartbeatAt = stringValue(value.lastHeartbeatAt || (state === "ready" ? value.updatedAt : ""));
  return {
    engine: ENGINE_HELPER,
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    state,
    nativeEngineConnected: state === "ready",
    simulated: Boolean(value.simulated),
    selectedDeviceName: stringValue(value.selectedDeviceName),
    deviceType: stringValue(value.deviceType),
    requestedOutputChannels: positiveNumber(value.requestedOutputChannels),
    outputChannels: positiveNumber(value.outputChannels),
    sampleRate: positiveNumber(value.sampleRate),
    bufferSize: positiveNumber(value.bufferSize),
    manifestPath: stringValue(value.manifestPath),
    lastHeartbeatAt,
    heartbeatGraceMs: ENGINE_HEARTBEAT_GRACE_MS,
    message: stringValue(value.message || engineMessage(state)),
    updatedAt: stringValue(value.updatedAt || new Date().toISOString())
  };
}

async function simulateEngineStatus(state, message = "") {
  const current = await loadEngineStatus();
  const status = normalizeEngineStatus({
    ...current,
    state: stringValue(state || "offline"),
    simulated: true,
    message: stringValue(message),
    lastHeartbeatAt: stringValue(state) === "ready" ? new Date().toISOString() : current.lastHeartbeatAt,
    updatedAt: new Date().toISOString()
  });
  await saveEngineStatus(status);
  return status;
}

async function recordEngineHeartbeat(value = {}) {
  const current = await loadEngineStatus();
  const selectedDeviceName = stringValue(value.selectedDeviceName || current.selectedDeviceName);
  const manifestPath = stringValue(value.manifestPath || current.manifestPath);
  const status = normalizeEngineStatus({
    ...current,
    state: "ready",
    simulated: false,
    selectedDeviceName,
    manifestPath,
    message: selectedDeviceName ? `JUCE ready on ${selectedDeviceName}.` : "JUCE heartbeat received.",
    lastHeartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await saveEngineStatus(status);
  return status;
}

async function startEngineSimulator(settings, manifestPath) {
  return probeEngineReadiness(settings, manifestPath);
}

async function findEngineHelperPath() {
  for (const candidate of ENGINE_HELPER_CANDIDATES) {
    try {
      const result = await stat(candidate);
      if (result.isFile()) return candidate;
    } catch {
      // Try the next known helper location.
    }
  }
  return "";
}

async function runEngineCommand(command, options = {}) {
  const helperPath = await findEngineHelperPath();
  if (!helperPath) {
    return {
      ok: false,
      helperPath: "",
      response: null,
      error: "No JUCE helper executable found."
    };
  }

  return new Promise((resolveCommand) => {
    const child = spawn(helperPath, [], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish({
        ok: false,
        helperPath,
        response: null,
        error: "JUCE helper command timed out."
      });
      child.kill();
    }, options.timeoutMs || ENGINE_COMMAND_TIMEOUT_MS);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        helperPath,
        response: null,
        error: error.message
      });
    });

    child.on("close", () => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const parsed = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // Keep reading; malformed output will be reported if no JSON response exists.
        }
      }
      const response = parsed.find((item) => item.requestId === command.requestId) || parsed.at(-1) || null;
      finish({
        ok: Boolean(response) && response.type !== "commandRejected",
        helperPath,
        response,
        error: response?.reason || stderr.trim() || (!response ? "JUCE helper returned no JSON response." : "")
      });
    });

    child.stdin.write(`${JSON.stringify(command)}\n`);
    child.stdin.write(`${JSON.stringify({ type: "quit", requestId: `${command.requestId}-quit` })}\n`);
    child.stdin.end();
  });
}

async function findAnalyzerExecutable() {
  for (const candidate of ANALYZER_EXE_CANDIDATES) {
    try {
      const result = await stat(candidate);
      if (result.isFile()) return candidate;
    } catch {
      // Try the next configured analyzer path.
    }
  }
  return "";
}

async function cueAnalyzerStatus() {
  const analyzerPath = await findAnalyzerExecutable();
  if (!analyzerPath) {
    return {
      ok: false,
      cueRecognizer: "vosk-closed-grammar",
      voskStatus: "missing-analyzer",
      analyzerPath: "",
      message: "WAV Song Analyzer executable was not found."
    };
  }
  const result = await runAnalyzerJson([ "cue-self-test" ], { timeoutMs: 30000 });
  return {
    ...result.response,
    ok: Boolean(result.ok && result.response?.ok),
    analyzerPath,
    message: result.error || result.response?.lastCueAnalysisError || ""
  };
}

async function runAnalyzerJson(args, options = {}) {
  const analyzerPath = await findAnalyzerExecutable();
  if (!analyzerPath) {
    return { ok: false, response: null, error: "WAV Song Analyzer executable was not found." };
  }
  return new Promise((resolveCommand) => {
    const child = spawn(analyzerPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish({ ok: false, response: null, error: "Analyzer command timed out." });
      child.kill();
    }, options.timeoutMs || 120000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, response: null, error: error.message }));
    child.on("close", (code) => {
      try {
        const response = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        finish({ ok: code === 0 && Boolean(response), response, error: stderr.trim() || response?.message || "" });
      } catch (error) {
        finish({ ok: false, response: null, error: stderr.trim() || error.message });
      }
    });
  });
}

async function runAnalyzerFile(args, outputPath, options = {}) {
  const analyzerPath = await findAnalyzerExecutable();
  if (!analyzerPath) {
    return { ok: false, error: "WAV Song Analyzer executable was not found." };
  }
  return new Promise((resolveCommand) => {
    const child = spawn(analyzerPath, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Analyzer command timed out." });
      child.kill();
    }, options.timeoutMs || 300000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand(result);
    }

    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, error: stderr.trim(), outputPath }));
  });
}

async function analyzeDynamicCuesForSlot(slotNumber) {
  if (!slotNumber) throw new Error("Select a setlist song before running dynamic cue analysis.");
  const setlist = await loadCurrentSetlist();
  await ensureSetMetadata(setlist, { allowAnalysis: true });
  const slot = (setlist.slots || []).find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  if (!slot.folderPath) throw new Error(`Setlist slot ${slotNumber} is missing a source folder path.`);

  const settings = await loadSettings();
  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  await mkdir(slotDir, { recursive: true });
  const rawReportPath = join(slotDir, "cue-analyzer-full-report.json");
  const compactReportPath = join(slotDir, "cue-recognition-report.json");
  const dynamicCueMapPath = join(slotDir, "dynamic-cue-map.json");

  const run = await runAnalyzerFile(["--input", slot.folderPath, "--output", rawReportPath], rawReportPath, { timeoutMs: 300000 });
  if (!run.ok) {
    const report = {
      generatedAt: new Date().toISOString(),
      slot: slotNumber,
      songId: slot.songId,
      title: slot.title,
      status: "error",
      error: run.error || "Analyzer failed.",
      candidates: []
    };
    await writeFile(compactReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ok: false, reportPath: compactReportPath, dynamicCueMapPath, report };
  }

  const raw = JSON.parse(await readFile(rawReportPath, "utf8"));
  const cueAnalysis = raw.phase3CueAnalysis || {};
  const candidates = compactCueCandidates(cueAnalysis.cueCandidates || []);
  const regionCandidates = compactRegionCandidates(cueAnalysis.regionCandidates || []);
  const report = {
    generatedAt: new Date().toISOString(),
    slot: slotNumber,
    songId: slot.songId,
    title: slot.title,
    sourceFolder: slot.folderPath,
    recognizer: cueAnalysis.speechEngine?.cueRecognizer || cueAnalysis.speechEngine?.cueProvider || "vosk-closed-grammar",
    voskStatus: cueAnalysis.speechEngine?.voskStatus || "",
    status: cueAnalysis.status || raw.analysisStatus || "unknown",
    summary: cueAnalysis.summary || {},
    gridReference: cueAnalysis.gridReference || null,
    source: cueAnalysis.source || null,
    candidates,
    regionCandidates
  };
  const dynamicCueMap = await buildDynamicCueMapFromCandidates(report, settings.dynamicCue.folderPath);
  const seededCueMarkers = await seedCueMarkersFromAnalysisIfEmpty(slotDir, report);
  const seededRegions = await seedRegionsFromAnalysisIfEmpty(slotDir, report);
  await writeFile(compactReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(dynamicCueMapPath, `${JSON.stringify(dynamicCueMap, null, 2)}\n`, "utf8");
  await writeSongCueAnalysisDefaults(slot.folderPath, report, dynamicCueMap);
  await refreshEngineManifestForMixer();
  return {
    ok: true,
    reportPath: compactReportPath,
    rawReportPath,
    dynamicCueMapPath,
    report,
    dynamicCueMap,
    seededCueMarkers,
    seededRegions
  };
}

async function writeSongCueAnalysisDefaults(folderPath, report, dynamicCueMap) {
  if (!folderPath) return;
  const metadataDir = appSongMetadataDir(folderPath);
  await mkdir(metadataDir, { recursive: true });
  await writeFile(appCueRecognitionReportPath(folderPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(appDynamicCueMapPath(folderPath), `${JSON.stringify(dynamicCueMap, null, 2)}\n`, "utf8");
  const defaultCuesPath = appDefaultCueMarkersPath(folderPath);
  const current = await readJsonFile(defaultCuesPath, null);
  if (!current?.cueMarkers?.length) {
    await writeFile(defaultCuesPath, `${JSON.stringify(await buildDefaultCueMarkersFromAnalysis(folderPath), null, 2)}\n`, "utf8");
  }
  const currentRegions = await readJsonFile(appDefaultRegionsPath(folderPath), null);
  if (!currentRegions?.regions?.length) {
    await writeFile(appDefaultRegionsPath(folderPath), `${JSON.stringify(buildDefaultRegionsFromReport(report), null, 2)}\n`, "utf8");
  }
}

function compactCueCandidates(candidates) {
  return candidates.map((candidate) => {
    const recognition = candidate.recognition || {};
    const alignment = candidate.alignment || {};
    return {
      id: stringValue(candidate.id),
      rawTranscript: stringValue(candidate.rawTranscript),
      status: stringValue(recognition.status || candidate.transcriptionStatus),
      label: stringValue(recognition.displayLabel),
      normalizedPhrase: stringValue(recognition.normalizedPhrase || candidate.rawTranscript),
      command: stringValue(recognition.command),
      confidence: positiveNumber(recognition.recognitionConfidence || candidate.transcriptionConfidence) || 0,
      spokenAtSeconds: nonNegativeNumber(recognition.spokenAtSeconds ?? candidate.spokenAtSeconds),
      sectionWordAtSeconds: nonNegativeNumber(recognition.sectionWordAtSeconds ?? candidate.sectionWordAtSeconds),
      targetMeasure: positiveNumber(alignment.targetMeasure),
      targetBeat: positiveNumber(alignment.targetBeatInMeasure),
      snappedMeasure: positiveNumber(alignment.snappedMeasure),
      snappedBeat: positiveNumber(alignment.snappedBeatInMeasure),
      gridStatus: stringValue(alignment.alignmentStatus),
      rejectionReasons: Array.isArray(recognition.rejectionReasons) ? recognition.rejectionReasons.map(stringValue).filter(Boolean) : [],
      words: Array.isArray(candidate.words) ? candidate.words.map((word) => stringValue(word.word)).filter(Boolean) : []
    };
  });
}

function compactRegionCandidates(candidates) {
  return candidates.map((candidate) => {
    const cue = candidate.cueMarker || {};
    const start = candidate.predictedRegionStart || {};
    return {
      id: stringValue(candidate.id),
      sourceCueCandidateId: stringValue(candidate.sourceCueCandidateId),
      sourceCueText: stringValue(candidate.sourceCueText),
      status: stringValue(candidate.status),
      cueMeasure: positiveNumber(cue.measure),
      cueBeat: positiveNumber(cue.beatInMeasure),
      startMeasure: positiveNumber(start.measure),
      startBeat: positiveNumber(start.beatInMeasure),
      leadInMeasures: positiveNumber(candidate.leadIn?.measureCount),
      gridBeats: positiveNumber(candidate.leadIn?.gridBeats),
      reason: stringValue(candidate.reason)
    };
  }).filter((candidate) => candidate.id && candidate.startMeasure && candidate.startBeat);
}

async function buildDynamicCueMapFromCandidates(report, dynamicCueFolder) {
  const available = await availableDynamicCueFiles(dynamicCueFolder);
  const entries = report.candidates.map((candidate) => {
    const phrase = candidate.normalizedPhrase || candidate.rawTranscript || candidate.label;
    const parts = matchDynamicCuePhrase(phrase, available);
    const approved = ["trusted", "review"].includes(candidate.status);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      phrase,
      command: candidate.command,
      status: approved && parts.every((part) => part.filePath) ? "mapped" : approved ? "missing-dynamic-cue-files" : "not-approved",
      triggerMeasure: candidate.snappedMeasure,
      triggerBeat: candidate.snappedBeat,
      targetMeasure: candidate.targetMeasure,
      targetBeat: candidate.targetBeat,
      parts
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    recognizer: report.recognizer,
    sourceReport: "cue-recognition-report.json",
    slot: report.slot,
    songId: report.songId,
    title: report.title,
    dynamicCueFolder: stringValue(dynamicCueFolder),
    availableCueCount: available.length,
    entries
  };
}

async function seedCueMarkersFromAnalysisIfEmpty(slotDir, report) {
  const cueMarkerPath = join(slotDir, "cue-markers.json");
  const current = await readJsonFile(cueMarkerPath, { cueMarkers: [], dynamicCueMatching: "fuzzy-name" });
  if (Array.isArray(current.cueMarkers) && current.cueMarkers.length) {
    return { created: 0, skipped: "cue-markers-already-exist" };
  }
  const cueMarkers = (report.candidates || [])
    .filter((candidate) => ["trusted", "review"].includes(candidate.status))
    .map((candidate, index) => ({
      id: `cue-${candidate.id || index + 1}`,
      name: cueMarkerName(candidate, index),
      bar: positiveNumber(candidate.snappedMeasure || candidate.targetMeasure) || 1,
      beat: positiveNumber(candidate.snappedBeat || candidate.targetBeat) || 1
    }))
    .filter((cue) => cue.name && cue.bar > 0 && cue.beat > 0);
  await writeFile(cueMarkerPath, `${JSON.stringify({
    ...current,
    dynamicCueMatching: current.dynamicCueMatching || "fuzzy-name",
    cueMarkers,
    updatedAt: new Date().toISOString(),
    source: "dynamic-cue-analysis"
  }, null, 2)}\n`, "utf8");
  return { created: cueMarkers.length };
}

function buildDefaultRegionsFromReport(report) {
  const candidates = (report.regionCandidates || [])
    .filter((candidate) => candidate.status === "verified" && candidate.startMeasure && candidate.startBeat)
    .sort((a, b) => (a.startMeasure - b.startMeasure) || (a.startBeat - b.startBeat));
  const endMeasure = positiveNumber(report.gridReference?.measureCount);
  const regions = candidates.map((candidate, index) => {
    const next = candidates[index + 1];
    return {
      id: `region-${candidate.sourceCueCandidateId || candidate.id || index + 1}`,
      name: cueMarkerName({
        id: candidate.sourceCueCandidateId || candidate.id,
        label: candidate.sourceCueText,
        normalizedPhrase: candidate.sourceCueText
      }, index),
      startBar: candidate.startMeasure,
      startBeat: candidate.startBeat,
      endBar: next?.startMeasure || endMeasure || candidate.startMeasure + 1,
      endBeat: next?.startBeat || 1,
      sourceCueId: `cue-${candidate.sourceCueCandidateId || candidate.id || index + 1}`,
      source: "derived-from-analyzer-region-candidates"
    };
  }).filter((region) => region.endBar > region.startBar || (region.endBar === region.startBar && region.endBeat > region.startBeat));
  return {
    regions,
    source: regions.length ? "derived-from-analyzer-region-candidates" : "empty-default",
    updatedAt: new Date().toISOString()
  };
}

async function seedRegionsFromAnalysisIfEmpty(slotDir, report) {
  const regionPath = join(slotDir, "regions.json");
  const current = await readJsonFile(regionPath, { regions: [] });
  if (Array.isArray(current.regions) && current.regions.length) {
    return { created: 0, skipped: "regions-already-exist" };
  }
  const defaults = buildDefaultRegionsFromReport(report);
  await writeFile(regionPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
  return { created: defaults.regions.length };
}

function cueMarkerName(candidate, index) {
  const label = stringValue(candidate.label);
  if (label) return label;
  const phrase = stringValue(candidate.normalizedPhrase || candidate.rawTranscript);
  if (!phrase) return `Cue ${index + 1}`;
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

async function availableDynamicCueFiles(folderPath) {
  if (!folderPath) return [];
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
      .map((entry) => ({
        name: entry.name,
        filePath: join(folderPath, entry.name),
        phrase: normalizeCuePhrase(entry.name.replace(/\.wav$/i, ""))
      }))
      .sort((a, b) => b.phrase.split(" ").length - a.phrase.split(" ").length || b.phrase.length - a.phrase.length);
  } catch {
    return [];
  }
}

function matchDynamicCuePhrase(phrase, available) {
  const tokens = normalizeCuePhrase(phrase).split(" ").filter(Boolean);
  const parts = [];
  let index = 0;
  while (index < tokens.length) {
    const match = available.find((item) => {
      const phraseTokens = item.phrase.split(" ").filter(Boolean);
      if (!phraseTokens.length || phraseTokens.length > tokens.length - index) return false;
      return phraseTokens.every((token, offset) => tokens[index + offset] === token);
    });
    if (match) {
      parts.push({ phrase: match.phrase, fileName: match.name, filePath: match.filePath });
      index += match.phrase.split(" ").filter(Boolean).length;
    } else {
      parts.push({ phrase: tokens[index], fileName: "", filePath: "" });
      index += 1;
    }
  }
  return parts;
}

function normalizeCuePhrase(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b6 8\b/g, "6/8")
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function startNativeSlotPlayback(slot, options = {}) {
  await stopNativePlayback();

  const helperPath = await findEngineHelperPath();
  if (!helperPath) {
    return { ok: false, error: "No JUCE helper executable found." };
  }

  const settings = await loadSettings();
  const device = await resolveEngineDevice(settings.audioEngine.selectedDeviceName);

  return new Promise((resolveStart) => {
    const child = spawn(helperPath, [], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const requestId = `play-${Date.now()}`;
    const timeout = setTimeout(() => {
      finish({ ok: false, error: "JUCE playback start timed out." });
      child.kill();
    }, 10000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStart(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          if (response.requestId !== requestId) {
            handleNativePlaybackResponse(response);
            continue;
          }
          if (response.type === "playbackStarted") {
            activePlaybackProcess = { child, slot, stdout, stderr, pending: new Map() };
            latestPlaybackMeters = {
              active: true,
              slot,
              title: stringValue(response.title),
              stems: [],
              updatedAt: new Date().toISOString()
            };
            broadcastMeterSnapshot();
            finish({ ok: true, response });
          } else if (response.type === "commandRejected") {
            finish({ ok: false, error: response.reason || "JUCE rejected playback start." });
            child.kill();
          } else {
            handleNativePlaybackResponse(response);
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    child.on("close", () => {
      if (activePlaybackProcess?.child === child) activePlaybackProcess = null;
      finish({ ok: false, error: stderr.trim() || "JUCE playback process exited before start." });
    });

    child.stdin.write(`${JSON.stringify({
      type: "playSlot",
      requestId,
      manifestPath: ENGINE_MANIFEST_FILE,
      slot,
      deviceName: device.name,
      deviceType: device.driver,
      startSeconds: nonNegativeNumber(options.startSeconds) ?? 0
    })}\n`);
  });
}

async function sendNativePlaybackCommand(type, body = {}) {
  if (!activePlaybackProcess) {
    return { ok: true, active: false };
  }

  const { child } = activePlaybackProcess;
  if (child.killed || child.stdin.destroyed) {
    activePlaybackProcess = null;
    return { ok: true, active: false };
  }

  child.stdin.write(`${JSON.stringify({
    type,
    requestId: `${type}-${Date.now()}`,
    ...body
  })}\n`);

  return { ok: true, active: true };
}

async function requestNativePlaybackCommand(type, body = {}, options = {}) {
  if (!activePlaybackProcess) return { ok: false, active: false, error: "No active playback process." };
  const { child, pending } = activePlaybackProcess;
  if (child.killed || child.stdin.destroyed) {
    activePlaybackProcess = null;
    return { ok: false, active: false, error: "Playback process is not active." };
  }
  const requestId = `${type}-${Date.now()}`;
  return new Promise((resolveRequest) => {
    const timeout = setTimeout(() => {
      pending?.delete(requestId);
      resolveRequest({ ok: false, active: true, error: `${type} timed out.` });
    }, options.timeoutMs || 1000);
    pending?.set(requestId, (response) => {
      clearTimeout(timeout);
      resolveRequest({ ok: response.type !== "commandRejected", active: true, response, error: response.reason || "" });
    });
    child.stdin.write(`${JSON.stringify({ type, requestId, ...body })}\n`);
  });
}

function handleNativePlaybackResponse(response) {
  if (!response || typeof response !== "object") return;
  if (response.type === "meterUpdate") {
    latestPlaybackMeters = {
      active: Boolean(response.nativeAudioActive),
      slot: positiveNumber(response.slot),
      title: stringValue(response.title),
      stems: Array.isArray(response.stems) ? response.stems.map((stem) => ({
        id: stringValue(stem.id),
        name: stringValue(stem.name),
        level: clampNumber(stem.level, 0, 1, 0)
      })) : [],
      updatedAt: new Date().toISOString()
    };
    broadcastMeterSnapshot();
  }
  const resolver = activePlaybackProcess?.pending?.get(response.requestId);
  if (resolver) {
    activePlaybackProcess.pending.delete(response.requestId);
    resolver(response);
  }
}

function openMeterStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: meters\ndata: ${JSON.stringify(latestPlaybackMeters)}\n\n`);
  meterStreamClients.add(res);
  startMeterStreamLoop();
  req.on("close", () => {
    meterStreamClients.delete(res);
  });
}

function broadcastMeterSnapshot() {
  if (!meterStreamClients.size) return;
  const payload = `event: meters\ndata: ${JSON.stringify(latestPlaybackMeters)}\n\n`;
  for (const client of meterStreamClients) {
    try {
      client.write(payload);
    } catch {
      meterStreamClients.delete(client);
    }
  }
}

function startMeterStreamLoop() {
  if (meterStreamTimer) return;
  const tick = async () => {
    meterStreamTimer = null;
    if (!meterStreamClients.size) return;
    if (activePlaybackProcess && !meterStreamInFlight) {
      meterStreamInFlight = true;
      try {
        await requestNativePlaybackCommand("getMeters", {}, { timeoutMs: 60 });
      } catch {
        // Meter streaming should never interrupt playback.
      } finally {
        meterStreamInFlight = false;
      }
    } else if (!activePlaybackProcess && latestPlaybackMeters.active) {
      latestPlaybackMeters = { active: false, slot: null, title: "", stems: [], updatedAt: new Date().toISOString() };
      broadcastMeterSnapshot();
    }
    meterStreamTimer = setTimeout(tick, 8);
  };
  meterStreamTimer = setTimeout(tick, 0);
}

async function playbackMeterSnapshot() {
  if (activePlaybackProcess) {
    await requestNativePlaybackCommand("getMeters", {}, { timeoutMs: 700 });
  }
  return latestPlaybackMeters;
}

async function stopNativePlayback(options = {}) {
  if (!activePlaybackProcess) {
    latestPlaybackMeters = { active: false, slot: null, title: "", stems: [], updatedAt: new Date().toISOString() };
    broadcastMeterSnapshot();
    return { ok: true, stopped: false };
  }

  const { child } = activePlaybackProcess;
  activePlaybackProcess = null;
  const closeWait = new Promise((resolveClose) => {
    if (child.exitCode !== null || child.killed) {
      resolveClose();
      return;
    }
    child.once("close", resolveClose);
  });

  if (!child.killed && !child.stdin.destroyed) {
    child.stdin.write(`${JSON.stringify({
      type: options.fade ? "fadeOut" : "stop",
      requestId: `stop-${Date.now()}`,
      durationMs: options.durationMs || 400
    })}\n`);
    child.stdin.end();
  }

  setTimeout(() => {
    if (!child.killed) child.kill();
  }, (options.fade ? options.durationMs || 400 : 50) + 500);

  await Promise.race([
    closeWait,
    new Promise((resolveClose) => setTimeout(resolveClose, (options.fade ? options.durationMs || 400 : 50) + 900))
  ]);
  latestPlaybackMeters = { active: false, slot: null, title: "", stems: [], updatedAt: new Date().toISOString() };
  broadcastMeterSnapshot();
  return { ok: true, stopped: true };
}

async function resolveEngineDevice(selectedDeviceName) {
  const devices = await loadAudioDevices();
  const match = selectEngineDevice(devices.devices || [], selectedDeviceName);
  return {
    name: match?.name || selectedDeviceName,
    driver: match?.driver || ""
  };
}

async function resolveEngineDeviceName(selectedDeviceName) {
  return (await resolveEngineDevice(selectedDeviceName)).name;
}

function selectEngineDevice(devices, selectedDeviceName) {
  return [...devices]
    .map((device) => ({ device, score: deviceMatchScore(device, selectedDeviceName) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.device || null;
}

function deviceMatchesSelectedName(device, selectedDeviceName) {
  return deviceMatchScore(device, selectedDeviceName) > 0;
}

function deviceMatchScore(device, selectedDeviceName) {
  const selected = stringValue(selectedDeviceName);
  const name = stringValue(device.name);
  const id = stringValue(device.id);

  if (!selected || !name) return 0;
  if (sameText(name, selected) || sameText(id, selected)) return 1000;

  const selectedTokens = selected.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  const haystack = `${name} ${id}`.toLowerCase();
  if (!selectedTokens.length) return 0;

  const tokenScore = selectedTokens.reduce((score, token) => score + (haystack.includes(token) ? 10 : 0), 0);
  const driver = stringValue(device.driver);
  const driverScore = driver === "ASIO" ? 20 : driver === "Windows Audio" ? 5 : driver.includes("Low Latency") ? 4 : driver.includes("Exclusive") ? 3 : 1;
  return tokenScore ? tokenScore + driverScore : 0;
}

async function probeEngineReadiness(settings, manifestPath) {
  const selectedDeviceName = stringValue(settings.audioEngine?.selectedDeviceName);
  if (!selectedDeviceName) {
    const status = normalizeEngineStatus({
      state: "device-missing",
      simulated: false,
      selectedDeviceName,
      manifestPath,
      message: "No default audio device selected in Settings.",
      lastHeartbeatAt: "",
      updatedAt: new Date().toISOString()
    });
    await saveEngineStatus(status);
    return status;
  }

  const device = await resolveEngineDevice(selectedDeviceName);
  const probe = await runEngineCommand({
    type: "probeDevice",
    requestId: "engine-probe",
    deviceName: device.name || selectedDeviceName,
    deviceType: device.driver,
    requestedOutputChannels: 2
  }, { timeoutMs: 10000 });

  if (!probe.ok || probe.response?.type !== "deviceProbe") {
    const status = normalizeEngineStatus({
      state: probe.error?.includes("No JUCE helper") ? "offline" : "crashed",
      simulated: false,
      selectedDeviceName,
      manifestPath,
      message: probe.error || "JUCE helper did not complete device probe.",
      lastHeartbeatAt: "",
      updatedAt: new Date().toISOString()
    });
    await saveEngineStatus(status);
    return status;
  }

  const status = normalizeEngineStatus({
    state: "ready",
    simulated: false,
    selectedDeviceName: stringValue(probe.response.deviceName || selectedDeviceName),
    deviceType: stringValue(probe.response.deviceType || device.driver),
    requestedOutputChannels: positiveNumber(probe.response.requestedOutputChannels),
    outputChannels: positiveNumber(probe.response.outputChannels),
    sampleRate: positiveNumber(probe.response.sampleRate),
    bufferSize: positiveNumber(probe.response.bufferSize),
    manifestPath,
    message: `JUCE ready on ${probe.response.deviceName || selectedDeviceName}.`,
    lastHeartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await saveEngineStatus(status);
  return status;
}

function engineMessage(state) {
  const messages = {
    offline: "JUCE offline.",
    starting: "JUCE starting.",
    ready: "JUCE ready.",
    "device-missing": "Audio device missing.",
    crashed: "JUCE crashed."
  };
  return messages[state] || "JUCE offline.";
}

function normalizePlaybackState(value = {}) {
  const mode = value.mode === "performance" ? "performance" : "edit";
  return {
    mode,
    transport: stringValue(value.transport || "stopped"),
    currentSlot: positiveNumber(value.currentSlot),
    currentTimeSeconds: nonNegativeNumber(value.currentTimeSeconds) ?? 0,
    transportAnchorSeconds: nonNegativeNumber(value.transportAnchorSeconds) ?? 0,
    transportStartedAt: stringValue(value.transportStartedAt),
    activeRegionId: stringValue(value.activeRegionId),
    liveRepeat: normalizeLiveRepeat(value.liveRepeat),
    panic: normalizePanicRuntime(value.panic),
    lastCommand: stringValue(value.lastCommand),
    commandStatus: stringValue(value.commandStatus),
    confirmed: Boolean(value.confirmed),
    confirmedFingerprint: stringValue(value.confirmedFingerprint),
    confirmedAt: stringValue(value.confirmedAt),
    lastMessage: stringValue(value.lastMessage),
    updatedAt: stringValue(value.updatedAt || new Date().toISOString())
  };
}

function normalizePanicRuntime(value = {}) {
  const state = value.state === PANIC_STATES.PANIC_HOLD ? PANIC_STATES.PANIC_HOLD : PANIC_STATES.NORMAL;
  return {
    state,
    active: state !== PANIC_STATES.NORMAL && value.active !== false,
    label: state === PANIC_STATES.PANIC_HOLD ? stringValue(value.label || "Panic Active") : "",
    detail: state === PANIC_STATES.PANIC_HOLD ? stringValue(value.detail || "Tracks Down / Click Alive") : "",
    trackTargetDb: state === PANIC_STATES.PANIC_HOLD ? PANIC_TRACK_TARGET_DB : 0,
    source: stringValue(value.source),
    updatedAt: stringValue(value.updatedAt)
  };
}

function normalizeLiveRepeat(value = {}) {
  const mode = ["once", "loop"].includes(value.mode) ? value.mode : "";
  return {
    mode,
    regionId: mode ? stringValue(value.regionId) : "",
    regionName: mode ? stringValue(value.regionName) : "",
    queued: Boolean(mode && value.queued !== false),
    releaseRequested: Boolean(mode === "loop" && value.releaseRequested),
    releaseAfterNextPass: Boolean(mode === "loop" && value.releaseAfterNextPass)
  };
}

async function playbackStateSnapshot() {
  const state = await loadPlaybackState();
  const currentTimeSeconds = computedPlaybackTimeSeconds(state);
  const setlist = await loadCurrentSetlist();
  const settings = await loadSettings();
  const fingerprint = setFingerprint(setlist);
  const confirmed = state.confirmed && state.confirmedFingerprint === fingerprint;
  const readiness = await buildReadiness(setlist, settings);
  return {
    ...state,
    currentTimeSeconds,
    confirmed,
    unconfirmedChanges: !confirmed,
    currentFingerprint: fingerprint,
    readiness
  };
}

function computedPlaybackTimeSeconds(state) {
  const anchor = nonNegativeNumber(state.transportAnchorSeconds) ?? nonNegativeNumber(state.currentTimeSeconds) ?? 0;
  if (state.transport !== "playing" || !state.transportStartedAt) return anchor;
  const startedAt = Date.parse(state.transportStartedAt);
  if (!Number.isFinite(startedAt)) return anchor;
  return Math.max(0, anchor + ((Date.now() - startedAt) / 1000));
}

function livePlaybackActivityAgeMs() {
  if (!activePlaybackProcess || !latestPlaybackMeters.updatedAt) return Number.POSITIVE_INFINITY;
  return Date.now() - Date.parse(latestPlaybackMeters.updatedAt);
}

async function buildReadiness(setlist, settings) {
  const slots = [];
  const cacheIssues = [];
  const performanceBlockers = [];
  const filledSlots = (setlist.slots || []).filter((slot) => slot.songId);
  const engineStatus = await loadEngineStatus();
  if (activePlaybackProcess && livePlaybackActivityAgeMs() > 1000 && !meterStreamInFlight) {
    try {
      await requestNativePlaybackCommand("getMeters", {}, { timeoutMs: 100 });
    } catch {
      // Readiness should report stale engine state, not fail the server request.
    }
  }
  const library = await loadLibrary();
  const librarySongIds = new Set((library.songs || []).map((song) => song.id));

  for (const slot of filledSlots) {
    const result = librarySongIds.has(slot.songId)
      ? await validateSlotCache(slot)
      : {
        slot: slot.slot,
        songId: slot.songId,
        title: slot.title,
        state: "failed",
        message: "Song is not in the current metadata-backed library.",
        expectedTrackCount: slot.trackCount || null,
        cachedTrackCount: slot.cachedTrackCount || null,
        missingStems: []
      };
    slots.push(result);
    if (result.state === "failed" || result.state === "not-cached") {
      cacheIssues.push({ slot: slot.slot, message: result.message });
    }
  }

  if (!filledSlots.length) {
    cacheIssues.push({ slot: 0, message: "Setlist has no songs." });
  }

  const heartbeatAgeMs = engineStatus.lastHeartbeatAt
    ? Date.now() - Date.parse(engineStatus.lastHeartbeatAt)
    : Number.POSITIVE_INFINITY;
  const liveActivityAgeMs = livePlaybackActivityAgeMs();
  const effectiveHeartbeatAgeMs = activePlaybackProcess
    ? Math.min(heartbeatAgeMs, liveActivityAgeMs)
    : heartbeatAgeMs;
  const heartbeatFresh = engineStatus.state === "ready" && (!activePlaybackProcess || effectiveHeartbeatAgeMs <= ENGINE_HEARTBEAT_GRACE_MS);
  const engine = {
    ...engineStatus,
    heartbeatFresh,
    heartbeatAgeMs: Number.isFinite(effectiveHeartbeatAgeMs) ? effectiveHeartbeatAgeMs : null,
    statusFileHeartbeatAgeMs: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
    liveActivityAgeMs: Number.isFinite(liveActivityAgeMs) ? liveActivityAgeMs : null
  };
  const audioDevice = {
    selectedDeviceName: settings.audioEngine?.selectedDeviceName || engineStatus.selectedDeviceName || "",
    missingDevicePolicy: "warn-and-wait",
    state: settings.audioEngine?.selectedDeviceName && engine.state !== "device-missing" ? "ready" : "missing"
  };

  if (engine.state !== "ready" && engine.state !== "device-missing") {
    performanceBlockers.push(engine.state === "crashed" ? "JUCE engine crashed." : "JUCE engine offline.");
  } else if (settings.audioEngine?.selectedDeviceName && !heartbeatFresh) {
    performanceBlockers.push("JUCE heartbeat stale.");
  }
  if (audioDevice.state === "missing") {
    performanceBlockers.push("Audio device missing.");
  }
  const requiredOutputChannels = requiredOutputsForSettings(settings);
  if (engine.outputChannels && engine.outputChannels < requiredOutputChannels) {
    performanceBlockers.push(`Routing preset needs ${requiredOutputChannels} outputs. Selected device exposes ${engine.outputChannels}.`);
  }
  if (cacheIssues.length) {
    performanceBlockers.push("Cache invalid.");
  }

  return {
    generatedAt: new Date().toISOString(),
    state: performanceBlockers.length ? "blocked" : (slots.some((slot) => slot.state === "warning") ? "warning" : "ready"),
    cacheReady: cacheIssues.length === 0,
    canEnterPerformance: performanceBlockers.length === 0,
    slots,
    cacheIssues,
    performanceBlockers,
    engine,
    audioDevice,
    requiredOutputChannels
  };
}

function requiredOutputsForSettings(settings) {
  const presetId = settings.routing?.activePresetId;
  const preset = (settings.routing?.presets || []).find((item) => item.id === presetId) || {};
  const routes = preset.routes || {};
  let maxChannel = 2;
  for (const channels of Object.values(routes)) {
    if (!Array.isArray(channels)) continue;
    for (const channel of channels) {
      maxChannel = Math.max(maxChannel, positiveNumber(channel) || 0);
    }
  }
  return maxChannel;
}

async function buildCacheReport(setlist) {
  const readiness = await buildReadiness(setlist, await loadSettings());
  const rows = (setlist.slots || [])
    .filter((slot) => slot.songId)
    .map((slot) => {
      const slotReadiness = readiness.slots.find((item) => item.slot === slot.slot) || {};
      return {
        slot: slot.slot,
        songId: slot.songId,
        title: slot.title,
        state: slotReadiness.state || slot.readinessState || slot.cacheStatus || "not-cached",
        message: slotReadiness.message || "",
        expectedTrackCount: slotReadiness.expectedTrackCount || slot.trackCount || 0,
        cachedTrackCount: slotReadiness.cachedTrackCount || slot.cachedTrackCount || 0,
        missingStems: slot.missingStems || [],
        cacheFolder: slot.cacheFolder || "",
        cachedAt: slot.cachedAt || "",
        renderStatus: "waiting-for-render-pipeline"
      };
    });
  return {
    generatedAt: new Date().toISOString(),
    state: readiness.cacheIssues.length ? "blocked" : (rows.some((row) => row.state === "warning") ? "warning" : "ready"),
    cacheReady: readiness.cacheReady,
    rows,
    issues: readiness.cacheIssues
  };
}

async function runSystemCheck() {
  const errors = [];
  const warnings = [];
  const library = await loadLibrary();
  const setlist = await loadCurrentSetlist();
  const settings = await loadSettings();
  const libraryRoot = selectedLibraryRoot(settings);
  const playback = await playbackStateSnapshot();
  const cacheReport = await buildCacheReport(setlist);
  const metadata = await readCurrentSetMetadata();
  const filledSlots = (setlist.slots || []).filter((slot) => slot.songId);
  const librarySongIds = new Set((library.songs || []).map((song) => song.id));

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SONG_METADATA_DIR, { recursive: true });
  await checkDirectory(libraryRoot, "Library scan folder", errors);
  await checkDirectory(DATA_DIR, "App data folder", errors);
  await checkDirectory(SONG_METADATA_DIR, "Song metadata folder", errors);

  if (resolve(libraryRoot).toLowerCase() === resolve(ROOT).toLowerCase()) {
    for (const vendor of VENDORS) {
      await checkDirectory(join(ROOT, vendor), `Vendor folder ${vendor}`, errors);
    }
  }

  if (!library.songs?.length) errors.push("Library has no songs.");
  for (const slot of filledSlots) {
    if (!librarySongIds.has(slot.songId)) {
      errors.push(`Slot ${slot.slot}: song is not in the current metadata-backed library.`);
    }
  }
  if (filledSlots.length && metadata.slots.length !== filledSlots.length) {
    errors.push("Set metadata slot count does not match filled setlist slots.");
  }
  for (const row of cacheReport.rows) {
    if (row.state === "failed") errors.push(`Slot ${row.slot}: ${row.message || "cache failed"}`);
    if (row.state === "not-cached") warnings.push(`Slot ${row.slot}: cache has not been built.`);
  }
  if (playback.confirmed) {
    const manifest = await loadEngineManifest();
    if (!manifest.exists) errors.push("Confirmed set is missing engine manifest.");
    if (manifest.exists && manifest.manifest?.songs?.length !== filledSlots.length) {
      errors.push("Engine manifest song count does not match filled setlist slots.");
    }
    for (const song of manifest.exists ? manifest.manifest?.songs || [] : []) {
      if (song.dynamicPad?.sourcePath && song.dynamicPad?.cacheStatus === "cache-failed") {
        errors.push(`Slot ${song.slot}: dynamic pad cache failed for ${song.tempoMap?.key || "song key"}. ${song.dynamicPad.cacheError || ""}`.trim());
      }
    }
  }
  if (!settings.audioEngine.selectedDeviceName) warnings.push("No default audio device saved.");

  return {
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      librarySongs: library.songs?.length || 0,
      filledSlots: filledSlots.length,
      metadataSlots: metadata.slots.length,
      cacheRows: cacheReport.rows.length
    }
  };
}

async function checkDirectory(folderPath, label, errors) {
  try {
    const result = await stat(folderPath);
    if (!result.isDirectory()) errors.push(`${label} is not a folder.`);
  } catch {
    errors.push(`${label} is missing.`);
  }
}

async function validateSlotCache(slot) {
  if (!slot.cacheFolder) {
    return {
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      state: "not-cached",
      message: "Song cache has not been built.",
      expectedTrackCount: slot.trackCount || null,
      cachedTrackCount: slot.cachedTrackCount || null,
      missingStems: []
    };
  }

  try {
    const folderStat = await stat(slot.cacheFolder);
    if (!folderStat.isDirectory()) throw new Error("Cache path is not a folder.");
  } catch {
    return {
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      state: "failed",
      message: "Cache folder is missing.",
      expectedTrackCount: slot.trackCount || null,
      cachedTrackCount: slot.cachedTrackCount || null,
      missingStems: []
    };
  }

  const expected = positiveNumber(slot.trackCount) || 0;
  const cached = await countWavFiles(slot.cacheFolder);
  const missingStems = Array.isArray(slot.missingStems) ? slot.missingStems : [];
  const state = cached > 0 && cached + missingStems.length >= expected
    ? (missingStems.length ? "warning" : "ready")
    : "failed";

  return {
    slot: slot.slot,
    songId: slot.songId,
    title: slot.title,
    state,
    message: state === "failed" ? "Cached WAV count does not match expected files." : "Cache ready.",
    expectedTrackCount: expected,
    cachedTrackCount: cached,
    missingStems
  };
}

async function countWavFiles(folderPath) {
  let count = 0;
  async function visit(currentPath) {
    let entries = [];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
        count += 1;
      }
    }
  }
  await visit(folderPath);
  return count;
}

async function buildEngineManifest(confirmedSet) {
  const routingPreset = (confirmedSet.settings.routing.presets || [])
    .find((preset) => preset.id === confirmedSet.settings.routing.activePresetId)
    || { id: confirmedSet.settings.routing.activePresetId, routes: {} };
  const songs = [];
  for (const slot of confirmedSet.setlist.slots.filter((item) => item.songId)) {
    const slotMetadata = await readSlotManifestMetadata(slot, confirmedSet.settings);
    const arrangementCache = await readArrangementCacheManifest(slot);
    const playbackStems = arrangementCache?.stems || slot.cachedStems || [];
    const dynamicClickMixer = matchMixerStem({ id: "dynamic-click" }, slotMetadata.mixer);
    const dynamicCueMixer = matchMixerStem({ id: "dynamic-cue" }, slotMetadata.mixer);
    const dynamicPadMixer = matchMixerStem({ id: "dynamic-pad" }, slotMetadata.mixer);
    const manifestTempoMap = arrangementCache
      ? tempoMapForArrangement(slotMetadata.tempoMap, arrangementCache.blocks)
      : slotMetadata.tempoMap;
    const manifestCueMarkers = arrangementCache
      ? cueMarkersForArrangement(slotMetadata.cueMarkers, arrangementCache.blocks, slotMetadata.tempoMap, slotMetadata.arrangement)
      : slotMetadata.cueMarkers;
    const manifestDynamicCues = arrangementCache
      ? await buildDynamicCueManifest(manifestCueMarkers, confirmedSet.settings.dynamicCue.folderPath, manifestTempoMap)
      : slotMetadata.dynamicCues;
    const dynamicPad = await dynamicPadManifestObject({
      folderPath: confirmedSet.settings.pads.folderPath,
      songKey: slotMetadata.tempoMap.key || slot.key,
      mixer: dynamicPadMixer,
      routingPreset
    });
    songs.push({
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      cacheFolder: arrangementCache?.cacheFolder || slot.cacheFolder,
      arrangementCache: arrangementCache ? {
        ready: true,
        cacheFolder: arrangementCache.cacheFolder,
        durationSeconds: arrangementCache.durationSeconds,
        manifestPath: arrangementCache.manifestPath
      } : null,
      expectedTrackCount: slot.trackCount || 0,
      cachedTrackCount: arrangementCache?.stems?.length || slot.cachedTrackCount || 0,
      missingStems: slot.missingStems || [],
      tempoMap: manifestTempoMap,
      regions: slotMetadata.regions,
      cueMarkers: manifestCueMarkers,
      dynamicCues: manifestDynamicCues,
      dynamicCueMap: slotMetadata.dynamicCueMap,
      dynamicClick: {
        soundFolderPath: confirmedSet.settings.dynamicClick.soundFolderPath,
        clickSoundPath: confirmedSet.settings.dynamicClick.clickSoundPath,
        accentSoundPath: confirmedSet.settings.dynamicClick.accentSoundPath,
        source: slotMetadata.dynamicClick?.source || "click-stem-first-16-pattern",
        status: slotMetadata.dynamicClick?.status || "missing-click-stem",
        clickStemPath: slotMetadata.dynamicClick?.clickStemPath || null,
        patternLength: slotMetadata.dynamicClick?.patternLength || 0,
        pattern: Array.isArray(slotMetadata.dynamicClick?.pattern) ? slotMetadata.dynamicClick.pattern : [],
        countPatternLength: slotMetadata.dynamicClick?.countPatternLength || 0,
        countPattern: Array.isArray(slotMetadata.dynamicClick?.countPattern) ? slotMetadata.dynamicClick.countPattern : [],
        countPatternSource: slotMetadata.dynamicClick?.countPatternSource || null,
        clickEventCount: slotMetadata.dynamicClick?.clickEventCount || 0,
        clickEventsSource: slotMetadata.dynamicClick?.clickEventsSource || null,
        clickEvents: Array.isArray(slotMetadata.dynamicClick?.clickEvents) ? slotMetadata.dynamicClick.clickEvents : [],
        confidence: positiveNumber(slotMetadata.dynamicClick?.confidence),
        tempoMap: manifestTempoMap,
        volume: clampNumber(dynamicClickMixer?.volume, 0, 100, 80),
        solo: Boolean(dynamicClickMixer?.solo),
        routing: routeForStem(canonicalBus(dynamicClickMixer?.routeBus || "click"), 0, routingPreset)
      },
      dynamicCue: {
        volume: clampNumber(dynamicCueMixer?.volume, 0, 100, 80),
        solo: Boolean(dynamicCueMixer?.solo),
        routing: routeForStem(canonicalBus(dynamicCueMixer?.routeBus || "dynamicCue"), 0, routingPreset)
      },
      dynamicPad,
      stems: playbackStems
        .map((stem, index) => {
          const mixerStem = matchMixerStem(stem, slotMetadata.mixer);
          return stemManifestEntry(stem, index, routingPreset, mixerStem);
        })
        .filter((stem) => stem.role !== "click")
    });
  }
  return {
    manifestType: "playback-engine-manifest",
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    engine: ENGINE_HELPER,
    source: confirmedSet.source || "confirmed-set",
    confirmedAt: confirmedSet.confirmedAt,
    fingerprint: confirmedSet.fingerprint,
    sampleRate: confirmedSet.settings.audioEngine.sampleRate,
    routingPresetId: confirmedSet.settings.routing.activePresetId,
    routingPreset,
    dynamicCueFolder: confirmedSet.settings.dynamicCue.folderPath,
    padsFolder: confirmedSet.settings.pads.folderPath,
    dynamicClickSoundFolder: confirmedSet.settings.dynamicClick.soundFolderPath,
    dynamicClickSoundPath: confirmedSet.settings.dynamicClick.clickSoundPath,
    dynamicClickAccentSoundPath: confirmedSet.settings.dynamicClick.accentSoundPath,
    readiness: confirmedSet.readiness,
    songs
  };
}

async function readSlotManifestMetadata(slot, settings) {
  const slotDir = join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
  const regions = await readJsonFile(join(slotDir, "regions.json"), { regions: [] });
  const cues = await readJsonFile(join(slotDir, "cue-markers.json"), { cueMarkers: [] });
  const tempoMap = await readJsonFile(join(slotDir, "tempo-map.json"), { key: slot.key || "", bpm: slot.bpm || null, timeSignature: slot.timeSignature || "" });
  const mixer = await readJsonFile(join(slotDir, "mixer.json"), { stems: [] });
  const arrangement = await readJsonFile(join(slotDir, "arrangement.json"), {});
  const dynamicCueMap = await readJsonFile(join(slotDir, "dynamic-cue-map.json"), null);
  const songMetadata = slot.folderPath ? await readSongMetadata(slot.folderPath) : null;
  return {
    regions: normalizeRegions(regions.regions || []),
    cueMarkers: normalizeCueMarkers(cues.cueMarkers || []),
    tempoMap: normalizeTempoMap(tempoMap, slot),
    mixer: normalizeMixer(mixer, slot),
    arrangement: normalizeArrangement(arrangement),
    dynamicClick: songMetadata?.dynamicClick || normalizeSongDynamicClick(null),
    dynamicCueMap,
    dynamicCues: await buildDynamicCueManifest(cues.cueMarkers || [], settings.dynamicCue.folderPath, normalizeTempoMap(tempoMap, slot))
  };
}

async function buildDynamicCueManifest(cueMarkers, folderPath, tempoMap = {}) {
  const cues = normalizeCueMarkers(cueMarkers);
  if (!folderPath) {
    return cues.map((cue) => dynamicCueManifestEntry(cue, null, "not-configured", tempoMap));
  }
  let entries = [];
  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch {
    return cues.map((cue) => dynamicCueManifestEntry(cue, null, "folder-missing", tempoMap));
  }
  const wavs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({ name: entry.name, filePath: join(folderPath, entry.name), key: cueMatchKey(entry.name.replace(/\.wav$/i, "")) }));
  return cues.flatMap((cue) => dynamicCueSequenceEntries(cue, wavs, tempoMap));
}

function dynamicCueManifestEntry(cue, match, status, tempoMap) {
  return {
    cueId: cue.id,
    cueName: cue.name,
    bar: cue.bar,
    beat: cue.beat,
    triggerTimeSeconds: nonNegativeNumber(cue.triggerTimeSeconds) ?? timeForCueMarker(cue, tempoMap),
    status,
    filePath: match?.filePath || ""
  };
}

function dynamicCueSequenceEntries(cue, wavs, tempoMap) {
  const entries = [];
  const numberedCue = numberedSectionCueParts(cue, wavs);
  if (numberedCue) {
    const cueTime = timeForCueMarker(cue, tempoMap);
    entries.push(dynamicCueManifestEntry({
      ...cue,
      id: `${cue.id}-section`,
      name: numberedCue.baseName,
      triggerTimeSeconds: cueTime
    }, numberedCue.baseMatch, "matched", tempoMap));
    entries.push(dynamicCueManifestEntry({
      ...cue,
      id: `${cue.id}-number-${numberedCue.number}`,
      name: numberedCue.numberName,
      triggerTimeSeconds: cueTime + 0.55
    }, numberedCue.numberMatch, "matched", tempoMap));
  } else {
    const sectionMatch = findCueWav(wavs, cue.name);
    entries.push(dynamicCueManifestEntry(cue, sectionMatch, sectionMatch ? "matched" : "missing", tempoMap));
  }

  for (const countCue of countCueMarkersForSectionCue(cue, tempoMap)) {
    const match = findCueWav(wavs, countCue.name);
    entries.push(dynamicCueManifestEntry(countCue, match, match ? "matched" : "missing", tempoMap));
  }

  return entries;
}

function numberedSectionCueParts(cue, wavs) {
  const match = stringValue(cue.name).trim().match(/^(.+?)\s*([2-8])$/);
  if (!match) return null;
  const baseName = match[1].trim();
  const number = Number(match[2]);
  const numberName = cueNumberWord(number);
  if (!baseName || !numberName) return null;
  const baseMatch = findCueWav(wavs, baseName);
  const numberMatch = findCueWav(wavs, numberName);
  if (!baseMatch || !numberMatch) return null;
  return { baseName, number, numberName, baseMatch, numberMatch };
}

function findCueWav(wavs, cueName) {
  return wavs.find((wav) => wav.key === cueMatchKey(cueName));
}

function cueNumberWord(number) {
  return {
    1: "One",
    2: "Two",
    3: "Three",
    4: "Four",
    5: "Five",
    6: "Six",
    7: "Seven",
    8: "Eight"
  }[number] || "";
}

function countCueMarkersForSectionCue(cue, tempoMap) {
  const signature = stringValue(tempoMap?.timeSignature || "4/4");
  const isSixEight = signature.startsWith("6/8");
  const counts = isSixEight
    ? [
        { beat: 4, name: "Four 6/8" },
        { beat: 5, name: "Five 6/8" },
        { beat: 6, name: "Six 6/8" }
      ]
    : [
        { beat: 2, name: "Two" },
        { beat: 3, name: "Three" },
        { beat: 4, name: "Four" }
      ];

  return counts.map((count) => ({
    id: `${cue.id}-count-${count.beat}`,
    name: count.name,
    ...countCueGridPosition(cue, tempoMap, count.beat - 1)
  }));
}

function countCueGridPosition(cue, tempoMap, offset) {
  const beatGrid = Array.isArray(tempoMap?.beatGrid) ? tempoMap.beatGrid : [];
  const cueIndex = beatGrid.findIndex((beat) => {
    return Number(beat.measure) === Number(cue.bar) && Number(beat.beat || beat.beatInMeasure) === Number(cue.beat || 1);
  });
  const target = cueIndex >= 0 ? beatGrid[cueIndex + offset] : null;
  if (!target) {
    return {
      bar: cue.bar,
      beat: Number(cue.beat || 1) + offset
    };
  }
  return {
    bar: Number(target.measure || cue.bar),
    beat: Number(target.beat || target.beatInMeasure || 1),
    triggerTimeSeconds: nonNegativeNumber(target.timeSeconds) ?? timeForCueMarker(cue, tempoMap)
  };
}

function cueMarkersForArrangement(cueMarkers, blocks, tempoMap, arrangement = {}) {
  const cues = normalizeCueMarkers(cueMarkers);
  if (!Array.isArray(blocks) || !blocks.length) return cues;
  const removedCueIds = new Set(Array.isArray(arrangement.removedCueSourceIds) ? arrangement.removedCueSourceIds : []);
  const associatedCueIds = new Set(blocks
    .map((block) => associatedCueForArrangementBlock(cues, block, removedCueIds)?.id)
    .filter(Boolean));
  const arranged = [];
  blocks.forEach((block) => {
    const usedCueIds = new Set();
    const associated = associatedCueForArrangementBlock(cues, block, removedCueIds);
    if (associated) {
      usedCueIds.add(associated.id);
      const rawCueTime = timeForCueMarker(associated, tempoMap);
      arranged.push({
        ...associated,
        id: `${associated.id}-${block.id}`,
        bar: Math.max(1, Number(block.startBar || 1) - 2),
        beat: positiveNumber(associated.beat) || 1,
        triggerTimeSeconds: Math.max(0, Number(block.arrangedStartSeconds || 0) - Math.max(0, Number(block.rawStartSeconds || 0) - rawCueTime))
      });
    }
    cues.forEach((cue) => {
      if (removedCueIds.has(cue.id)) return;
      if (associatedCueIds.has(cue.id)) return;
      if (usedCueIds.has(cue.id)) return;
      const cueBar = positiveNumber(cue.bar) || 1;
      if (cueBar < block.rawStartBar || cueBar >= block.rawEndBar) return;
      const rawCueTime = timeForCueMarker(cue, tempoMap);
      arranged.push({
        ...cue,
        id: `${cue.id}-${block.id}`,
        bar: Number(block.startBar || 1) + (cueBar - Number(block.rawStartBar || 1)),
        beat: positiveNumber(cue.beat) || 1,
        triggerTimeSeconds: Number(block.arrangedStartSeconds || 0) + Math.max(0, rawCueTime - Number(block.rawStartSeconds || 0))
      });
    });
  });
  return arranged;
}

function associatedCueForArrangementBlock(cues, block, removedCueIds) {
  const expectedBar = Math.max(1, Number(block.rawStartBar || 1) - 2);
  const expectedBeat = positiveNumber(block.rawStartBeat) || 1;
  return cues.find((cue) => {
    if (removedCueIds.has(cue.id)) return false;
    if ((positiveNumber(cue.bar) || 1) !== expectedBar || (positiveNumber(cue.beat) || 1) !== expectedBeat) return false;
    return cueNameMatchesRegionServer(cue.name, block.name);
  }) || null;
}

function cueNameMatchesRegionServer(cueName, regionName) {
  const cue = sectionNameKeyServer(cueName);
  const region = sectionNameKeyServer(regionName);
  return Boolean(cue && region && (cue === region || region.startsWith(cue) || cue.startsWith(region)));
}

function sectionNameKeyServer(value) {
  return stringValue(value).toLowerCase().replace(/\d+/g, "").replace(/[^a-z]+/g, "").trim();
}

function tempoMapForArrangement(tempoMap, blocks) {
  const normalized = normalizeTempoMap(tempoMap || {}, {});
  if (!Array.isArray(blocks) || !blocks.length || !Array.isArray(normalized.beatGrid) || !normalized.beatGrid.length) {
    return normalized;
  }
  const beatGrid = [];
  blocks.forEach((block) => {
    normalized.beatGrid.forEach((beat) => {
      const rawTime = nonNegativeNumber(beat.timeSeconds);
      if (rawTime === null || rawTime < Number(block.rawStartSeconds || 0) || rawTime >= Number(block.rawEndSeconds || 0)) return;
      beatGrid.push({
        ...beat,
        measure: Number(block.startBar || 1) + Math.max(0, Number(beat.measure || 1) - Number(block.rawStartBar || 1)),
        timeSeconds: Number(block.arrangedStartSeconds || 0) + Math.max(0, rawTime - Number(block.rawStartSeconds || 0))
      });
    });
  });
  return {
    ...normalized,
    source: `${normalized.source || "tempo-map"}+arrangement`,
    beatGrid
  };
}

function timeForCueMarker(cue, tempoMap) {
  const beatGrid = Array.isArray(tempoMap?.beatGrid) ? tempoMap.beatGrid : [];
  const exact = beatGrid.find((beat) => Number(beat.measure) === Number(cue.bar) && Number(beat.beat) === Number(cue.beat));
  if (exact) return nonNegativeNumber(exact.timeSeconds) ?? 0;
  const measureStart = beatGrid.find((beat) => Number(beat.measure) === Number(cue.bar));
  if (measureStart) return nonNegativeNumber(measureStart.timeSeconds) ?? 0;
  return nonNegativeNumber(beatGrid.at(-1)?.timeSeconds) ?? 0;
}

function cueMatchKey(value) {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchMixerStem(cachedStem, mixer) {
  return (mixer.stems || []).find((stem) => {
    return (stem.id && stem.id === cachedStem.id)
      || (stem.relativePath && stem.relativePath === cachedStem.relativePath)
      || (stem.fileName && stem.fileName === cachedStem.fileName);
  }) || null;
}

function stemManifestEntry(stem, index, routingPreset, mixerStem = null) {
  const role = canonicalBus(mixerStem?.routeBus || mixerStem?.role || stem.bus || stem.role || stem.playbackRole) || "tracks";
  const iemSend = Boolean(mixerStem?.iemSend) && role === "tracks";
  return {
    index: index + 1,
    id: stem.id,
    name: stem.name,
    fileName: stem.fileName,
    role,
    playbackRole: stem.playbackRole || "",
    stemGroup: stem.stemGroup || "",
    playLive: stem.playLive !== false,
    sampleRate: positiveNumber(stem.sampleRate),
    channels: positiveNumber(stem.channels),
    durationMs: positiveNumber(stem.durationMs),
    sha256: stem.sha256 || "",
    volume: clampNumber(mixerStem?.volume, 0, 100, 80),
    solo: Boolean(mixerStem?.solo),
    iemSend,
    sourceRelativePath: stem.relativePath,
    cacheRelativePath: stem.cacheRelativePath || stem.relativePath,
    cachePath: stem.cachePath,
    routing: routeForStem(role, index, routingPreset),
    iemRouting: iemSend ? routeForStem("iem", index, routingPreset) : null
  };
}

function classifyStem(stem) {
  if (stem.bus) return stem.bus;
  if (stem.stemGroup) return stem.stemGroup;
  const text = `${stem.name || ""} ${stem.fileName || ""} ${stem.relativePath || ""}`.toLowerCase();
  if (text.includes("click")) return "click";
  if (text.includes("cue") || text.includes("guide")) return "cue";
  if (text.includes("pad")) return "pads";
  return "tracks";
}

function routeForStem(role, index, routingPreset) {
  const routeKey = canonicalBus(role);
  const presetOutputs = Array.isArray(routingPreset.routes?.[routeKey]) ? routingPreset.routes[routeKey] : [];
  const defaultOutputChannels = [index + 1];
  const outputChannels = presetOutputs.length ? presetOutputs : defaultOutputChannels;
  return {
    presetId: routingPreset.id,
    bus: routeKey,
    outputChannels,
    defaultOutputChannels,
    source: presetOutputs.length ? "routing-preset" : "stem-index-default"
  };
}

async function dynamicPadFilePath(folderPath, songKey) {
  const folder = stringValue(folderPath);
  if (!folder) return "";
  let entries = [];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return "";
  }
  const keyNames = padKeyCandidates(songKey);
  const wavs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({
      name: entry.name,
      filePath: join(folder, entry.name),
      key: padFileMatchKey(entry.name.replace(/\.wav$/i, ""))
    }));
  for (const key of keyNames) {
    const exact = wavs.find((wav) => wav.key === key);
    if (exact) return exact.filePath;
  }
  return "";
}

async function dynamicPadManifestObject({ folderPath, songKey, mixer, routingPreset }) {
  const sourcePath = await dynamicPadFilePath(folderPath, songKey);
  const cached = sourcePath ? await cacheDynamicPadFile(sourcePath, songKey) : { filePath: "", status: "missing", error: "No matching pad WAV." };
  return {
    folderPath,
    sourcePath,
    filePath: cached.filePath || sourcePath,
    cacheStatus: cached.status,
    cacheError: cached.error || "",
    active: false,
    volume: clampNumber(mixer?.volume, 0, 100, 80),
    solo: Boolean(mixer?.solo),
    routing: routeForStem(canonicalBus(mixer?.routeBus || "pads"), 0, routingPreset)
  };
}

async function cacheDynamicPadFile(sourcePath, songKey) {
  try {
    await mkdir(DYNAMIC_PAD_CACHE_DIR, { recursive: true });
    const safeKey = padFileMatchKey(songKey) || "unknown";
    const targetPath = join(DYNAMIC_PAD_CACHE_DIR, `Pad_${safeKey}.wav`);
    await copyFile(sourcePath, targetPath);
    return { filePath: targetPath, status: "cached" };
  } catch (error) {
    return { filePath: "", status: "cache-failed", error: error.message };
  }
}

function padKeyCandidates(songKey) {
  const key = padFileMatchKey(songKey);
  const aliases = {
    db: ["csharp", "db"],
    csharp: ["csharp", "db"],
    eb: ["dsharp", "eb"],
    dsharp: ["dsharp", "eb"],
    gb: ["fsharp", "gb"],
    fsharp: ["fsharp", "gb"],
    ab: ["gsharp", "ab"],
    gsharp: ["gsharp", "ab"],
    bb: ["asharp", "bb"],
    asharp: ["asharp", "bb"]
  };
  return aliases[key] || [key];
}

function padFileMatchKey(value) {
  const text = stringValue(value)
    .toLowerCase()
    .replace(/\u266d/g, "b")
    .replace(/\u266f/g, "#")
    .replace(/sharp/g, "#")
    .replace(/flat/g, "b");
  const tokens = text
    .split(/[^a-z#]+/g)
    .map((token) => token.replace(/(?:major|minor|maj|min)$/g, ""))
    .filter(Boolean);
  const validKeys = new Set(["a", "asharp", "bb", "b", "c", "csharp", "db", "d", "dsharp", "eb", "e", "f", "fsharp", "gb", "g", "gsharp", "ab"]);
  for (const token of tokens) {
    const normalized = token.replace(/#/g, "sharp");
    if (validKeys.has(normalized)) return normalized;
  }
  const compact = text
    .replace(/#/g, "sharp")
    .replace(/\bmajor\b|\bminor\b|\bmaj\b|\bmin\b|\bm\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return validKeys.has(compact) ? compact : "";
}

async function markSetUnconfirmed(setlist) {
  const state = await loadPlaybackState();
  const fingerprint = setFingerprint(setlist);
  if (state.confirmedFingerprint !== fingerprint || !state.confirmed) {
    await removeConfirmedArtifacts();
    await savePlaybackState({
      ...state,
      mode: state.mode === "performance" ? "edit" : state.mode,
      transport: "stopped",
      currentSlot: null,
      activeRegionId: "",
      lastCommand: "",
      commandStatus: "",
      confirmed: false,
      lastMessage: "Setlist changed. Confirm Set before Performance.",
      updatedAt: new Date().toISOString()
    });
  }
}

async function markUnavailableSetlistSongsUnconfirmed(setlist, library) {
  const librarySongIds = new Set((library.songs || []).map((song) => song.id));
  const hasUnavailableSong = (setlist.slots || []).some((slot) => slot.songId && !librarySongIds.has(slot.songId));
  if (!hasUnavailableSong) {
    return;
  }

  const state = await loadPlaybackState();
  await removeConfirmedArtifacts();
  await savePlaybackState({
    ...state,
    mode: "edit",
    transport: "stopped",
    currentSlot: null,
    activeRegionId: "",
    lastCommand: "",
    commandStatus: "",
    confirmed: false,
    lastMessage: "Setlist contains a song outside the current metadata-backed library.",
    updatedAt: new Date().toISOString()
  });
}

async function removeConfirmedArtifacts() {
  await rm(CONFIRMED_SET_FILE, { force: true });
  await rm(ENGINE_MANIFEST_FILE, { force: true });
}

async function cleanupSetlistGeneratedArtifacts(setlist) {
  const filledBySlot = new Map(
    (setlist.slots || [])
      .filter((slot) => slot?.songId)
      .map((slot) => [Number(slot.slot), stringValue(slot.songId)])
  );
  const allowedCacheFolderNames = new Set(
    [...filledBySlot.entries()].map(([slotNumber, songIdValue]) => `slot-${String(slotNumber).padStart(2, "0")}-${songIdValue}`)
  );

  if (activePlaybackProcess?.slot && !filledBySlot.has(activePlaybackProcess.slot)) {
    await stopNativePlayback();
  }

  for (const slot of setlist.slots || []) {
    const slotNumber = Number(slot.slot);
    if (!slotNumber) continue;
    if (slot.songId) {
      const manifest = await readJsonFile(arrangementCacheManifestPath(slotNumber), null);
      if (manifest?.songId && manifest.songId !== slot.songId) {
        await removeGeneratedPath(arrangementCacheSlotDir(slotNumber));
      }
      continue;
    }
    await removeGeneratedPath(join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`));
    await removeGeneratedPath(arrangementCacheSlotDir(slotNumber));
  }

  let metadataEntries = [];
  try {
    metadataEntries = await readdir(SET_METADATA_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of metadataEntries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^slot-(\d+)$/);
    if (match && !filledBySlot.has(Number(match[1]))) {
      await removeGeneratedPath(join(SET_METADATA_DIR, entry.name));
    }
  }

  const currentCacheRoot = join(CACHE_DIR, "current-setlist");
  let entries = [];
  try {
    entries = await readdir(currentCacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^slot-(\d+)-(.+)$/);
    if (!match) continue;
    if (!allowedCacheFolderNames.has(entry.name)) {
      await removeGeneratedPath(join(currentCacheRoot, entry.name));
    }
  }

  let arrangementEntries = [];
  try {
    arrangementEntries = await readdir(ARRANGEMENT_CACHE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of arrangementEntries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^slot-(\d+)$/);
    if (match && !filledBySlot.has(Number(match[1]))) {
      await removeGeneratedPath(join(ARRANGEMENT_CACHE_DIR, entry.name));
    }
  }
}

async function confirmCurrentSet() {
  const settings = await loadSettings();
  const setlist = await prepareSetlistCache(await loadCurrentSetlist(), { rebuild: true });
  await saveCurrentSetlist(setlist);
  const metadata = await ensureSetMetadata(setlist, { allowAnalysis: false });
  await cleanupSetlistGeneratedArtifacts(setlist);
  const cacheReadiness = await buildReadiness(setlist, settings);
  if (!cacheReadiness.cacheReady) {
    const message = cacheReadiness.cacheIssues.map((issue) => `Slot ${issue.slot}: ${issue.message}`).join(" ");
    throw new Error(`Confirm Set failed. ${message || "Cache is not ready."}`);
  }
  await startEngineSimulator(settings, ENGINE_MANIFEST_FILE);
  const readiness = await buildReadiness(setlist, settings);
  const fingerprint = setFingerprint(setlist);
  const confirmed = {
    id: "confirmed-current",
    confirmedAt: new Date().toISOString(),
    fingerprint,
    mode: "performance-ready",
    settings,
    setlist,
    metadata,
    readiness,
    rules: {
      source: "cache-only",
      immutableDuringPerformance: true,
      liveActionHistory: false,
      panicRecoveryFadeSeconds: 4,
      fadeOutBehavior: "fade-then-stop",
      regionRepeat: "once",
      regionLoop: "until-next-action"
    }
  };
  const manifest = await buildEngineManifest(confirmed);
  await writeFile(CONFIRMED_SET_FILE, `${JSON.stringify(confirmed, null, 2)}\n`, "utf8");
  await writeFile(ENGINE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const state = normalizePlaybackState({
    mode: "edit",
    transport: "stopped",
    confirmed: true,
    confirmedFingerprint: fingerprint,
    confirmedAt: confirmed.confirmedAt,
    lastMessage: readiness.canEnterPerformance
      ? "Set confirmed."
      : `Set confirmed. ${readiness.performanceBlockers.join(" ")}`,
    updatedAt: new Date().toISOString()
  });
  await savePlaybackState(state);
  return {
    state,
    confirmedSet: confirmed,
    readiness,
    engineManifest: manifest
  };
}

async function ensureEditPlaybackManifest(slotNumber) {
  const settings = await loadSettings();
  let setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) {
    return { ok: false, error: `Setlist slot ${slotNumber} is empty.` };
  }

  const existingReadiness = await validateSlotCache(slot);
  if (!["ready", "warning"].includes(existingReadiness.state)) {
    setlist = await prepareSetlistCache(setlist, { slotNumbers: [slotNumber] });
    await saveCurrentSetlist(setlist);
  }

  const preparedSlot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  const readiness = preparedSlot ? await validateSlotCache(preparedSlot) : null;
  if (!preparedSlot || !["ready", "warning"].includes(readiness?.state)) {
    return {
      ok: false,
      error: readiness?.message || `Slot ${slotNumber} could not be prepared for editor playback.`
    };
  }

  const metadata = await ensureSetMetadata(setlist, { allowAnalysis: false });
  const fingerprint = setFingerprint(setlist);
  const confirmed = {
    id: "edit-playback-current",
    source: "edit-playback",
    confirmedAt: new Date().toISOString(),
    fingerprint,
    mode: "edit-playback",
    settings,
    setlist,
    metadata,
    readiness: await buildReadiness(setlist, settings),
    rules: {
      source: "cache-only",
      immutableDuringPerformance: false,
      liveActionHistory: false,
      panicRecoveryFadeSeconds: 4,
      fadeOutBehavior: "fade-then-stop",
      regionRepeat: "editor-test",
      regionLoop: "editor-test"
    }
  };
  const manifest = await buildEngineManifest(confirmed);
  const manifestSlot = manifest.songs.find((song) => song.slot === slotNumber);
  if (!manifestSlot?.stems?.length) {
    return { ok: false, error: `Slot ${slotNumber} has no playable stems in the editor manifest.` };
  }
  await writeFile(ENGINE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await startEngineSimulator(settings, ENGINE_MANIFEST_FILE);
  return { ok: true, setlist, manifest };
}

async function setPlaybackMode(mode) {
  const requested = mode === "performance" ? "performance" : "edit";
  const snapshot = await playbackStateSnapshot();
  if (requested === "performance" && !snapshot.confirmed) {
    return {
      ...snapshot,
      mode: "edit",
      lastMessage: "Confirm Set before entering Performance."
    };
  }
  if (requested === "performance" && !snapshot.readiness?.canEnterPerformance) {
    return {
      ...snapshot,
      mode: "edit",
      lastMessage: snapshot.readiness?.performanceBlockers?.join(" ") || "Performance is blocked by readiness checks."
    };
  }

  const nextState = normalizePlaybackState({
    ...snapshot,
    mode: requested,
    transport: requested === "edit" ? "stopped" : snapshot.transport || "stopped",
    lastMessage: requested === "edit"
      ? "Edit mode. Playback stopped."
      : "Performance mode. Set locked.",
    updatedAt: new Date().toISOString()
  });
  await savePlaybackState(nextState);
  return playbackStateSnapshot();
}

async function handlePlaybackCommand(command, payload = {}) {
  const run = playbackCommandQueue.then(() => handlePlaybackCommandLocked(command, payload));
  playbackCommandQueue = run.catch(() => {});
  return run;
}

async function handlePlaybackCommandLocked(command, payload = {}) {
  const allowed = new Set([
    "play",
    "pause",
    "stop",
    "fadeOut",
    "panic",
    "exitPanic",
    "restart",
    "nextSong",
    "previousSong",
    "seek",
    "jumpRegion",
    "skipRegion",
    "repeatRegion",
    "loopRegion",
    "goOnRegion",
    "clearRegionRepeat",
    "triggerRepeatCue"
  ]);
  const action = stringValue(command);
  if (!allowed.has(action)) {
    throw new Error(`Unknown playback command: ${action || "(blank)"}`);
  }

  const state = await loadPlaybackState();
  if (!payload.systemAction && state.transport === "playing" && isPlaybackInterruptCommand(action)) {
    const rejected = normalizePlaybackState({
      ...state,
      lastCommand: action,
      commandStatus: "rejected",
      lastMessage: "Pause or stop before starting another playback command.",
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(rejected);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: false,
      reason: rejected.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: Boolean(activePlaybackProcess)
    };
  }
  let setlist = await loadCurrentSetlist();
  const confirmed = state.confirmed && state.confirmedFingerprint === setFingerprint(setlist);
  const requiresConfirmedSet = new Set(["play", "restart", "nextSong", "previousSong", "seek", "jumpRegion", "skipRegion", "repeatRegion", "loopRegion", "goOnRegion", "clearRegionRepeat", "triggerRepeatCue"]);
  const requiresPerformanceGate = state.mode === "performance" && requiresConfirmedSet.has(action);
  if (requiresPerformanceGate && !confirmed) {
    const rejected = normalizePlaybackState({
      ...state,
      lastCommand: action,
      commandStatus: "rejected",
      lastMessage: "Confirm Set before playback commands can run.",
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(rejected);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: false,
      reason: rejected.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: false
    };
  }
  if (requiresPerformanceGate) {
    const readiness = await buildReadiness(setlist, await loadSettings());
    if (!readiness.canEnterPerformance) {
      const rejected = normalizePlaybackState({
        ...state,
        lastCommand: action,
        commandStatus: "rejected",
        lastMessage: readiness.performanceBlockers.join(" ") || "Playback readiness blocked.",
        updatedAt: new Date().toISOString()
      });
      await savePlaybackState(rejected);
      return {
        state: await playbackStateSnapshot(),
        command: action,
        accepted: false,
        reason: rejected.lastMessage,
        engine: ENGINE_HELPER,
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        nativeEngineConnected: false
      };
    }
  }
  const filledSlots = (setlist.slots || []).filter((slot) => slot.songId);
  const requestedSlot = positiveNumber(payload.slot);
  const baseSlot = action === "nextSong"
    ? state.currentSlot || requestedSlot
    : requestedSlot || state.currentSlot;
  const currentSlot = action === "previousSong"
    ? baseSlot || filledSlots[0]?.slot || null
    : nextCommandSlot(action, baseSlot, filledSlots);
  if (["play", "restart", "nextSong", "previousSong"].includes(action) && !currentSlot) {
    const rejected = normalizePlaybackState({
      ...state,
      lastCommand: action,
      commandStatus: "rejected",
      lastMessage: "No setlist song is available for playback.",
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(rejected);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: false,
      reason: rejected.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: false
    };
  }
  let nativePlayback = { ok: true };
  const resumesPausedPlay = action === "play" && state.transport === "paused" && activePlaybackProcess && activePlaybackProcess.slot === currentSlot;
  const editPlayStartSeconds = action === "play" && state.mode === "edit" && !resumesPausedPlay
    ? nonNegativeNumber(payload.startSeconds ?? payload.seconds)
    : null;
  if (action === "play" && state.mode === "edit" && !resumesPausedPlay) {
    nativePlayback = await ensureEditPlaybackManifest(currentSlot);
    if (nativePlayback.setlist) setlist = nativePlayback.setlist;
  }
  if (nativePlayback.ok && ["play", "restart", "nextSong"].includes(action)) {
    if (resumesPausedPlay) {
      nativePlayback = await sendNativePlaybackCommand("resume");
      nativePlayback.response = { type: "playbackResumed", stemCount: null };
    } else {
      nativePlayback = await startNativeSlotPlayback(currentSlot, {
        startSeconds: editPlayStartSeconds ?? 0
      });
    }
    if (!nativePlayback.ok) {
      const rejected = normalizePlaybackState({
        ...state,
        currentSlot: currentSlot || state.currentSlot || positiveNumber(payload.slot),
        lastCommand: action,
        commandStatus: "rejected",
        lastMessage: nativePlayback.error || "JUCE playback failed to start.",
        updatedAt: new Date().toISOString()
      });
      await savePlaybackState(rejected);
      return {
        state: await playbackStateSnapshot(),
        command: action,
        accepted: false,
        reason: rejected.lastMessage,
        engine: ENGINE_HELPER,
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        nativeEngineConnected: false
      };
    }
  }
  if (action === "pause") {
    await sendNativePlaybackCommand("pause");
  }
  if (action === "seek") {
    await sendNativePlaybackCommand("seek", { seconds: nonNegativeNumber(payload.seconds) ?? 0 });
  }
  if (action === "triggerRepeatCue") {
    const repeatCue = await repeatCueCommandPayload();
    if (repeatCue.ok) {
      await sendNativePlaybackCommand("triggerCue", repeatCue.command);
    }
  }
  if (action === "previousSong" && activePlaybackProcess && activePlaybackProcess.slot === currentSlot) {
    await sendNativePlaybackCommand("seek", { seconds: 0 });
  }
  if (action === "stop") {
    await stopNativePlayback();
  }
  if (action === "fadeOut") {
    await stopNativePlayback({ fade: true, durationMs: 1200 });
  }
  const panicRuntime = action === "panic"
    ? await enterPanicHold(currentSlot || state.currentSlot, payload.source || "operator")
    : action === "exitPanic"
      ? await exitPanicHold(currentSlot || state.currentSlot, payload.source || "operator")
    : ["play", "stop", "fadeOut", "restart", "nextSong", "previousSong"].includes(action)
      ? normalizePanicRuntime({})
      : state.panic;
  const liveRepeat = nextLiveRepeatState(action, state.liveRepeat, payload);
  const transportByCommand = {
    play: "playing",
    pause: "paused",
    stop: "stopped",
    fadeOut: "stopped",
    panic: state.transport === "playing" ? "playing" : "panic",
    exitPanic: state.transport === "panic" ? "playing" : state.transport,
    restart: "playing"
  };
  const previousTimeSeconds = computedPlaybackTimeSeconds(state);
  const nextTransport = transportByCommand[action] || state.transport || "stopped";
  const startsFromZero = ["restart", "nextSong", "previousSong"].includes(action)
    || (action === "play" && !resumesPausedPlay);
  const seekSeconds = action === "seek" ? nonNegativeNumber(payload.seconds) : null;
  const nextTimeSeconds = nextTransport === "stopped"
    ? 0
    : seekSeconds !== null
      ? seekSeconds
      : editPlayStartSeconds !== null
      ? editPlayStartSeconds
      : startsFromZero
      ? 0
      : previousTimeSeconds;
  const nextStartedAt = nextTransport === "playing" ? new Date().toISOString() : "";
  const nextState = normalizePlaybackState({
    ...state,
    currentSlot: currentSlot || state.currentSlot || positiveNumber(payload.slot),
    activeRegionId: stringValue(payload.regionId || state.activeRegionId),
    liveRepeat,
    panic: panicRuntime,
    lastCommand: action,
    commandStatus: "accepted",
    transport: nextTransport,
    currentTimeSeconds: nextTimeSeconds,
    transportAnchorSeconds: nextTimeSeconds,
    transportStartedAt: nextStartedAt,
    lastMessage: commandMessage(action, payload),
    updatedAt: new Date().toISOString()
  });
  await savePlaybackState(nextState);
  const snapshot = await playbackStateSnapshot();
  return {
    state: snapshot,
    command: action,
    accepted: true,
    engine: ENGINE_HELPER,
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    nativeEngineConnected: Boolean(snapshot.readiness?.engine?.nativeEngineConnected),
    nativePlaybackStarted: nativePlayback.response?.type === "playbackStarted",
    nativePlaybackStemCount: positiveNumber(nativePlayback.response?.stemCount)
  };
}

function isPlaybackInterruptCommand(action) {
  return ["play", "restart", "nextSong", "previousSong", "fadeOut", "seek"].includes(action);
}

function nextLiveRepeatState(action, current, payload = {}) {
  const existing = normalizeLiveRepeat(current);
  if (action === "repeatRegion") {
    return normalizeLiveRepeat({
      mode: "once",
      regionId: payload.regionId,
      regionName: payload.regionName,
      queued: true
    });
  }
  if (action === "loopRegion") {
    return normalizeLiveRepeat({
      mode: "loop",
      regionId: payload.regionId,
      regionName: payload.regionName,
      queued: true
    });
  }
  if (action === "goOnRegion" && existing.mode === "loop") {
    return normalizeLiveRepeat({
      ...existing,
      releaseRequested: !payload.deferRelease,
      releaseAfterNextPass: Boolean(payload.deferRelease)
    });
  }
  if (["stop", "fadeOut", "panic", "restart", "nextSong", "previousSong", "clearRegionRepeat"].includes(action)) {
    return normalizeLiveRepeat({});
  }
  return existing;
}

function nextCommandSlot(action, currentSlot, filledSlots) {
  if (!filledSlots.length) return null;
  const ordered = filledSlots.map((slot) => slot.slot).sort((a, b) => a - b);
  const current = positiveNumber(currentSlot) || ordered[0];
  const currentIndex = Math.max(0, ordered.indexOf(current));
  if (action === "nextSong") return ordered[Math.min(ordered.length - 1, currentIndex + 1)];
  if (action === "previousSong") return ordered[Math.max(0, currentIndex - 1)];
  return ordered.includes(current) ? current : ordered[0];
}

function commandMessage(action, payload) {
  const labels = {
    play: "Play command queued.",
    pause: "Pause command queued.",
    stop: "Stop command queued.",
    fadeOut: "Fade out then stop command queued.",
    panic: "Panic hold active. Tracks down, click and cues alive.",
    exitPanic: "Panic recovery active. Tracks fading back in, pad fading out.",
    restart: "Restart command queued.",
    nextSong: "Next song command queued.",
    previousSong: "Return to song start queued.",
    seek: `Seek command queued${payload.seconds ? ` to ${payload.seconds}s` : ""}.`,
    jumpRegion: `Jump${payload.regionName ? ` to ${payload.regionName}` : " region"} command queued.`,
    skipRegion: `Skip${payload.regionName ? ` ${payload.regionName}` : " region"} command queued.`,
    repeatRegion: `Repeat${payload.regionName ? ` ${payload.regionName}` : " region"} once command queued.`,
    loopRegion: `Loop${payload.regionName ? ` ${payload.regionName}` : " region"} until next action command queued.`,
    goOnRegion: "Go On queued at the end of the current loop.",
    clearRegionRepeat: "Region repeat cleared.",
    triggerRepeatCue: "Repeat cue triggered."
  };
  return labels[action] || `${action} command queued.`;
}

async function repeatCueCommandPayload() {
  const settings = await loadSettings();
  const folderPath = stringValue(settings.dynamicCue?.folderPath);
  if (!folderPath) return { ok: false, error: "Dynamic cue folder is not configured." };
  let entries = [];
  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch {
    return { ok: false, error: "Dynamic cue folder is unavailable." };
  }
  const match = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({ name: entry.name, filePath: join(folderPath, entry.name), key: cueMatchKey(entry.name.replace(/\.wav$/i, "")) }))
    .find((entry) => entry.key === cueMatchKey("Repeat"));
  if (!match) return { ok: false, error: "Repeat.wav was not found in the dynamic cue folder." };
  return {
    ok: true,
    command: {
      cueId: "live-repeat",
      cueName: "Repeat",
      filePath: match.filePath
    }
  };
}

async function readCurrentSetMetadata() {
  const setlist = await loadCurrentSetlist();
  await ensureSetMetadata(setlist, { allowAnalysis: false });
  await cleanupSetlistGeneratedArtifacts(setlist);
  const slots = [];
  for (const slot of setlist.slots) {
    if (!slot.songId) continue;
    const slotNumber = String(slot.slot).padStart(2, "0");
    const slotDir = join(SET_METADATA_DIR, `slot-${slotNumber}`);
    const cueRecognition = await readJsonFile(join(slotDir, "cue-recognition-report.json"), null);
    const dynamicCueMap = await readJsonFile(join(slotDir, "dynamic-cue-map.json"), null);
    const arrangementCache = await readArrangementCacheManifest(slot);
    const cueReportMatches = cueRecognition?.songId === slot.songId;
    const cueMapMatches = dynamicCueMap?.songId === slot.songId;
    slots.push({
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      metadataFolder: slotDir,
      regions: await readJsonFile(join(slotDir, "regions.json"), { regions: [] }),
      cues: await readJsonFile(join(slotDir, "cue-markers.json"), { cueMarkers: [] }),
      tempoMap: await readJsonFile(join(slotDir, "tempo-map.json"), { key: slot.key || "", bpm: slot.bpm || null, timeSignature: slot.timeSignature || "" }),
      arrangement: await readJsonFile(join(slotDir, "arrangement.json"), { cuts: [] }),
      audioAlignment: await readSongAudioAlignment(slot.folderPath),
      metadataVersion: await readSongMetadataVersionInfo(slot.folderPath),
      waveform: await readJsonFile(join(slotDir, "waveform-summary.json"), null),
      arrangementCache,
      mixer: await readJsonFile(join(slotDir, "mixer.json"), { stems: [], controls: ["volume", "solo"], pan: false }),
      cueRecognition: cueReportMatches ? cueRecognition : null,
      dynamicCueMap: cueReportMatches && cueMapMatches ? dynamicCueMap : null
    });
  }
  return {
    setMetadataFolder: SET_METADATA_DIR,
    slots
  };
}

async function saveSlotMetadata(slotNumber, metadata) {
  const state = await playbackStateSnapshot();
  if (state.mode === "performance") {
    throw new Error("Metadata edits are locked in Performance mode.");
  }
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);

  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  await mkdir(slotDir, { recursive: true });
  const regions = normalizeRegions(metadata.regions?.regions || metadata.regions || []);
  const cueMarkers = normalizeCueMarkers(metadata.cues?.cueMarkers || metadata.cueMarkers || []);
  const tempoMap = normalizeTempoMap(metadata.tempoMap || {}, slot);
  const mixer = normalizeMixer(metadata.mixer || {}, slot);
  const arrangement = normalizeArrangement(metadata.arrangement || {});

  await writeFile(join(slotDir, "regions.json"), `${JSON.stringify({ regions }, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "cue-markers.json"), `${JSON.stringify({ cueMarkers, dynamicCueMatching: "fuzzy-name" }, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "tempo-map.json"), `${JSON.stringify(tempoMap, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "mixer.json"), `${JSON.stringify(mixer, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "arrangement.json"), `${JSON.stringify(arrangement, null, 2)}\n`, "utf8");
  await saveSongDefaultRegionCueMetadata(slot, regions, cueMarkers);
  await renderArrangementCacheForSlot(slot, { regions, cueMarkers, tempoMap, arrangement, mixer });
  await markSetUnconfirmed(setlist);
  return readCurrentSetMetadata();
}

async function applySlotAudioShift(slotNumber, shiftSeconds) {
  const state = await playbackStateSnapshot();
  if (state.mode === "performance") {
    throw new Error("Audio alignment is locked in Performance mode.");
  }
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  const seconds = Number.isFinite(shiftSeconds) ? Math.max(-30, Math.min(30, shiftSeconds)) : 0;
  await saveSongAudioAlignment(slot.folderPath, seconds);
  const rebuilt = await prepareSetlistCache(setlist, { slotNumbers: [slotNumber] });
  await saveCurrentSetlist(rebuilt);
  await removeGeneratedPath(arrangementCacheSlotDir(slotNumber));
  const nextSlot = rebuilt.slots.find((item) => item.slot === slotNumber && item.songId);
  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  await mkdir(slotDir, { recursive: true });
  if (nextSlot?.cachedStems?.length) {
    await writeSlotWaveformBaseline(nextSlot, join(slotDir, "waveform-summary.json"), WAVEFORM_BUCKETS);
  }
  await markSetUnconfirmed(rebuilt);
  return {
    ok: true,
    slot: slotNumber,
    shiftSeconds: seconds,
    setlist: rebuilt,
    metadata: await readCurrentSetMetadata()
  };
}

async function saveSongDefaultRegionCueMetadata(slot, regions, cueMarkers) {
  if (!slot.folderPath) return;
  const metadataDir = appSongMetadataDir(slot.folderPath);
  await mkdir(metadataDir, { recursive: true });
  await writeFile(appDefaultRegionsPath(slot.folderPath), `${JSON.stringify({
    regions,
    source: "editor-autosave",
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  await writeFile(appDefaultCueMarkersPath(slot.folderPath), `${JSON.stringify({
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: "editor-autosave",
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function readArrangementCacheManifest(slot) {
  const manifestPath = arrangementCacheManifestPath(slot.slot);
  const manifest = await readJsonFile(manifestPath, null);
  if (!manifest?.ready || manifest.songId !== slot.songId) return null;
  return {
    ...manifest,
    manifestPath,
    waveform: await readJsonFile(arrangementCacheWaveformPath(slot.slot), null)
  };
}

async function renderArrangementCacheForSlot(slot, metadata) {
  const arrangement = normalizeArrangement(metadata.arrangement || {});
  const hasArrangement = arrangement.enabled !== false && (arrangement.blocks.length || arrangement.cuts.length);
  const cacheDir = arrangementCacheSlotDir(slot.slot);
  if (!hasArrangement) {
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }
  if (!Array.isArray(slot.cachedStems) || !slot.cachedStems.length) return null;

  const regions = normalizeRegions(metadata.regions || []);
  const tempoMap = normalizeTempoMap(metadata.tempoMap || {}, slot);
  const blocks = arrangementBlocksForRender(slot, regions, arrangement, tempoMap);
  if (!blocks.length) {
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }

  const fingerprint = arrangementFingerprint(slot, arrangement, blocks);
  const existing = await readJsonFile(arrangementCacheManifestPath(slot.slot), null);
  if (existing?.ready && existing.fingerprint === fingerprint) return existing;

  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(arrangementCacheStemsDir(slot.slot), { recursive: true });
  const arrangedStems = [];
  for (const stem of slot.cachedStems) {
    if (!stem.cachePath || !stem.fileName?.toLowerCase().endsWith(".wav")) continue;
    try {
      const rendered = await renderArrangedStem(stem, blocks, arrangementCacheStemsDir(slot.slot));
      arrangedStems.push({
        ...stem,
        cachePath: rendered.filePath,
        cacheRelativePath: relative(cacheDir, rendered.filePath),
        durationMs: Math.round(rendered.durationSeconds * 1000),
        sampleRate: rendered.sampleRate,
        channels: rendered.channels,
        sha256: await fileSha1(rendered.filePath)
      });
    } catch (error) {
      await writeFile(join(cacheDir, "render-error.txt"), `${stem.fileName}: ${error.message}\n`, "utf8");
      throw error;
    }
  }

  const durationSeconds = blocks.reduce((total, block) => total + Math.max(0, block.rawEndSeconds - block.rawStartSeconds), 0);
  const renderSlot = {
    ...slot,
    cacheFolder: arrangementCacheStemsDir(slot.slot),
    cachedStems: arrangedStems
  };
  const waveform = await writeSlotWaveformBaseline(renderSlot, arrangementCacheWaveformPath(slot.slot), WAVEFORM_BUCKETS);
  waveform.source = "arrangement-cache";
  waveform.durationSeconds = durationSeconds;
  await writeFile(arrangementCacheWaveformPath(slot.slot), `${JSON.stringify(waveform, null, 2)}\n`, "utf8");

  const manifest = {
    schema: "playback-v2-arrangement-cache",
    version: 1,
    ready: true,
    generatedAt: new Date().toISOString(),
    slot: slot.slot,
    songId: slot.songId,
    title: slot.title,
    fingerprint,
    cacheFolder: arrangementCacheStemsDir(slot.slot),
    durationSeconds,
    blocks,
    stems: arrangedStems
  };
  await writeFile(arrangementCacheManifestPath(slot.slot), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function arrangementBlocksForRender(slot, regions, arrangement, tempoMap) {
  const orderedRegions = regions.slice().sort(compareRegionsByTimelineServer);
  if (!orderedRegions.length) return [];
  const sourceBlocks = arrangement.blocks.length ? arrangement.blocks : orderedRegions.map((region) => ({ regionId: region.id }));
  const activeCuts = arrangement.blocks.length ? [] : arrangement.cuts;
  let cursor = 1;
  let arrangedSeconds = 0;
  return sourceBlocks.map((block, index) => {
    const region = orderedRegions.find((item) => item.id === block.regionId);
    if (!region) return null;
    const regionStartBar = positiveNumber(region.startBar) || 1;
    const regionEndBar = Math.max(regionStartBar + 1, positiveNumber(region.endBar) || regionStartBar + 1);
    const rawStartBar = Math.max(regionStartBar, positiveNumber(block.trimStartBar) || regionStartBar);
    const rawEndBar = Math.min(regionEndBar, Math.max(rawStartBar + 1, positiveNumber(block.trimEndBar) || regionEndBar));
    if (activeCuts.some((cut) => rawStartBar >= cut.startBar && rawEndBar <= cut.endBar)) return null;
    const rawStartSeconds = timeForBarBeatServer(tempoMap, rawStartBar, positiveNumber(region.startBeat) || 1);
    const rawEndSeconds = timeForBarBeatServer(tempoMap, rawEndBar, positiveNumber(region.endBeat) || 1);
    const length = Math.max(1, rawEndBar - rawStartBar);
    const duration = Math.max(0, rawEndSeconds - rawStartSeconds);
    const arranged = {
      id: block.id || `block-${region.id || index}`,
      regionId: region.id,
      name: region.name || `Region ${index + 1}`,
      startBar: cursor,
      startBeat: 1,
      endBar: cursor + length,
      endBeat: 1,
      rawStartBar,
      rawStartBeat: positiveNumber(region.startBeat) || 1,
      rawEndBar,
      rawEndBeat: positiveNumber(region.endBeat) || 1,
      rawStartSeconds,
      rawEndSeconds,
      arrangedStartSeconds: arrangedSeconds,
      arrangedEndSeconds: arrangedSeconds + duration
    };
    cursor += length;
    arrangedSeconds += duration;
    return arranged;
  }).filter((block) => block && block.rawEndSeconds > block.rawStartSeconds);
}

async function renderArrangedStem(stem, blocks, outputDir) {
  assertInsideCache(stem.cachePath);
  const source = await open(stem.cachePath, "r");
  let output = null;
  try {
    const header = Buffer.alloc(1024 * 1024);
    const headerRead = await source.read(header, 0, header.length, 0);
    const info = parseWavHeader(header.subarray(0, headerRead.bytesRead));
    if (!info?.dataBytes || !info.blockAlign || !info.sampleRate) throw new Error("Unsupported WAV file.");
    const totalFrames = Math.floor(info.dataBytes / info.blockAlign);
    const ranges = blocks.map((block) => ({
      startFrame: Math.max(0, Math.min(totalFrames, Math.floor(block.rawStartSeconds * info.sampleRate))),
      endFrame: Math.max(0, Math.min(totalFrames, Math.ceil(block.rawEndSeconds * info.sampleRate)))
    })).filter((range) => range.endFrame > range.startFrame);
    const outputFrames = ranges.reduce((total, range) => total + (range.endFrame - range.startFrame), 0);
    const outputPath = resolve(outputDir, stem.cacheRelativePath || stem.relativePath || stem.fileName);
    assertInsideArrangementCache(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    output = await open(outputPath, "w");
    const outputHeader = wavHeaderForInfo(info, outputFrames * info.blockAlign);
    await output.write(outputHeader, 0, outputHeader.length, 0);
    let outputPosition = outputHeader.length;
    const buffer = Buffer.alloc(1024 * 1024);
    for (const range of ranges) {
      let remaining = (range.endFrame - range.startFrame) * info.blockAlign;
      let position = info.dataOffset + range.startFrame * info.blockAlign;
      while (remaining > 0) {
        const bytesToRead = Math.min(buffer.length, remaining);
        const read = await source.read(buffer, 0, bytesToRead, position);
        if (!read.bytesRead) break;
        await output.write(buffer, 0, read.bytesRead, outputPosition);
        outputPosition += read.bytesRead;
        position += read.bytesRead;
        remaining -= read.bytesRead;
      }
    }
    return {
      filePath: outputPath,
      durationSeconds: outputFrames / info.sampleRate,
      sampleRate: info.sampleRate,
      channels: info.channels
    };
  } finally {
    await source.close();
    if (output) await output.close();
  }
}

async function applyWavShiftIfNeeded(filePath, shiftSeconds) {
  const seconds = Number(shiftSeconds) || 0;
  if (Math.abs(seconds) < 0.0005) return null;
  return shiftWavFileInPlace(filePath, seconds);
}

async function shiftWavFileInPlace(filePath, shiftSeconds) {
  assertInsideCache(filePath);
  const source = await open(filePath, "r");
  let sourceClosed = false;
  let output = null;
  const tempPath = `${filePath}.aligning`;
  try {
    const header = Buffer.alloc(1024 * 1024);
    const headerRead = await source.read(header, 0, header.length, 0);
    const info = parseWavHeader(header.subarray(0, headerRead.bytesRead));
    if (!info?.dataBytes || !info.blockAlign || !info.sampleRate) throw new Error("Unsupported WAV file.");
    const totalFrames = Math.floor(info.dataBytes / info.blockAlign);
    const shiftFrames = Math.round(Math.abs(shiftSeconds) * info.sampleRate);
    const inputStartFrame = shiftSeconds < 0 ? Math.min(totalFrames, shiftFrames) : 0;
    const silenceFrames = shiftSeconds > 0 ? shiftFrames : 0;
    const copiedFrames = Math.max(0, totalFrames - inputStartFrame);
    const outputFrames = silenceFrames + copiedFrames;
    const outputHeader = wavHeaderForInfo(info, outputFrames * info.blockAlign);
    output = await open(tempPath, "w");
    await output.write(outputHeader, 0, outputHeader.length, 0);
    let outputPosition = outputHeader.length;

    if (silenceFrames) {
      const silence = Buffer.alloc(Math.min(1024 * 1024, silenceFrames * info.blockAlign));
      let remainingSilence = silenceFrames * info.blockAlign;
      while (remainingSilence > 0) {
        const writeBytes = Math.min(silence.length, remainingSilence);
        await output.write(silence, 0, writeBytes, outputPosition);
        outputPosition += writeBytes;
        remainingSilence -= writeBytes;
      }
    }

    const buffer = Buffer.alloc(1024 * 1024);
    let remaining = copiedFrames * info.blockAlign;
    let readPosition = info.dataOffset + inputStartFrame * info.blockAlign;
    while (remaining > 0) {
      const bytesToRead = Math.min(buffer.length, remaining);
      const read = await source.read(buffer, 0, bytesToRead, readPosition);
      if (!read.bytesRead) break;
      await output.write(buffer, 0, read.bytesRead, outputPosition);
      outputPosition += read.bytesRead;
      readPosition += read.bytesRead;
      remaining -= read.bytesRead;
    }
    await source.close();
    sourceClosed = true;
    await output.close();
    output = null;
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
    return {
      filePath,
      durationSeconds: outputFrames / info.sampleRate,
      sampleRate: info.sampleRate,
      channels: info.channels
    };
  } finally {
    try {
      if (!sourceClosed) await source.close();
    } catch {}
    if (output) await output.close();
    await rm(tempPath, { force: true });
  }
}

function wavHeaderForInfo(info, dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(info.audioFormat, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * info.blockAlign, 28);
  header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function saveSlotMixer(slotNumber, value) {
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);

  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  await mkdir(slotDir, { recursive: true });
  const mixer = normalizeMixer(value.mixer || value, slot);
  await writeFile(join(slotDir, "mixer.json"), `${JSON.stringify(mixer, null, 2)}\n`, "utf8");
  await refreshEngineManifestForMixer();
  if (activePlaybackProcess?.slot === slotNumber) {
    const liveSong = await liveMixerManifestSong(slotNumber);
    const playbackState = await loadPlaybackState();
    await sendNativePlaybackCommand("updateMixer", { stems: liveSong?.stems || [] });
    await sendNativePlaybackCommand("updateDynamicMixer", {
      dynamicClick: liveSong?.dynamicClick || null,
      dynamicCue: liveSong?.dynamicCue || null,
      dynamicPad: { ...(liveSong?.dynamicPad || {}), active: playbackState.panic?.active === true }
    });
  }
  return readCurrentSetMetadata();
}

async function applyLiveMixerUpdate(slotNumber, value) {
  if (!slotNumber) throw new Error("Live mixer update needs a setlist slot.");
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  const mixer = normalizeMixer(value.mixer || value, slot);
  if (activePlaybackProcess?.slot !== slotNumber) {
    return { ok: true, active: false, slot: slotNumber };
  }
  const playbackState = await loadPlaybackState();
  const settings = await loadSettings();
  const routingPreset = (settings.routing.presets || [])
    .find((preset) => preset.id === settings.routing.activePresetId)
    || { id: settings.routing.activePresetId, routes: {} };
  const stems = (slot.cachedStems || [])
    .map((stem, index) => stemManifestEntry(stem, index, routingPreset, matchMixerStem(stem, mixer)))
    .filter((stem) => stem.role !== "click");
  const dynamic = await liveDynamicMixerObjects(slot, mixer, routingPreset, settings);
  await sendNativePlaybackCommand("updateMixer", { stems });
  await sendNativePlaybackCommand("updateDynamicMixer", {
    dynamicClick: dynamic.dynamicClick,
    dynamicCue: dynamic.dynamicCue,
    dynamicPad: { ...dynamic.dynamicPad, active: playbackState.panic?.active === true }
  });
  return { ok: true, active: true, slot: slotNumber };
}

async function liveDynamicMixerObjects(slot, mixer, routingPreset, settings) {
  const base = await activeManifestSong(slot.slot) || {};
  const dynamicClickMixer = matchMixerStem({ id: "dynamic-click" }, mixer);
  const dynamicCueMixer = matchMixerStem({ id: "dynamic-cue" }, mixer);
  const dynamicPadMixer = matchMixerStem({ id: "dynamic-pad" }, mixer);
  const songMetadata = slot.folderPath ? await readSongMetadata(slot.folderPath) : null;
  const dynamicPad = await dynamicPadManifestObject({
    folderPath: settings.pads.folderPath,
    songKey: slot.key,
    mixer: dynamicPadMixer,
    routingPreset
  });
  return {
    dynamicClick: {
      ...(base.dynamicClick || songMetadata?.dynamicClick || {}),
      volume: clampNumber(dynamicClickMixer?.volume, 0, 100, 80),
      solo: Boolean(dynamicClickMixer?.solo),
      routing: routeForStem(canonicalBus(dynamicClickMixer?.routeBus || "click"), 0, routingPreset)
    },
    dynamicCue: {
      ...(base.dynamicCue || {}),
      volume: clampNumber(dynamicCueMixer?.volume, 0, 100, 80),
      solo: Boolean(dynamicCueMixer?.solo),
      routing: routeForStem(canonicalBus(dynamicCueMixer?.routeBus || "dynamicCue"), 0, routingPreset)
    },
    dynamicPad: {
      ...(base.dynamicPad || {}),
      ...dynamicPad
    }
  };
}

async function enterPanicHold(slotNumber, source = "operator") {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (activePlaybackProcess?.slot === slotNumber && liveSong) {
    await sendNativePlaybackCommand("updateDynamicMixer", {
      dynamicClick: liveSong.dynamicClick || null,
      dynamicCue: liveSong.dynamicCue || null,
      dynamicPad: { ...(liveSong.dynamicPad || {}), active: true }
    });
  }
  if (activePlaybackProcess?.slot === slotNumber && liveSong?.stems?.length) {
    await fadeLiveMusicStems(liveSong.stems, PANIC_TRACK_GAIN, PANIC_TRACK_FADE_DOWN_MS);
  }
  return {
    state: PANIC_STATES.PANIC_HOLD,
    active: true,
    label: "Panic Active",
    detail: "Tracks Down / Click Alive",
    trackTargetDb: PANIC_TRACK_TARGET_DB,
    source,
    updatedAt: new Date().toISOString()
  };
}

async function exitPanicHold(slotNumber, source = "operator") {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (activePlaybackProcess?.slot === slotNumber && liveSong) {
    await fadeRecoverLiveMusicAndPad(liveSong, PANIC_RECOVERY_FADE_MS);
  }
  return {
    state: PANIC_STATES.NORMAL,
    active: false,
    label: "",
    detail: "",
    trackTargetDb: 0,
    source,
    updatedAt: new Date().toISOString()
  };
}

async function activeManifestSong(slotNumber) {
  const manifest = await readJsonFile(ENGINE_MANIFEST_FILE, null);
  if (!manifest || !Array.isArray(manifest.songs)) return null;
  return manifest.songs.find((song) => song.slot === slotNumber) || null;
}

async function fadeLiveMusicStems(baseStems, targetGain, durationMs) {
  const steps = Math.max(1, Math.floor((Number(durationMs) || 0) / 40));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const gain = 1 + ((targetGain - 1) * progress);
    await sendNativePlaybackCommand("updateMixer", {
      stems: baseStems.map((stem) => ({
        ...stem,
        volume: Number(stem.volume || 0) * gain
      }))
    });
    await sleep(40);
  }
}

async function fadeRecoverLiveMusicAndPad(liveSong, durationMs) {
  const steps = Math.max(1, Math.floor((Number(durationMs) || 0) / 50));
  const basePad = liveSong.dynamicPad || null;
  const basePadVolume = Number(basePad?.volume || 0);
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const stemGain = PANIC_TRACK_GAIN + ((1 - PANIC_TRACK_GAIN) * progress);
    await sendNativePlaybackCommand("updateMixer", {
      stems: (liveSong.stems || []).map((stem) => ({
        ...stem,
        volume: Number(stem.volume || 0) * stemGain
      }))
    });
    if (basePad) {
      await sendNativePlaybackCommand("updateDynamicMixer", {
        dynamicClick: liveSong.dynamicClick || null,
        dynamicCue: liveSong.dynamicCue || null,
        dynamicPad: {
          ...basePad,
          active: progress < 1,
          volume: basePadVolume * (1 - progress)
        }
      });
    }
    await sleep(50);
  }
  if (basePad) {
    await sendNativePlaybackCommand("updateDynamicMixer", {
      dynamicClick: liveSong.dynamicClick || null,
      dynamicCue: liveSong.dynamicCue || null,
      dynamicPad: { ...basePad, active: false }
    });
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, Number(milliseconds) || 0)));
}

async function liveMixerManifestStems(slotNumber) {
  return (await liveMixerManifestSong(slotNumber))?.stems || [];
}

async function liveMixerManifestSong(slotNumber) {
  const settings = await loadSettings();
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) return null;
  const confirmed = {
    id: "live-mixer-update",
    source: "live-mixer-update",
    confirmedAt: new Date().toISOString(),
    fingerprint: setFingerprint(setlist),
    settings,
    setlist,
    metadata: await ensureSetMetadata(setlist, { allowAnalysis: false }),
    readiness: await buildReadiness(setlist, settings)
  };
  const nextManifest = await buildEngineManifest(confirmed);
  return nextManifest.songs.find((item) => Number(item.slot) === Number(slotNumber)) || null;
}

async function refreshEngineManifestForMixer() {
  const state = await loadPlaybackState();
  const setlist = await loadCurrentSetlist();
  const fingerprint = setFingerprint(setlist);
  if (!state.confirmed || state.confirmedFingerprint !== fingerprint) return;

  const settings = await loadSettings();
  const metadata = await ensureSetMetadata(setlist, { allowAnalysis: false });
  const readiness = await buildReadiness(setlist, settings);
  const confirmed = {
    id: "confirmed-current",
    confirmedAt: state.confirmedAt || new Date().toISOString(),
    fingerprint,
    mode: "performance-ready",
    settings,
    setlist,
    metadata,
    readiness,
    rules: {
      source: "cache-only",
      immutableDuringPerformance: true,
      liveActionHistory: false,
      panicRecoveryFadeSeconds: 4,
      fadeOutBehavior: "fade-then-stop",
      regionRepeat: "once",
      regionLoop: "until-next-action"
    }
  };
  const manifest = await buildEngineManifest(confirmed);
  await writeFile(ENGINE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function normalizeRegions(regions) {
  return (Array.isArray(regions) ? regions : []).map((region, index) => ({
    id: stringValue(region.id || `region-${index + 1}`),
    name: stringValue(region.name || region.label || `Region ${index + 1}`),
    startBar: positiveNumber(region.startBar) || 1,
    startBeat: positiveNumber(region.startBeat) || 1,
    endBar: positiveNumber(region.endBar) || 1,
    endBeat: positiveNumber(region.endBeat) || 1
  }));
}

function normalizeCueMarkers(cueMarkers) {
  return (Array.isArray(cueMarkers) ? cueMarkers : []).map((cue, index) => ({
    id: stringValue(cue.id || `cue-${index + 1}`),
    name: stringValue(cue.name || cue.label || `Cue ${index + 1}`),
    bar: positiveNumber(cue.bar) || 1,
    beat: positiveNumber(cue.beat) || 1
  }));
}

function normalizeArrangement(value = {}) {
  return {
    enabled: value.enabled !== false,
    removedCueSourceIds: Array.isArray(value.removedCueSourceIds)
      ? value.removedCueSourceIds.map((id) => stringValue(id)).filter(Boolean)
      : [],
    blocks: (Array.isArray(value.blocks) ? value.blocks : []).map((block, index) => ({
      id: stringValue(block.id || `block-${index + 1}`),
      regionId: stringValue(block.regionId),
      name: stringValue(block.name),
      trimStartBar: positiveNumber(block.trimStartBar),
      trimStartBeat: positiveNumber(block.trimStartBeat),
      trimEndBar: positiveNumber(block.trimEndBar),
      trimEndBeat: positiveNumber(block.trimEndBeat)
    })).filter((block) => block.regionId),
    cuts: (Array.isArray(value.cuts) ? value.cuts : []).map((cut, index) => ({
      id: stringValue(cut.id || `cut-${index + 1}`),
      name: stringValue(cut.name || "Removed section"),
      startBar: positiveNumber(cut.startBar) || 1,
      startBeat: positiveNumber(cut.startBeat) || 1,
      endBar: positiveNumber(cut.endBar) || 1,
      endBeat: positiveNumber(cut.endBeat) || 1,
      startSeconds: nonNegativeNumber(cut.startSeconds) ?? 0,
      endSeconds: nonNegativeNumber(cut.endSeconds) ?? 0,
      rawStartBar: positiveNumber(cut.rawStartBar) || positiveNumber(cut.startBar) || 1,
      rawStartBeat: positiveNumber(cut.rawStartBeat) || positiveNumber(cut.startBeat) || 1,
      rawEndBar: positiveNumber(cut.rawEndBar) || positiveNumber(cut.endBar) || 1,
      rawEndBeat: positiveNumber(cut.rawEndBeat) || positiveNumber(cut.endBeat) || 1
    })).filter((cut) => cut.endBar > cut.startBar || cut.endSeconds > cut.startSeconds)
  };
}

function normalizeTempoMap(value, slot) {
  value = value && typeof value === "object" ? value : {};
  return {
    key: stringValue(value.key || slot.key),
    bpm: positiveNumber(value.bpm || slot.bpm),
    timeSignature: stringValue(value.timeSignature || slot.timeSignature || "4/4"),
    gridStatus: stringValue(value.gridStatus),
    source: stringValue(value.source),
    confidence: positiveNumber(value.confidence),
    measureOne: normalizeMeasureOne(value.measureOne),
    countIn: value.countIn && typeof value.countIn === "object" ? value.countIn : null,
    tempoChanges: normalizeTempoChanges(value.tempoChanges),
    timeSignatureChanges: Array.isArray(value.timeSignatureChanges) ? value.timeSignatureChanges : [],
    beatGrid: normalizeBeatGrid(value.beatGrid)
  };
}

function normalizeTempoChanges(value) {
  return (Array.isArray(value) ? value : [])
    .map((change, index) => ({
      segmentIndex: positiveNumber(change.segmentIndex) ?? index,
      startTimeSeconds: nonNegativeNumber(change.startTimeSeconds) ?? 0,
      startGlobalBeat: Number.isFinite(Number(change.startGlobalBeat)) ? Number(change.startGlobalBeat) : 0,
      bpm: positiveNumber(change.bpm),
      confidence: positiveNumber(change.confidence)
    }))
    .filter((change) => change.bpm);
}

function normalizeBeatGrid(value) {
  return (Array.isArray(value) ? value : [])
    .map((beat, index) => ({
      index: positiveNumber(beat.index) ?? index + 1,
      timeSeconds: nonNegativeNumber(beat.timeSeconds),
      measure: Number.isFinite(Number(beat.measure)) ? Number(beat.measure) : null,
      beat: positiveNumber(beat.beat || beat.beatInMeasure),
      globalBeat: Number.isFinite(Number(beat.globalBeat)) ? Number(beat.globalBeat) : index,
      isDownbeat: Boolean(beat.isDownbeat),
      isCountIn: Boolean(beat.isCountIn),
      tempoSegmentIndex: Number.isFinite(Number(beat.tempoSegmentIndex)) ? Number(beat.tempoSegmentIndex) : 0,
      confidence: positiveNumber(beat.confidence)
    }))
    .filter((beat) => beat.timeSeconds !== null);
}

function normalizeMeasureOne(value) {
  if (!value || typeof value !== "object") return null;
  return {
    timeSeconds: nonNegativeNumber(value.timeSeconds),
    globalBeat: Number.isFinite(Number(value.globalBeat)) ? Number(value.globalBeat) : 0,
    confidence: positiveNumber(value.confidence)
  };
}

function normalizeMixer(value = {}, slot = {}) {
  const stems = Array.isArray(value.stems) ? value.stems : [];
  const normalizedStems = stems.map((stem, index) => ({
    id: stringValue(stem.id || `stem-${index + 1}`),
    name: stringValue(stem.name || stem.fileName || `Stem ${index + 1}`),
    fileName: stringValue(stem.fileName),
    relativePath: stringValue(stem.relativePath),
    role: canonicalBus(stem.role || classifyStem(stem)),
    volume: clampNumber(stem.volume, 0, 100, 80),
    solo: Boolean(stem.solo),
    iemSend: Boolean(stem.iemSend) && canonicalBus(stem.routeBus || stem.role || classifyStem(stem)) === "tracks",
    routeBus: canonicalBus(stem.routeBus || classifyStem(stem))
  }));
  ensureDynamicMixerStems(normalizedStems);
  return {
    controls: ["volume", "solo"],
    pan: false,
    songId: stringValue(slot.songId),
    stems: normalizedStems
  };
}

function ensureDynamicMixerStems(stems) {
  const required = [
    { id: "dynamic-pad", name: "Dynamic Pad", role: "pads", routeBus: "pads" },
    { id: "dynamic-click", name: "Dynamic Click", role: "click", routeBus: "click" },
    { id: "dynamic-cue", name: "Dynamic Cue", role: "dynamicCue", routeBus: "dynamicCue" }
  ];
  for (const requiredStem of required) {
    const existing = stems.find((stem) => stem.id === requiredStem.id);
    if (existing) {
      existing.name = requiredStem.name;
      existing.role = requiredStem.role;
      existing.routeBus = canonicalBus(existing.routeBus || requiredStem.routeBus);
      existing.fileName = "";
      existing.relativePath = "";
      continue;
    }
    stems.push({
      ...requiredStem,
      fileName: "",
      relativePath: "",
      volume: 80,
      solo: false,
      iemSend: false
    });
  }
}

function canonicalBus(value) {
  const bus = stringValue(value);
  if (bus === "music") return "tracks";
  if (bus === "cue") return "cues";
  return bus;
}

async function ensureSetMetadata(setlist, options = {}) {
  const allowAnalysis = options.allowAnalysis !== false;
  await mkdir(SET_METADATA_DIR, { recursive: true });
  const library = await loadLibrary();
  const slots = [];
  for (const slot of setlist.slots) {
    if (!slot.songId) continue;
    const slotDir = join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
    await mkdir(slotDir, { recursive: true });
    const files = {
      info: join(slotDir, "slot-info.json"),
      regions: join(slotDir, "regions.json"),
      cues: join(slotDir, "cue-markers.json"),
      tempoMap: join(slotDir, "tempo-map.json"),
      mixer: join(slotDir, "mixer.json"),
      waveform: join(slotDir, "waveform-summary.json"),
      cueRecognition: join(slotDir, "cue-recognition-report.json"),
      dynamicCueMap: join(slotDir, "dynamic-cue-map.json")
    };
    await resetSlotMetadataIfNeeded(slot, files);
    const song = (library.songs || []).find((item) => item.id === slot.songId);
    if (allowAnalysis) {
      await ensureSongCueAnalysis(slot, song);
    }
    await ensureSongDefaultMetadata(slot, song, { allowAnalysis });
    await migrateExistingSlotMetadataToSongDefaults(slot, files);
    const analyzerTempoMap = await readAnalyzerTempoMapForSlot(slot, song);
    await hydrateSlotRegionsFromDefaults(files.regions, await readSongDefaultRegions(slot));
    await hydrateSlotCuesFromDefaults(files.cues, await readSongDefaultCueMarkers(slot));
    await syncCueAnalysisToSlot(slot, files);
    await writeIfMissing(files.tempoMap, analyzerTempoMap);
    await ensureMixerMetadata(files.mixer, slot, library);
    if (slot.cachedStems?.length) {
      await writeSlotWaveformBaseline(slot, files.waveform, WAVEFORM_BUCKETS);
    }
    const sourceMetadataFingerprint = await songMetadataFingerprintForSlot(slot);
    await writeFile(files.info, `${JSON.stringify({
      schemaVersion: 1,
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      sourceMetadataFingerprint,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
    slots.push({
      slot: slot.slot,
      songId: slot.songId,
      metadataFolder: slotDir,
      files
    });
  }
  return {
    setMetadataFolder: SET_METADATA_DIR,
    slots
  };
}

async function readAnalyzerTempoMapForSlot(slot, song) {
  if (!song?.folderPath && !slot.folderPath) {
    return normalizeTempoMap({}, slot);
  }
  const folderPath = song?.folderPath || slot.folderPath;
  const metadata = await readSongMetadata(folderPath);
  return normalizeTempoMap(metadata.tempoMap || {}, {
    ...slot,
    key: slot.key || metadata.key,
    bpm: slot.bpm || metadata.bpm,
    timeSignature: slot.timeSignature || metadata.timeSignature
  });
}

async function ensureSongDefaultMetadata(slot, song, options = {}) {
  const allowAnalysis = options.allowAnalysis !== false;
  const folderPath = slot.folderPath || song?.folderPath || "";
  if (!folderPath) return;
  const metadataDir = appSongMetadataDir(folderPath);
  await mkdir(metadataDir, { recursive: true });

  const defaultRegionsPath = appDefaultRegionsPath(folderPath);
  const defaultCuesPath = appDefaultCueMarkersPath(folderPath);

  let defaultCues = await readJsonFile(defaultCuesPath, null);
  if (!defaultCues || (!defaultCues.cueMarkers?.length && defaultCues.source === "empty-default")) {
    if (allowAnalysis) {
      defaultCues = await buildDefaultCueMarkersFromAnalysis(folderPath, slot.songId);
      await writeFile(defaultCuesPath, `${JSON.stringify(defaultCues, null, 2)}\n`, "utf8");
    }
  }

  const defaultRegions = await readJsonFile(defaultRegionsPath, null);
  if (!defaultRegions || (!defaultRegions.regions?.length && defaultRegions.source === "empty-default")) {
    if (allowAnalysis) {
      await writeFile(defaultRegionsPath, `${JSON.stringify(await buildDefaultRegionsFromAnalysis(folderPath, slot.songId), null, 2)}\n`, "utf8");
    }
  } else {
    await writeIfMissing(defaultRegionsPath, { regions: [] });
  }
}

async function ensureSongCueAnalysis(slot, song) {
  const folderPath = slot.folderPath || song?.folderPath || "";
  if (!folderPath) return;
  const reportPath = appCueRecognitionReportPath(folderPath);
  const mapPath = appDynamicCueMapPath(folderPath);
  const currentReport = await readJsonFile(reportPath, null);
  const currentMap = await readJsonFile(mapPath, null);
  if (
    currentReport?.songId === slot.songId
    && currentMap?.songId === slot.songId
    && currentReport.candidates?.length
    && Array.isArray(currentReport.regionCandidates)
  ) return;

  const settings = await loadSettings();
  const metadataDir = appSongMetadataDir(folderPath);
  await mkdir(metadataDir, { recursive: true });
  const rawReportPath = join(metadataDir, "cue-analyzer-full-report.json");
  const run = await runAnalyzerFile(["--input", folderPath, "--output", rawReportPath], rawReportPath, { timeoutMs: 300000 });
  if (!run.ok) {
    const report = {
      generatedAt: new Date().toISOString(),
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      status: "error",
      error: run.error || "Analyzer failed.",
      candidates: []
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return;
  }

  const raw = JSON.parse(await readFile(rawReportPath, "utf8"));
  const cueAnalysis = raw.phase3CueAnalysis || {};
  const candidates = compactCueCandidates(cueAnalysis.cueCandidates || []);
  const regionCandidates = compactRegionCandidates(cueAnalysis.regionCandidates || []);
  const report = {
    generatedAt: new Date().toISOString(),
    slot: slot.slot,
    songId: slot.songId,
    title: slot.title,
    sourceFolder: folderPath,
    recognizer: cueAnalysis.speechEngine?.cueRecognizer || cueAnalysis.speechEngine?.cueProvider || "vosk-closed-grammar",
    voskStatus: cueAnalysis.speechEngine?.voskStatus || "",
    status: cueAnalysis.status || raw.analysisStatus || "unknown",
    summary: cueAnalysis.summary || {},
    gridReference: cueAnalysis.gridReference || null,
    source: cueAnalysis.source || null,
    candidates,
    regionCandidates
  };
  const dynamicCueMap = await buildDynamicCueMapFromCandidates(report, settings.dynamicCue.folderPath);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mapPath, `${JSON.stringify(dynamicCueMap, null, 2)}\n`, "utf8");
}

async function migrateExistingSlotMetadataToSongDefaults(slot, files) {
  const folderPath = slot.folderPath || "";
  if (!folderPath) return;
  const existingRegions = await readJsonFile(files.regions, null);
  const existingCues = await readJsonFile(files.cues, null);
  const defaultRegions = await readJsonFile(appDefaultRegionsPath(folderPath), null);
  const defaultCues = await readJsonFile(appDefaultCueMarkersPath(folderPath), null);

  if (existingRegions?.regions?.length && !defaultRegions?.regions?.length) {
    await writeFile(appDefaultRegionsPath(folderPath), `${JSON.stringify({
      regions: normalizeRegions(existingRegions.regions),
      source: "migrated-from-current-set",
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
  }

  if (existingCues?.cueMarkers?.length && !defaultCues?.cueMarkers?.length) {
    await writeFile(appDefaultCueMarkersPath(folderPath), `${JSON.stringify({
      cueMarkers: normalizeCueMarkers(existingCues.cueMarkers),
      dynamicCueMatching: existingCues.dynamicCueMatching || "fuzzy-name",
      source: "migrated-from-current-set",
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
  }

  await copyCueAnalysisIfSongMatches(slot, files);
}

async function readSongDefaultRegions(slot) {
  const folderPath = slot.folderPath || "";
  return await readJsonFile(appDefaultRegionsPath(folderPath), { regions: [] });
}

async function readSongDefaultCueMarkers(slot) {
  const folderPath = slot.folderPath || "";
  return await readJsonFile(appDefaultCueMarkersPath(folderPath), { cueMarkers: [], dynamicCueMatching: "fuzzy-name" });
}

async function buildDefaultCueMarkersFromAnalysis(folderPath, expectedSongId = "") {
  const report = await readJsonFile(appCueRecognitionReportPath(folderPath), null);
  if (expectedSongId && report?.songId !== expectedSongId) {
    return {
      cueMarkers: [],
      dynamicCueMatching: "fuzzy-name",
      source: "empty-default"
    };
  }
  const cueMarkers = (report?.candidates || [])
    .filter((candidate) => ["trusted", "review"].includes(candidate.status))
    .map((candidate, index) => ({
      id: `cue-${candidate.id || index + 1}`,
      name: cueMarkerName(candidate, index),
      bar: positiveNumber(candidate.snappedMeasure || candidate.targetMeasure) || 1,
      beat: positiveNumber(candidate.snappedBeat || candidate.targetBeat) || 1
    }))
    .filter((cue) => cue.name && cue.bar > 0 && cue.beat > 0);
  return {
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: cueMarkers.length ? "dynamic-cue-analysis" : "empty-default"
  };
}

async function buildDefaultRegionsFromAnalysis(folderPath, expectedSongId = "") {
  const report = await readJsonFile(appCueRecognitionReportPath(folderPath), null);
  if (expectedSongId && report?.songId !== expectedSongId) {
    return {
      regions: [],
      source: "empty-default"
    };
  }
  return buildDefaultRegionsFromReport(report || {});
}

async function copyIfMissing(targetPath, sourcePath) {
  if (!sourcePath) return;
  try {
    await stat(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    } catch (copyError) {
      if (copyError.code !== "ENOENT") throw copyError;
    }
  }
}

async function hydrateSlotRegionsFromDefaults(filePath, defaults) {
  const current = await readJsonFile(filePath, null);
  if (current?.regions?.length || !defaults?.regions?.length) {
    await writeIfMissing(filePath, defaults || { regions: [] });
    return;
  }
  await writeFile(filePath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
}

async function hydrateSlotCuesFromDefaults(filePath, defaults) {
  const current = await readJsonFile(filePath, null);
  if (current?.cueMarkers?.length || !defaults?.cueMarkers?.length) {
    await writeIfMissing(filePath, defaults || { cueMarkers: [], dynamicCueMatching: "fuzzy-name" });
    return;
  }
  await writeFile(filePath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
}

async function copyCueAnalysisIfSongMatches(slot, files) {
  const folderPath = slot.folderPath || "";
  if (!folderPath) return;
  const report = await readJsonFile(files.cueRecognition, null);
  if (report?.songId !== slot.songId) return;
  await copyIfMissing(appCueRecognitionReportPath(folderPath), files.cueRecognition);
  const map = await readJsonFile(files.dynamicCueMap, null);
  if (map?.songId === slot.songId) {
    await copyIfMissing(appDynamicCueMapPath(folderPath), files.dynamicCueMap);
  }
}

async function syncCueAnalysisToSlot(slot, files) {
  const folderPath = slot.folderPath || "";
  if (!folderPath) return;
  const appReport = await readJsonFile(appCueRecognitionReportPath(folderPath), null);
  const appMap = await readJsonFile(appDynamicCueMapPath(folderPath), null);
  if (appReport?.songId === slot.songId) {
    const slotReport = await readJsonFile(files.cueRecognition, null);
    if (slotReport?.songId !== slot.songId) {
      await copyFile(appCueRecognitionReportPath(folderPath), files.cueRecognition);
    } else {
      await copyIfMissing(files.cueRecognition, appCueRecognitionReportPath(folderPath));
    }
  }
  if (appMap?.songId === slot.songId) {
    const slotMap = await readJsonFile(files.dynamicCueMap, null);
    if (slotMap?.songId !== slot.songId) {
      await copyFile(appDynamicCueMapPath(folderPath), files.dynamicCueMap);
    } else {
      await copyIfMissing(files.dynamicCueMap, appDynamicCueMapPath(folderPath));
    }
  }
}

async function resetSlotMetadataIfNeeded(slot, files) {
  const current = await readJsonFile(files.info, null);
  const sourceMetadataFingerprint = await songMetadataFingerprintForSlot(slot);
  if (
    current?.schemaVersion === 1
    && current?.songId === slot.songId
    && current?.sourceMetadataFingerprint === sourceMetadataFingerprint
  ) return;
  await rm(files.regions, { force: true });
  await rm(files.cues, { force: true });
  await rm(files.tempoMap, { force: true });
  await rm(files.mixer, { force: true });
  await rm(files.waveform, { force: true });
  await rm(files.cueRecognition, { force: true });
  await rm(files.dynamicCueMap, { force: true });
}

async function songMetadataFingerprintForSlot(slot) {
  if (!slot?.folderPath) return "";
  try {
    return await fileSha1(appSongMetadataPath(slot.folderPath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

async function ensureMixerMetadata(filePath, slot, library) {
  const current = await readJsonFile(filePath, null);
  if (current?.stems?.length) {
    const mixer = normalizeMixer(current, slot);
    if (!mixerHasRequiredDynamicStems(current) || JSON.stringify(mixer) !== JSON.stringify(current)) {
      await writeFile(filePath, `${JSON.stringify(mixer, null, 2)}\n`, "utf8");
    }
    return;
  }
  const song = (library.songs || []).find((item) => item.id === slot.songId);
  const tracks = Array.isArray(song?.tracks) ? song.tracks : [];
  const mixer = normalizeMixer({
    stems: tracks.map((track, index) => ({
      ...trackSummary(track),
      role: canonicalBus(track.bus || classifyStem(track)),
      volume: 80,
      solo: false,
      routeBus: canonicalBus(track.bus || classifyStem(track)),
      order: index + 1
    }))
  }, slot);
  await writeFile(filePath, `${JSON.stringify(mixer, null, 2)}\n`, "utf8");
}

function mixerHasRequiredDynamicStems(mixer) {
  const ids = new Set((Array.isArray(mixer?.stems) ? mixer.stems : []).map((stem) => stem.id));
  return ids.has("dynamic-pad") && ids.has("dynamic-click") && ids.has("dynamic-cue");
}

async function writeIfMissing(filePath, value) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback;
  }
}

async function readSongAudioAlignment(songFolder) {
  if (!songFolder) return { shiftSeconds: 0 };
  return await readJsonFile(appAudioAlignmentPath(songFolder), { shiftSeconds: 0 });
}

async function saveSongAudioAlignment(songFolder, shiftSeconds) {
  if (!songFolder) return;
  const metadataDir = appSongMetadataDir(songFolder);
  await mkdir(metadataDir, { recursive: true });
  const seconds = Math.max(-30, Math.min(30, Number(shiftSeconds) || 0));
  await writeFile(appAudioAlignmentPath(songFolder), `${JSON.stringify({
    schema: "playback-v2-audio-alignment",
    version: 1,
    shiftSeconds: Number(seconds.toFixed(6)),
    mode: seconds > 0 ? "pad-front" : seconds < 0 ? "trim-front" : "none",
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function clearAnalyzerDerivedSongDefaults(songFolder) {
  const removableSources = new Set([
    "",
    "empty-default",
    "dynamic-cue-analysis",
    "derived-from-analyzer-region-candidates"
  ]);
  for (const filePath of [appDefaultRegionsPath(songFolder), appDefaultCueMarkersPath(songFolder)]) {
    const current = await readJsonFile(filePath, null);
    if (!current || removableSources.has(stringValue(current.source))) {
      await rm(filePath, { force: true });
    }
  }
}

async function cleanupGeneratedArtifactsForSong(songIdValue) {
  if (!songIdValue) return;
  const setlist = await loadCurrentSetlist();
  for (const slot of setlist.slots || []) {
    if (slot?.songId !== songIdValue) continue;
    const slotDir = join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
    await removeGeneratedPath(slotDir);
    await removeGeneratedPath(arrangementCacheSlotDir(slot.slot));
  }
  const currentCacheRoot = join(CACHE_DIR, "current-setlist");
  let entries = [];
  try {
    entries = await readdir(currentCacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith(`-${songIdValue}`)) {
      await removeGeneratedPath(join(currentCacheRoot, entry.name));
    }
  }
  await removeConfirmedArtifacts();
}

async function buildSlotWaveformSummary(slotNumber, bucketCount = WAVEFORM_BUCKETS) {
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  await mkdir(slotDir, { recursive: true });
  return writeSlotWaveformBaseline(slot, join(slotDir, "waveform-summary.json"), bucketCount);
}

async function writeSlotWaveformBaseline(slot, filePath, bucketCount = WAVEFORM_BUCKETS) {
  const buckets = Math.max(300, Math.min(3600, Number(bucketCount) || WAVEFORM_BUCKETS));
  const stems = waveformStems(slot);
  const fingerprint = waveformFingerprint(slot, stems, buckets);
  const existing = await readJsonFile(filePath, null);
  if (existing?.fingerprint === fingerprint && Array.isArray(existing.peaks)) return existing;

  const combined = new Float32Array(buckets);
  let tracksUsed = 0;
  let durationSeconds = 0;
  for (const stem of stems.slice(0, WAVEFORM_MAX_STEMS)) {
    try {
      const summary = await readWavPeaks(stem.cachePath, buckets);
      if (!summary?.peaks?.length) continue;
      tracksUsed += 1;
      durationSeconds = Math.max(durationSeconds, summary.durationSeconds || 0, (stem.durationMs || 0) / 1000);
      for (let index = 0; index < buckets; index += 1) {
        combined[index] += summary.peaks[index] * summary.peaks[index];
      }
    } catch {
      // Missing cached stems are already handled by cache readiness.
    }
  }

  const peaks = normalizeWaveformPeaks(Array.from(combined, (value) => Math.sqrt(value)));
  const result = {
    schema: "playback-v2-waveform-summary",
    version: 1,
    source: "cached-live-stems",
    generatedAt: new Date().toISOString(),
    slot: slot.slot,
    songId: slot.songId,
    title: slot.title,
    fingerprint,
    bucketCount: buckets,
    durationSeconds: durationSeconds || positiveNumber(slot.durationSeconds) || null,
    tracksUsed,
    tracksScanned: Math.min(stems.length, WAVEFORM_MAX_STEMS),
    channelMode: "combined-mono",
    excluded: "click-cue-guide-dynamic-app-stems",
    peaks
  };
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function waveformStems(slot) {
  return (Array.isArray(slot.cachedStems) ? slot.cachedStems : [])
    .filter((stem) => stem.playLive !== false)
    .filter((stem) => isMusicWaveformStem(stem))
    .filter((stem) => stem.cachePath && stem.fileName.toLowerCase().endsWith(".wav"))
    .filter((stem) => !pathHasReaperSegment(stem.cachePath));
}

function isMusicWaveformStem(stem) {
  const bus = canonicalBus(stem.bus || stem.role || "");
  const playbackRole = stringValue(stem.playbackRole);
  const stemGroup = stringValue(stem.stemGroup).toLowerCase();
  const text = `${stem.name || ""} ${stem.fileName || ""} ${stem.relativePath || ""} ${stem.cacheRelativePath || ""}`.toLowerCase();
  if (["dynamic-pad", "dynamic-click", "dynamic-cue"].includes(stringValue(stem.id))) return false;
  if (["click", "cues", "dynamicCue"].includes(bus)) return false;
  if (["click-reference", "cue-reference"].includes(playbackRole)) return false;
  if (["click", "cue", "guide"].includes(stemGroup)) return false;
  if (/\b(click|cue|guide|talkback|count[\s_-]*in|countin)\b/i.test(text)) return false;
  return bus === "tracks" || bus === "pads" || playbackRole === "music-stem" || !bus;
}

function waveformFingerprint(slot, stems, bucketCount) {
  return [
    "waveform-v2-music-only:4",
    `slot:${slot.slot}`,
    `song:${slot.songId}`,
    `buckets:${bucketCount}`,
    ...stems.map((stem) => `${stem.cacheRelativePath || stem.relativePath}:${stem.sha256 || ""}:${stem.durationMs || ""}`)
  ].join("|");
}

async function readWavPeaks(filePath, bucketCount) {
  assertInsideCache(filePath);
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(1024 * 1024);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const info = parseWavHeader(header.subarray(0, headerRead.bytesRead));
    if (!info?.dataBytes || !info.blockAlign || !info.sampleRate) return null;
    const totalFrames = Math.floor(info.dataBytes / info.blockAlign);
    if (totalFrames <= 0) return null;
    const peaks = new Float32Array(bucketCount);
    const readFrames = Math.max(1, Math.min(WAVEFORM_READ_FRAMES, totalFrames));
    const buffer = Buffer.alloc(readFrames * info.blockAlign);

    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const startFrame = Math.min(totalFrames - 1, Math.floor((bucket / bucketCount) * totalFrames));
      const endFrame = Math.min(totalFrames, Math.max(startFrame + 1, Math.floor(((bucket + 1) / bucketCount) * totalFrames)));
      const starts = waveformProbeFrames(startFrame, endFrame, readFrames);
      let peak = 0;
      for (const frame of starts) {
        const offset = info.dataOffset + frame * info.blockAlign;
        const read = await handle.read(buffer, 0, readFrames * info.blockAlign, offset);
        peak = Math.max(peak, peakFromWavBuffer(buffer.subarray(0, read.bytesRead), info));
      }
      peaks[bucket] = peak;
    }
    return { peaks, durationSeconds: totalFrames / info.sampleRate };
  } finally {
    await handle.close();
  }
}

function waveformProbeFrames(startFrame, endFrame, readFrames) {
  const span = Math.max(1, endFrame - startFrame);
  const maxStart = Math.max(startFrame, endFrame - readFrames);
  return [...new Set([
    startFrame,
    startFrame + Math.floor(span / 2),
    maxStart
  ].map((frame) => Math.max(startFrame, Math.min(maxStart, frame))))];
}

function parseWavHeader(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format = null;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkId === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        channels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        blockAlign: buffer.readUInt16LE(chunkDataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14)
      };
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataBytes = chunkSize;
      break;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }
  return format ? { ...format, dataOffset, dataBytes } : null;
}

function peakFromWavBuffer(buffer, info) {
  const bytesPerSample = info.bitsPerSample / 8;
  const frames = Math.floor(buffer.length / info.blockAlign);
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * info.blockAlign;
    let monoSample = 0;
    for (let channel = 0; channel < info.channels; channel += 1) {
      monoSample += readWavSample(buffer, frameOffset + channel * bytesPerSample, info);
    }
    peak = Math.max(peak, Math.abs(monoSample / Math.max(1, info.channels)));
  }
  return peak;
}

function readWavSample(buffer, offset, info) {
  const bytes = info.bitsPerSample / 8;
  if (offset < 0 || offset + bytes > buffer.length) return 0;
  if (info.audioFormat === 3 && info.bitsPerSample === 32) return Math.max(-1, Math.min(1, buffer.readFloatLE(offset)));
  if (info.bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (info.bitsPerSample === 24) {
    let value = buffer.readUIntLE(offset, 3);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (info.bitsPerSample === 32) return buffer.readInt32LE(offset) / 2147483648;
  return 0;
}

function normalizeWaveformPeaks(peaks) {
  const sorted = [...peaks].sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.96)] || Math.max(...peaks, 1) || 1;
  return peaks.map((peak) => Number(Math.max(0, Math.min(1, peak / reference)).toFixed(4)));
}

function setFingerprint(setlist) {
  const payload = (setlist.slots || []).map((slot) => ({
    slot: slot.slot,
    songId: slot.songId || null,
    title: slot.title || "",
    cacheStatus: slot.cacheStatus || "",
    cacheFolder: slot.cacheFolder || "",
    cachedTrackCount: slot.cachedTrackCount || null,
    cachedStems: Array.isArray(slot.cachedStems)
      ? slot.cachedStems.map((stem) => ({ id: stem.id, relativePath: stem.relativePath, cacheRelativePath: stem.cacheRelativePath }))
      : [],
    key: slot.key || "",
    bpm: slot.bpm || null,
    timeSignature: slot.timeSignature || ""
  }));
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function normalizeSetlist(value = {}) {
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const slotCount = Math.max(10, slots.length);
  return {
    id: "current",
    name: "Current Set",
    slotCount,
    updatedAt: new Date().toISOString(),
    slots: Array.from({ length: slotCount }, (_, index) => normalizeSetlistSlot(slots[index], index))
  };
}

function normalizeSetlistSlot(slot, index) {
  if (!slot || typeof slot !== "object" || !slot.songId) {
    return { slot: index + 1, songId: null };
  }

  return {
    slot: index + 1,
    songId: stringValue(slot.songId),
    title: stringValue(slot.title),
    vendor: stringValue(slot.vendor),
    folderPath: stringValue(slot.folderPath),
    key: stringValue(slot.key),
    bpm: positiveNumber(slot.bpm),
    timeSignature: stringValue(slot.timeSignature),
    trackCount: positiveNumber(slot.trackCount),
    metadataVersionInfo: normalizeMetadataVersionInfo(slot.metadataVersionInfo),
    cacheStatus: stringValue(slot.cacheStatus),
    cacheFolder: stringValue(slot.cacheFolder),
    cachedTrackCount: positiveNumber(slot.cachedTrackCount),
    cachedAt: stringValue(slot.cachedAt),
    readinessState: stringValue(slot.readinessState),
    missingStems: Array.isArray(slot.missingStems) ? slot.missingStems.map(stringValue).filter(Boolean) : [],
    cachedStems: Array.isArray(slot.cachedStems) ? slot.cachedStems.map(normalizeCachedStem).filter(Boolean) : []
  };
}

function syncSetlistWithLibrary(setlist, library) {
  const songsById = new Map((library.songs || []).map((song) => [song.id, song]));
  return normalizeSetlist({
    ...setlist,
    slots: (setlist.slots || []).map((slot) => {
      if (!slot?.songId) return slot;
      const song = songsById.get(slot.songId);
      if (!song) return slot;
      return {
        ...slot,
        title: song.title,
        vendor: song.vendor,
        folderPath: song.folderPath,
        key: song.key,
        bpm: song.bpm,
        timeSignature: song.timeSignature,
        trackCount: song.trackCount,
        metadataVersionInfo: song.metadataVersionInfo
      };
    })
  });
}

function normalizeMetadataVersionInfo(value = {}) {
  return {
    version: stringValue(value.version),
    analysisCreatedAt: stringValue(value.analysisCreatedAt),
    analysisUpdatedAt: stringValue(value.analysisUpdatedAt),
    importedAt: stringValue(value.importedAt),
    fingerprint: stringValue(value.fingerprint),
    sourcePath: stringValue(value.sourcePath)
  };
}

function normalizeCachedStem(stem) {
  if (!stem || typeof stem !== "object") return null;
  return {
    id: stringValue(stem.id),
    name: stringValue(stem.name),
    fileName: stringValue(stem.fileName),
    relativePath: stringValue(stem.relativePath),
    cacheRelativePath: stringValue(stem.cacheRelativePath || stem.relativePath),
    cachePath: stringValue(stem.cachePath),
    fileId: stringValue(stem.fileId),
    playbackRole: stringValue(stem.playbackRole),
    stemGroup: stringValue(stem.stemGroup),
    bus: stringValue(stem.bus),
    playLive: stem.playLive !== false,
    durationMs: positiveNumber(stem.durationMs),
    sampleRate: positiveNumber(stem.sampleRate),
    channels: positiveNumber(stem.channels),
    sha256: stringValue(stem.sha256)
  };
}

async function prepareSetlistCache(setlist, options = {}) {
  const library = await loadLibrary();
  if (options.rebuild) {
    const cacheRoot = resolve(CACHE_DIR, "current-setlist");
    assertInsideCache(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
  }
  const slotFilter = Array.isArray(options.slotNumbers) && options.slotNumbers.length
    ? new Set(options.slotNumbers.map((slotNumber) => positiveNumber(slotNumber)).filter(Boolean))
    : null;
  const preparedSlots = [];

  for (const slot of setlist.slots) {
    if (!slot.songId) {
      preparedSlots.push(slot);
      continue;
    }
    if (slotFilter && !slotFilter.has(slot.slot)) {
      preparedSlots.push(slot);
      continue;
    }

    const song = library.songs.find((candidate) => candidate.id === slot.songId);
    if (!song?.folderPath) {
      preparedSlots.push({
        ...slot,
        cacheStatus: "missing-source",
        readinessState: "failed",
        cachedTrackCount: null,
        missingStems: [],
        cachedStems: [],
        cachedAt: new Date().toISOString()
      });
      continue;
    }

    try {
      const cache = await cacheSongForSetlistSlot(song, slot.slot);
      preparedSlots.push({
        ...slot,
        folderPath: song.folderPath,
        trackCount: cache.expectedTrackCount,
        cacheStatus: cache.missingStems.length ? "cached-with-warnings" : "cached",
        readinessState: cache.missingStems.length ? "warning" : "ready",
        cacheFolder: cache.cacheFolder,
        cachedTrackCount: cache.cachedTrackCount,
        missingStems: cache.missingStems,
        cachedStems: cache.cachedStems,
        cachedAt: cache.cachedAt
      });
    } catch (error) {
      preparedSlots.push({
        ...slot,
        cacheStatus: `cache-failed: ${error.message}`,
        readinessState: "failed",
        cachedTrackCount: null,
        missingStems: [],
        cachedStems: [],
        cachedAt: new Date().toISOString()
      });
    }
  }

  return {
    ...setlist,
    updatedAt: new Date().toISOString(),
    slots: preparedSlots
  };
}

async function cacheSongForSetlistSlot(song, slotNumber) {
  const tracks = Array.isArray(song.tracks) ? song.tracks : [];
  if (!tracks.length) {
    throw new Error("No metadata WAV files found for song.");
  }
  const alignment = await readSongAudioAlignment(song.folderPath);
  const cacheFolder = resolve(CACHE_DIR, "current-setlist", `slot-${String(slotNumber).padStart(2, "0")}-${song.id}`);
  assertInsideCache(cacheFolder);
  await rm(cacheFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(cacheFolder, { recursive: true });

  const missingStems = [];
  const cachedStems = [];
  let cachedTrackCount = 0;
  for (const track of tracks) {
    const sourcePath = resolve(song.folderPath, track.relativePath);
    const targetPath = resolve(cacheFolder, track.relativePath);
    try {
      assertInsideRoot(sourcePath);
      assertInsideCache(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      const shifted = await applyWavShiftIfNeeded(targetPath, alignment.shiftSeconds);
      cachedTrackCount += 1;
      cachedStems.push({
        ...trackSummary(track),
        cacheRelativePath: track.relativePath,
        cachePath: targetPath,
        durationMs: shifted ? Math.round(shifted.durationSeconds * 1000) : track.durationMs,
        sampleRate: shifted?.sampleRate || track.sampleRate,
        channels: shifted?.channels || track.channels,
        sha256: shifted ? await fileSha1(targetPath) : track.sha256
      });
    } catch {
      missingStems.push(track.relativePath);
    }
  }

  if (!cachedTrackCount) {
    throw new Error("No stems could be cached.");
  }

  return {
    cacheFolder,
    expectedTrackCount: tracks.length,
    cachedTrackCount,
    missingStems,
    cachedStems,
    cachedAt: new Date().toISOString()
  };
}

async function scanLibrary(options = {}) {
  const startedAt = new Date().toISOString();
  const settings = await loadSettings();
  const libraryRoot = selectedLibraryRoot(settings);
  const scanTargets = await libraryScanTargets(libraryRoot);
  const songs = [];
  const skipped = [];
  const duplicateWarnings = [];
  const autoAnalyzeLimit = options.autoAnalyzeLimit === undefined ? 0 : options.autoAnalyzeLimit;
  let autoAnalyzeCount = 0;

  const rootStat = await stat(libraryRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Library root is not a folder: ${libraryRoot}`);
  }

  for (const target of scanTargets) {
    const { vendor, folders } = target;

    for (const folderPath of folders) {
      const metadata = await importSongMetadata(folderPath, {
        autoAnalyze: autoAnalyzeLimit === null || autoAnalyzeCount < autoAnalyzeLimit
      });
      if (metadata.autoAnalyzed) autoAnalyzeCount += 1;
      if (!metadata.valid) {
        await removeDuplicateWavReport(folderPath);
        skipped.push({ vendor, folderPath, reason: metadata.error || "song-metadata.json is missing or invalid." });
        continue;
      }

      const tracks = metadata.tracks;
      if (!tracks.length) {
        await removeDuplicateWavReport(folderPath);
        skipped.push({ vendor, folderPath, reason: "song-metadata.json has no playable WAV files." });
        continue;
      }

      const warnings = duplicateNameWarnings(tracks);
      if (warnings.length) {
        await writeDuplicateWavReport(folderPath, warnings);
      } else {
        await removeDuplicateWavReport(folderPath);
      }
      duplicateWarnings.push(...warnings.map((warning) => ({ ...warning, songFolder: folderPath, vendor })));
      songs.push({
        id: songId(folderPath),
        title: basename(folderPath),
        vendor,
        folderPath,
        metadataPath: appSongMetadataPath(folderPath),
        metadataVersion: metadata.version,
        metadataVersionInfo: await readSongMetadataVersionInfo(folderPath),
        durationSeconds: metadata.durationSeconds,
        baselineStatus: metadata.baselineStatus,
        gridStatus: metadata.gridStatus,
        cueStatus: metadata.cueStatus,
        key: metadata.key,
        bpm: metadata.bpm,
        timeSignature: metadata.timeSignature,
        tempoMap: metadata.tempoMap,
        trackCount: tracks.length,
        duplicateWarnings: warnings,
        tracks: tracks.map(trackSummary)
      });
    }
  }

  songs.sort(sortSongs);
  return {
    root: libraryRoot,
    vendors: [...new Set(scanTargets.map((target) => target.vendor).filter(Boolean))],
    defaultRoot: ROOT,
    scannedAt: startedAt,
    songCount: songs.length,
    duplicateWarningCount: duplicateWarnings.length,
    autoAnalyzeCount,
    songs,
    skipped
  };
}

function selectedLibraryRoot(settings) {
  const requested = resolve(stringValue(settings?.library?.rootPath || ROOT));
  if (!isInsideRoot(requested)) return ROOT;
  return requested;
}

async function libraryScanTargets(libraryRoot) {
  const normalizedRoot = resolve(libraryRoot).toLowerCase();
  const defaultRoot = resolve(ROOT).toLowerCase();
  const rootName = basename(libraryRoot);

  if (normalizedRoot === defaultRoot) {
    const targets = [];
    for (const vendor of VENDORS) {
      const vendorRoot = join(ROOT, vendor);
      targets.push({
        vendor,
        folders: await directChildFolders(vendorRoot)
      });
    }
    return targets;
  }

  if (VENDORS.includes(rootName)) {
    return [{
      vendor: rootName,
      folders: await directChildFolders(libraryRoot)
    }];
  }

  return [{
    vendor: vendorForSongFolder(libraryRoot),
    folders: [libraryRoot]
  }];
}

function vendorForSongFolder(folderPath) {
  const parts = resolve(folderPath).split(/[\\/]+/);
  return [...parts].reverse().find((part) => VENDORS.includes(part)) || basename(dirname(folderPath)) || "Library";
}

async function loadSong(song) {
  const metadata = await readSongMetadata(song.folderPath);
  const tracks = metadata.valid ? metadata.tracks : [];
  const duplicateWarnings = duplicateNameWarnings(tracks);
  if (duplicateWarnings.length) {
    await writeDuplicateWavReport(song.folderPath, duplicateWarnings);
  } else {
    await removeDuplicateWavReport(song.folderPath);
  }

  return {
    ...song,
    trackCount: tracks.length,
    duplicateWarnings,
    tracks: tracks.map(trackSummary),
    loadedAt: new Date().toISOString(),
    status: tracks.length ? "loaded-stopped" : "metadata-missing"
  };
}

async function directChildFolders(folderPath) {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isHiddenName(entry.name)) continue;
    const childPath = resolve(folderPath, entry.name);
    if (pathHasReaperSegment(childPath)) continue;
    folders.push(childPath);
  }
  return folders;
}

async function findWavTracks(songFolder) {
  const tracks = [];

  async function visit(folderPath) {
    if (pathHasReaperSegment(folderPath)) return;
    let entries = [];
    try {
      entries = await readdir(folderPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = resolve(folderPath, entry.name);
      if (isHiddenName(entry.name)) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
        tracks.push({
          id: trackId(songFolder, entryPath),
          name: entry.name.replace(/\.wav$/i, ""),
          fileName: entry.name,
          filePath: entryPath,
          relativePath: relative(songFolder, entryPath)
        });
      }
    }
  }

  await visit(songFolder);
  tracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" }));
  return tracks;
}

async function readSongMetadata(songFolder) {
  try {
    const parsed = JSON.parse(await readFile(appSongMetadataPath(songFolder), "utf8"));
    return parseSongMetadata(songFolder, parsed, appSongMetadataDir(songFolder));
  } catch (error) {
    return {
      valid: false,
      error: error.code === "ENOENT" ? "App song metadata is missing. Refresh Library to import it." : `App song metadata is invalid: ${error.message}`,
      key: "",
      bpm: null,
      timeSignature: "",
      tracks: []
    };
  }
}

async function readSongMetadataVersionInfo(songFolder) {
  const metadata = await readJsonFile(appSongMetadataPath(songFolder), null);
  const sourceManifest = await readJsonFile(join(appSongMetadataDir(songFolder), "source-manifest.json"), null);
  return {
    version: stringValue(metadata?.version || metadata?.analysis?.analyzerVersion),
    analysisCreatedAt: stringValue(metadata?.analysis?.createdAt || metadata?.generatedAt || metadata?.createdAt),
    analysisUpdatedAt: stringValue(metadata?.analysis?.updatedAt || metadata?.updatedAt),
    importedAt: stringValue(sourceManifest?.importedAt),
    fingerprint: stringValue(sourceManifest?.fingerprint),
    sourcePath: stringValue(sourceManifest?.sourcePath)
  };
}

async function importSongMetadata(songFolder, options = {}) {
  try {
    const sourcePath = join(songFolder, "song-metadata.json");
    const raw = await readFile(sourcePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isAnalyzerSongMetadata(parsed)) {
      return invalidSongMetadata("song-metadata.json is not analyzer metadata.");
    }

    const metadataDir = appSongMetadataDir(songFolder);
    await mkdir(metadataDir, { recursive: true });
    const sourceFingerprint = createHash("sha1").update(raw).digest("hex");
    const sourceManifestPath = join(metadataDir, "source-manifest.json");
    const previousSource = await readJsonFile(sourceManifestPath, null);
    if (previousSource?.fingerprint && previousSource.fingerprint !== sourceFingerprint) {
      await clearAnalyzerDerivedSongDefaults(songFolder);
      await cleanupGeneratedArtifactsForSong(songId(songFolder));
    }
    await writeFile(appSongMetadataPath(songFolder), raw, "utf8");
    await writeFile(sourceManifestPath, `${JSON.stringify({
      sourcePath,
      fingerprint: sourceFingerprint,
      importedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
    await importSongGridAnalysis(songFolder, metadataDir, parsed);
    return parseSongMetadata(songFolder, parsed, metadataDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      const existing = await readSongMetadata(songFolder);
      if (existing.valid) return existing;
      if (options.autoAnalyze === false) {
        return invalidSongMetadata("song-metadata.json is missing.");
      }
      return autoAnalyzeSongMetadata(songFolder);
    }
    return invalidSongMetadata(`song-metadata.json is invalid: ${error.message}`);
  }
}

async function autoAnalyzeSongMetadata(songFolder) {
  const analysisSource = await analyzerSourceFolder(songFolder);
  if (!analysisSource) {
    return invalidSongMetadata("No WAV files were found for analyzer import.");
  }

  const metadataDir = appSongMetadataDir(songFolder);
  await mkdir(metadataDir, { recursive: true });
  const rawReportPath = join(metadataDir, "cue-analyzer-full-report.json");
  const run = await runAnalyzerFile(["--input", analysisSource, "--output", rawReportPath], rawReportPath, { timeoutMs: 300000 });
  if (!run.ok) {
    return invalidSongMetadata(`Analyzer import failed: ${run.error || "unknown error"}`);
  }

  let report = null;
  try {
    report = JSON.parse(await readFile(rawReportPath, "utf8"));
  } catch (error) {
    return invalidSongMetadata(`Analyzer report is invalid: ${error.message}`);
  }
  if (!report?.ok) {
    return invalidSongMetadata(report?.message || "Analyzer report did not complete.");
  }

  const metadata = songMetadataFromAnalyzerReport(songFolder, report);
  await writeFile(appSongMetadataPath(songFolder), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeAnalyzerGridReport(metadataDir, report);
  await writeCueDefaultsFromAnalyzerReport(songFolder, report);
  return {
    ...(await parseSongMetadata(songFolder, metadata, metadataDir)),
    autoAnalyzed: true
  };
}

async function analyzerSourceFolder(songFolder) {
  const buckets = new Map();
  const tracks = await findWavTracks(songFolder);
  for (const track of tracks) {
    const folder = dirname(track.filePath);
    buckets.set(folder, (buckets.get(folder) || 0) + 1);
  }
  if (!buckets.size) return "";
  return [...buckets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function songMetadataFromAnalyzerReport(songFolder, report) {
  const phase2Grid = report.phase2Grid || {};
  const tempo = report.providers?.essentia?.tempo || report.providers?.librosa?.tempo || {};
  const key = report.providers?.essentia?.key || report.providers?.librosa?.key || {};
  const timeSignature = phase2Grid.timeSignature?.display || report.timeSignature?.signature || "";
  const bpm = positiveNumber(phase2Grid.tempoMap?.[0]?.bpm) || positiveNumber(tempo.normalizedBpm || tempo.bpm);
  const cueSourcePath = report.phase3CueAnalysis?.source?.absolutePath || "";
  const clickSourcePath = phase2Grid.clickStem?.absolutePath || phase2Grid.clickStem?.sourcePath || "";
  const wavFiles = (Array.isArray(report.audioFiles) ? report.audioFiles : [])
    .map((file) => analyzerAudioFileToMetadata(songFolder, file, { cueSourcePath, clickSourcePath }))
    .filter(Boolean);
  const durationMs = Math.max(0, ...wavFiles.map((file) => positiveNumber(file.durationMs) || 0));
  const aggregate = createHash("sha256")
    .update(wavFiles.map((file) => `${file.path}:${file.sha256}`).sort().join("|"))
    .digest("hex");
  return {
    schema: "worship-playback-song-metadata",
    version: stringValue(report.analyzerVersion || "0.4.0"),
    schemaVersion: 1,
    songId: `song_${aggregate.slice(0, 12)}`,
    title: basename(songFolder),
    titleSource: "folder-name-authoritative",
    sourceDisplayName: basename(songFolder),
    identityMethod: "aggregate-audio-sha256",
    durationSeconds: durationMs ? Math.round(durationMs) / 1000 : positiveNumber(report.durationSeconds),
    bpm,
    rawDetectedBpm: positiveNumber(tempo.rawDetectedBpm || tempo.rawBpm || tempo.bpm),
    normalizedBpm: positiveNumber(tempo.normalizedBpm || tempo.bpm),
    tempoNeedsReview: Boolean(tempo.tempoNeedsReview),
    tempoNormalization: stringValue(tempo.tempoNormalization || tempo.normalizationMethod),
    key: stringValue(key.key),
    timeSignature,
    musicalConfidence: {
      bpm: positiveNumber(tempo.tempoConfidence || tempo.confidence),
      key: positiveNumber(key.confidence),
      timeSignature: positiveNumber(report.timeSignature?.confidence || phase2Grid.timeSignature?.confidence)
    },
    gridStatus: stringValue(phase2Grid.status || report.timeSignature?.status),
    cueStatus: stringValue(report.phase3CueAnalysis?.status),
    baselineStatus: "draft",
    analysis: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analyzerVersion: stringValue(report.analyzerVersion || "0.4.0"),
      source: "auto-library-refresh"
    },
    sourceAudioIdentity: {
      method: "aggregate-audio-sha256",
      wavFiles
    },
    gridAnalysis: {
      gridFile: "analysis/grid-analysis.json",
      status: stringValue(phase2Grid.status),
      source: stringValue(phase2Grid.authoritySource || phase2Grid.sourceProvider || "analyzer")
    },
    cueIntelligence: {
      status: stringValue(report.phase3CueAnalysis?.status),
      cueCandidateCount: positiveNumber(report.phase3CueAnalysis?.summary?.cueCandidateCount) || 0,
      regionCandidateCount: positiveNumber(report.phase3CueAnalysis?.summary?.regionCandidateCount) || 0
    },
    wavFiles
  };
}

function analyzerAudioFileToMetadata(songFolder, file, sources) {
  const sourcePath = resolve(stringValue(file.sourcePath));
  if (!isInsideRoot(sourcePath) || pathHasReaperSegment(sourcePath)) return null;
  const relativePath = relative(songFolder, sourcePath).replace(/\//g, "\\");
  if (!relativePath || relativePath.startsWith("..") || pathHasReaperSegment(relativePath)) return null;
  const role = analyzerPlaybackRole(file, sourcePath, sources);
  const stemGroup = stemGroupFromName(file.originalFilename || basename(sourcePath), role);
  return {
    fileId: stringValue(file.fileId) || trackId(songFolder, sourcePath),
    path: relativePath,
    durationMs: positiveNumber(file.durationMs),
    sampleRate: positiveNumber(file.sampleRate),
    channels: positiveNumber(file.channels),
    sha256: stringValue(file.sha256),
    playbackRole: role,
    stemGroup,
    bus: role === "click-reference" ? "click" : role === "cue-reference" ? "cues" : "tracks",
    playLive: role === "music-stem",
    analysisUse: role === "click-reference"
      ? ["tempo", "grid", "downbeat"]
      : role === "cue-reference"
        ? ["cue-timing", "section-hints"]
        : []
  };
}

function analyzerPlaybackRole(file, sourcePath, sources) {
  const compact = basename(sourcePath).replace(/\.wav$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const cuePath = sources.cueSourcePath ? resolve(sources.cueSourcePath).toLowerCase() : "";
  const clickPath = sources.clickSourcePath ? resolve(sources.clickSourcePath).toLowerCase() : "";
  if (clickPath && sourcePath.toLowerCase() === clickPath) return "click-reference";
  if (cuePath && sourcePath.toLowerCase() === cuePath) return "cue-reference";
  if (file.routing?.role === "click" || compact.includes("clicktrack") || compact === "click") return "click-reference";
  if (["cue", "cues", "guide", "guides", "vocalcue", "vocalcues"].includes(compact)) return "cue-reference";
  return "music-stem";
}

function stemGroupFromName(fileName, role) {
  if (role === "click-reference") return "click";
  if (role === "cue-reference") return "cues";
  const name = fileName.replace(/\.wav$/i, "").toLowerCase();
  if (name.includes("bass")) return "bass";
  if (name.includes("drum")) return "drums";
  if (name.includes("perc") || name.includes("shaker") || name.includes("clap")) return "percussion";
  if (name.includes("piano")) return "piano";
  if (name.includes("keys") || name.includes("organ") || name.includes("rhodes") || name.includes("synth")) return "keys";
  if (name.includes("guitar") || name.includes("electric") || name.includes("acoustic")) return "guitars";
  if (name.includes("vocal") || name.includes("alto") || name.includes("tenor") || name.includes("soprano")) return "vocals";
  if (name.includes("pad")) return "pads";
  return "misc";
}

async function writeAnalyzerGridReport(metadataDir, report) {
  const phase2Grid = report.phase2Grid || {};
  const gridPath = join(metadataDir, "analysis", "grid-analysis.json");
  await mkdir(dirname(gridPath), { recursive: true });
  await writeFile(gridPath, `${JSON.stringify({
    ...phase2Grid,
    bpm: positiveNumber(phase2Grid.tempoMap?.[0]?.bpm) || positiveNumber(report.providers?.essentia?.tempo?.normalizedBpm || report.providers?.librosa?.tempo?.normalizedBpm),
    timeSignature: phase2Grid.timeSignature || report.timeSignature,
    beatGrid: Array.isArray(phase2Grid.beats) ? phase2Grid.beats : []
  }, null, 2)}\n`, "utf8");
}

async function writeCueDefaultsFromAnalyzerReport(songFolder, report) {
  const metadataDir = appSongMetadataDir(songFolder);
  const cueAnalysis = report.phase3CueAnalysis || {};
  const cueReport = {
    generatedAt: new Date().toISOString(),
    songId: songId(songFolder),
    title: basename(songFolder),
    sourceFolder: songFolder,
    recognizer: cueAnalysis.speechEngine?.cueRecognizer || cueAnalysis.speechEngine?.cueProvider || "vosk-closed-grammar",
    voskStatus: cueAnalysis.speechEngine?.voskStatus || "",
    status: cueAnalysis.status || report.analysisStatus || "unknown",
    summary: cueAnalysis.summary || {},
    gridReference: cueAnalysis.gridReference || null,
    source: cueAnalysis.source || null,
    candidates: compactCueCandidates(cueAnalysis.cueCandidates || []),
    regionCandidates: compactRegionCandidates(cueAnalysis.regionCandidates || [])
  };
  await writeFile(appCueRecognitionReportPath(songFolder), `${JSON.stringify(cueReport, null, 2)}\n`, "utf8");
  await writeFile(appDefaultCueMarkersPath(songFolder), `${JSON.stringify(await buildDefaultCueMarkersFromAnalysis(songFolder, songId(songFolder)), null, 2)}\n`, "utf8");
  await writeFile(appDefaultRegionsPath(songFolder), `${JSON.stringify(buildDefaultRegionsFromReport(cueReport), null, 2)}\n`, "utf8");
  await writeIfMissing(appDynamicCueMapPath(songFolder), { entries: [], sourceReport: "cue-recognition-report.json" });
}

async function parseSongMetadata(songFolder, parsed, metadataDir) {
  if (!isAnalyzerSongMetadata(parsed)) {
    return invalidSongMetadata("song-metadata.json is not analyzer metadata.");
  }
  const musical = parsed.musical || {};
  const gridAnalysis = await readApprovedSongGridAnalysis(metadataDir) || await readSongGridAnalysis(metadataDir, parsed);
  const tracks = parsed.wavFiles
    .map((file) => metadataWavTrack(songFolder, file))
    .filter(Boolean)
    .filter((track) => track.playLive === true);
  const key = stringValue(musical.key || parsed.key || parsed.defaultKey || parsed.originalKey);
  const bpm = positiveNumber(gridAnalysis?.bpm) || positiveNumber(musical.displayBpm ?? musical.bpm ?? parsed.bpm ?? parsed.defaultBpm ?? parsed.originalBpm);
  const timeSignature = displayTimeSignature(gridAnalysis?.timeSignature) || displayTimeSignature(musical.timeSignature || parsed.timeSignature || parsed.click?.timeSignature);
  return {
    valid: true,
    version: stringValue(parsed.version),
    durationSeconds: positiveNumber(parsed.durationSeconds),
    baselineStatus: stringValue(parsed.baselineStatus || parsed.baseline?.status),
    gridStatus: stringValue(gridAnalysis?.status || parsed.gridStatus || parsed.gridAnalysis?.status),
    cueStatus: stringValue(parsed.cueStatus || parsed.cueIntelligence?.status),
    key,
    bpm,
    timeSignature,
    dynamicClick: normalizeSongDynamicClick(parsed.dynamicClick),
    tempoMap: analyzerTempoMap({ key, bpm, timeSignature, parsed, gridAnalysis }),
    tracks
  };
}

function normalizeSongDynamicClick(value) {
  const source = value && typeof value === "object" ? value : {};
  const pattern = (Array.isArray(source.pattern) ? source.pattern : [])
    .map((entry) => stringValue(entry).toLowerCase())
    .filter((entry) => entry === "accent" || entry === "normal");
  const countPattern = (Array.isArray(source.countPattern) ? source.countPattern : [])
    .map((entry) => stringValue(entry).trim())
    .filter((entry) => /^[1-9]\d*$/.test(entry));
  const clickEvents = (Array.isArray(source.clickEvents) ? source.clickEvents : [])
    .map((entry, index) => {
      const timeSeconds = nonNegativeNumber(entry?.timeSeconds);
      if (timeSeconds === null) return null;
      const type = stringValue(entry?.type || entry?.clickType).toLowerCase() === "accent" ? "accent" : "normal";
      return {
        index: Number.isInteger(entry?.index) ? entry.index : index,
        timeSeconds,
        type,
        sourceTransientIndex: Number.isInteger(entry?.sourceTransientIndex) ? entry.sourceTransientIndex : null
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  const status = ["ready", "review", "missing-click-stem"].includes(source.status)
    ? source.status
    : pattern.length ? "review" : "missing-click-stem";
  return {
    source: stringValue(source.source || "click-stem-first-16-pattern"),
    clickStemPath: source.clickStemPath === null ? null : stringValue(source.clickStemPath),
    status,
    patternLength: pattern.length,
    pattern,
    countPatternLength: countPattern.length,
    countPattern,
    countPatternSource: countPattern.length ? stringValue(source.countPatternSource || "accent-cadence-repeat") : null,
    clickEventCount: clickEvents.length,
    clickEventsSource: clickEvents.length ? stringValue(source.clickEventsSource || "click-stem-transients") : null,
    clickEvents,
    confidence: positiveNumber(source.confidence),
    warnings: Array.isArray(source.warnings) ? source.warnings : []
  };
}

function displayTimeSignature(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return stringValue(value.display) || (positiveNumber(value.numerator) && positiveNumber(value.denominator)
      ? `${positiveNumber(value.numerator)}/${positiveNumber(value.denominator)}`
      : "");
  }
  return stringValue(value);
}

function isAnalyzerSongMetadata(parsed) {
  return parsed?.schema === "worship-playback-song-metadata" && Array.isArray(parsed.wavFiles);
}

function invalidSongMetadata(error) {
  return {
    valid: false,
    error,
    key: "",
    bpm: null,
    timeSignature: "",
    tracks: []
  };
}

async function importSongGridAnalysis(songFolder, metadataDir, metadata) {
  const gridFile = stringValue(metadata.gridAnalysis?.gridFile || "analysis/grid-analysis.json");
  if (!gridFile) return;
  const relativeGridFile = gridFile.replace(/\//g, "\\");
  const sourcePath = resolve(songFolder, relativeGridFile);
  if (!isInsideRoot(sourcePath) || pathHasReaperSegment(sourcePath)) return;
  try {
    const targetPath = resolve(metadataDir, relativeGridFile);
    if (!targetPath.toLowerCase().startsWith(resolve(metadataDir).toLowerCase())) return;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  } catch {
    // Grid import is best-effort; song-metadata.json still carries basic tempo data.
  }
}

async function readSongGridAnalysis(metadataDir, metadata) {
  const gridFile = stringValue(metadata.gridAnalysis?.gridFile || "analysis/grid-analysis.json");
  if (!gridFile) return null;
  const metadataRoot = resolve(metadataDir);
  const fullPath = resolve(metadataRoot, gridFile.replace(/\//g, "\\"));
  if (!fullPath.toLowerCase().startsWith(metadataRoot.toLowerCase())) return null;
  try {
    return JSON.parse(await readFile(fullPath, "utf8"));
  } catch {
    return null;
  }
}

async function readApprovedSongGridAnalysis(metadataDir) {
  const fullPath = join(metadataDir, "approved-song-grid.json");
  try {
    return normalizeApprovedSongGrid(JSON.parse(await readFile(fullPath, "utf8")));
  } catch {
    return null;
  }
}

function normalizeApprovedSongGrid(value) {
  const grid = value?.grid && typeof value.grid === "object" ? value.grid : value;
  if (!grid || typeof grid !== "object") return null;
  const bpm = positiveNumber(grid.bpm || value?.bpm);
  const signature = grid.timeSignature || value?.timeSignature;
  const timeSignature = typeof signature === "object"
    ? `${positiveNumber(signature.numerator) || 4}/${positiveNumber(signature.denominator) || 4}`
    : stringValue(signature);
  const beatGrid = Array.isArray(grid.beatGrid) ? grid.beatGrid : Array.isArray(grid.beats) ? grid.beats : [];
  if (!bpm || !beatGrid.length) return null;
  return {
    status: stringValue(value.status || "approved"),
    authoritySource: stringValue(value.source || "approved-song-grid"),
    confidence: positiveNumber(value.confidence) || 1,
    bpm,
    timeSignature,
    measureOne: {
      timeSeconds: nonNegativeNumber(grid.gridOriginSeconds) ?? nonNegativeNumber(beatGrid[0]?.timeSeconds) ?? 0,
      globalBeat: Number.isFinite(Number(beatGrid[0]?.globalBeat)) ? Number(beatGrid[0].globalBeat) : 0,
      confidence: 1
    },
    countIn: value.countIn || null,
    tempoMap: Array.isArray(grid.tempoMap)
      ? grid.tempoMap
      : [{ segmentIndex: 0, startTimeSeconds: 0, startGlobalBeat: 0, bpm, confidence: 1 }],
    beatGrid
  };
}

function analyzerTempoMap({ key, bpm, timeSignature, parsed, gridAnalysis }) {
  const grid = gridAnalysis && typeof gridAnalysis === "object" ? gridAnalysis : {};
  const musical = parsed.musical || {};
  return {
    key,
    bpm,
    timeSignature,
    gridStatus: stringValue(grid.status || parsed.gridStatus || parsed.gridAnalysis?.status),
    source: stringValue(grid.authoritySource || grid.sourceProvider || "analyzer"),
    confidence: positiveNumber(grid.confidence),
    measureOne: grid.measureOne || (grid.measureOneBeatOneSeconds ? {
      timeSeconds: grid.measureOneBeatOneSeconds,
      globalBeat: 0,
      confidence: grid.measureOneBeatOneConfidence
    } : null),
    countIn: grid.countIn || null,
    tempoChanges: Array.isArray(grid.tempoMap)
      ? grid.tempoMap
      : musical.normalizedBpm || bpm
        ? [{ segmentIndex: 0, startTimeSeconds: 0, startGlobalBeat: 0, bpm: musical.normalizedBpm || bpm, confidence: musical.bpmConfidence }]
        : [],
    timeSignatureChanges: [],
    beatGrid: Array.isArray(grid.beatGrid)
      ? grid.beatGrid
      : Array.isArray(grid.beats)
        ? grid.beats
        : []
  };
}

function metadataWavTrack(songFolder, file) {
  if (!file || typeof file !== "object") return null;
  const relativePath = stringValue(file.path).replace(/\//g, "\\");
  if (!relativePath || pathHasReaperSegment(relativePath)) return null;
  const filePath = resolve(songFolder, relativePath);
  if (!isInsideRoot(filePath) || pathHasReaperSegment(filePath)) return null;
  const fileName = basename(relativePath);
  const playbackRole = stringValue(file.playbackRole);
  const stemGroup = stringValue(file.stemGroup);
  const bus = canonicalBus(file.bus || (playbackRole === "music-stem" ? "tracks" : stemGroup));
  return {
    id: stringValue(file.fileId) || trackId(songFolder, filePath),
    fileId: stringValue(file.fileId),
    name: fileName.replace(/\.wav$/i, ""),
    fileName,
    filePath,
    relativePath,
    playbackRole,
    stemGroup,
    bus,
    playLive: file.playLive === true,
    durationMs: positiveNumber(file.durationMs),
    sampleRate: positiveNumber(file.sampleRate),
    channels: positiveNumber(file.channels),
    sha256: stringValue(file.sha256),
    analysisUse: Array.isArray(file.analysisUse) ? file.analysisUse.map(stringValue).filter(Boolean) : []
  };
}

function duplicateNameWarnings(tracks) {
  const byName = new Map();
  for (const track of tracks) {
    const key = track.fileName.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(track.relativePath);
  }

  return [...byName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([fileName, paths]) => ({
      fileName,
      message: `Duplicate WAV name found: ${fileName}`,
      paths
    }));
}

async function writeDuplicateWavReport(songFolder, warnings) {
  const reportPath = appDuplicateWavReportPath(songFolder);
  const lines = [
    "Duplicate WAV report",
    `Song folder: ${songFolder}`,
    `Created: ${new Date().toISOString()}`,
    "",
    "These WAV filenames appear more than once in this song folder.",
    "Playback App V2 is only reporting them; it is not deleting or choosing files.",
    ""
  ];

  for (const warning of warnings) {
    lines.push(warning.message);
    for (const path of warning.paths) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
  await removeLegacyDuplicateWavReport(songFolder);
}

async function removeDuplicateWavReport(songFolder) {
  try {
    await unlink(appDuplicateWavReportPath(songFolder));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await removeLegacyDuplicateWavReport(songFolder);
}

async function removeLegacyDuplicateWavReport(songFolder) {
  try {
    await unlink(join(songFolder, "duplicate waves.txt"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function isHiddenName(name) {
  return name.startsWith(".") || name.toLowerCase() === "desktop.ini";
}

function pathHasReaperSegment(filePath) {
  return resolve(filePath)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase().includes("reap"));
}

function songId(folderPath) {
  return `song_${createHash("sha1").update(resolve(folderPath).toLowerCase()).digest("hex").slice(0, 12)}`;
}

function appSongMetadataDir(songFolder) {
  return join(SONG_METADATA_DIR, songId(songFolder));
}

function appSongMetadataPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "song-metadata.json");
}

function appDefaultRegionsPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "default-regions.json");
}

function appDefaultCueMarkersPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "default-cue-markers.json");
}

function appAudioAlignmentPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "audio-alignment.json");
}

function appCueRecognitionReportPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "cue-recognition-report.json");
}

function arrangementCacheSlotDir(slotNumber) {
  return join(ARRANGEMENT_CACHE_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
}

function arrangementCacheStemsDir(slotNumber) {
  return join(arrangementCacheSlotDir(slotNumber), "stems");
}

function arrangementCacheManifestPath(slotNumber) {
  return join(arrangementCacheSlotDir(slotNumber), "manifest.json");
}

function arrangementCacheWaveformPath(slotNumber) {
  return join(arrangementCacheSlotDir(slotNumber), "waveform-summary.json");
}

function compareRegionsByTimelineServer(a, b) {
  const startA = positiveNumber(a.startBar) || 1;
  const startB = positiveNumber(b.startBar) || 1;
  if (startA !== startB) return startA - startB;
  return (positiveNumber(a.startBeat) || 1) - (positiveNumber(b.startBeat) || 1);
}

function timeForBarBeatServer(tempoMap, bar, beat) {
  const beatGrid = Array.isArray(tempoMap?.beatGrid) ? tempoMap.beatGrid : [];
  const exact = beatGrid.find((item) => Number(item.measure) === Number(bar) && Number(item.beat || item.beatInMeasure) === Number(beat));
  if (exact) return nonNegativeNumber(exact.timeSeconds) ?? 0;
  const measure = beatGrid.find((item) => Number(item.measure) === Number(bar));
  if (measure) return nonNegativeNumber(measure.timeSeconds) ?? 0;
  return nonNegativeNumber(beatGrid.at(-1)?.timeSeconds) ?? 0;
}

function arrangementFingerprint(slot, arrangement, blocks) {
  return createHash("sha1").update(JSON.stringify({
    slot: slot.slot,
    songId: slot.songId,
    stems: (slot.cachedStems || []).map((stem) => ({
      path: stem.cacheRelativePath || stem.relativePath,
      sha256: stem.sha256,
      durationMs: stem.durationMs
    })),
    arrangement,
    blocks
  })).digest("hex");
}

async function fileSha1(filePath) {
  const hash = createHash("sha1");
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function appDynamicCueMapPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "dynamic-cue-map.json");
}

function appDuplicateWavReportPath(songFolder) {
  return join(appSongMetadataDir(songFolder), "duplicate-waves.txt");
}

function trackId(songFolder, filePath) {
  return createHash("sha1")
    .update(relative(songFolder, filePath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function trackSummary(track) {
  return {
    id: track.id,
    fileId: track.fileId || "",
    name: track.name,
    fileName: track.fileName,
    relativePath: track.relativePath,
    playbackRole: track.playbackRole || "",
    stemGroup: track.stemGroup || "",
    bus: canonicalBus(track.bus || ""),
    playLive: track.playLive !== false,
    durationMs: positiveNumber(track.durationMs),
    sampleRate: positiveNumber(track.sampleRate),
    channels: positiveNumber(track.channels),
    sha256: track.sha256 || ""
  };
}

function sortSongs(a, b) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    || a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sameText(left, right) {
  return stringValue(left).toLowerCase() === stringValue(right).toLowerCase();
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function streamStem(req, res, songIdValue, trackIdValue) {
  const library = await loadLibrary();
  const song = library.songs.find((item) => item.id === songIdValue);
  if (!song) return json(res, { error: "Song not found." }, 404);

  const loaded = await loadSong(song);
  const track = loaded.tracks.find((item) => item.id === trackIdValue);
  if (!track) return json(res, { error: "Track not found." }, 404);

  const filePath = resolve(song.folderPath, track.relativePath);
  if (!isInsideRoot(filePath) || pathHasReaperSegment(filePath)) {
    return json(res, { error: "Track path is not allowed." }, 403);
  }

  const fileStat = await stat(filePath);
  const range = req.headers.range;
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) return json(res, { error: "Invalid range." }, 416);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
      "Content-Length": end - start + 1
    });
    return createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { "Content-Length": fileStat.size });
  return createReadStream(filePath).pipe(res);
}

function isInsideRoot(filePath) {
  const normalizedRoot = resolve(ROOT).toLowerCase();
  const normalizedFile = resolve(filePath).toLowerCase();
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}\\`);
}

function assertInsideRoot(filePath) {
  if (!isInsideRoot(filePath) || pathHasReaperSegment(filePath)) {
    throw new Error("Source track path is not allowed.");
  }
}

function assertInsideCache(filePath) {
  const normalizedCache = resolve(CACHE_DIR).toLowerCase();
  const normalizedArrangementCache = resolve(ARRANGEMENT_CACHE_DIR).toLowerCase();
  const normalizedFile = resolve(filePath).toLowerCase();
  const insideCache = normalizedFile === normalizedCache || normalizedFile.startsWith(`${normalizedCache}\\`);
  const insideArrangementCache = normalizedFile === normalizedArrangementCache || normalizedFile.startsWith(`${normalizedArrangementCache}\\`);
  if (!insideCache && !insideArrangementCache) {
    throw new Error("Cache path is not allowed.");
  }
}

function assertInsideData(filePath) {
  const normalizedData = resolve(DATA_DIR).toLowerCase();
  const normalizedFile = resolve(filePath).toLowerCase();
  if (normalizedFile !== normalizedData && !normalizedFile.startsWith(`${normalizedData}\\`)) {
    throw new Error("Generated data path is not allowed.");
  }
}

async function removeGeneratedPath(filePath) {
  assertInsideData(filePath);
  await rm(filePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertInsideArrangementCache(filePath) {
  const normalizedCache = resolve(ARRANGEMENT_CACHE_DIR).toLowerCase();
  const normalizedFile = resolve(filePath).toLowerCase();
  if (normalizedFile !== normalizedCache && !normalizedFile.startsWith(`${normalizedCache}\\`)) {
    throw new Error("Arrangement cache path is not allowed.");
  }
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  if (!filePath.toLowerCase().startsWith(PUBLIC_DIR.toLowerCase())) {
    return json(res, { error: "Forbidden." }, 403);
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return json(res, { error: "Not found." }, 404);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream" });
    return createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, { error: "Not found." }, 404);
    throw error;
  }
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

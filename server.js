import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
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
const SONG_OVERRIDES_DIR = join(DATA_DIR, "song-overrides");
const KEY_CACHE_DIR = join(DATA_DIR, "key-cache");
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
const FFMPEG_EXE_CANDIDATES = [
  process.env.FFMPEG_EXE,
  join(__dirname, "tools", "ffmpeg", "bin", "ffmpeg.exe"),
  "D:\\WorshipPlaybackEngine\\tools\\ffmpeg\\bin\\ffmpeg.exe"
].filter(Boolean);
const ENGINE_HELPER_CANDIDATES = [
  process.env.JUCE_AUDIO_ENGINE_PATH,
  join(__dirname, "native", "juce-audio-engine", "bin", "win-x64", "juce-audio-engine.exe"),
  join(__dirname, "native", "juce-audio-engine", "build", "juce-audio-engine_artefacts", "Release", "juce-audio-engine.exe"),
  join(__dirname, "native", "juce-audio-engine", "build", "juce-audio-engine_artefacts", "Debug", "juce-audio-engine.exe")
].filter(Boolean);
let activePlaybackProcess = null;
let playbackCommandQueue = Promise.resolve();
let liveSupervisorInFlight = false;
let liveSupervisorLastError = "";
let liveSupervisorLastTickAt = "";
let liveSupervisorLastAction = "";
let liveSupervisorLastActionAt = "";
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
const CUE_MARKER_RULE_VERSION = "cue-marker-snapped-source-v3-2026-07-24";
const KEY_CHANGE_CACHE_VERSION = "rubberband-key-cache-v1";
const KEY_OPTIONS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const TRANSITION_MODES = new Set(["cue-next", "stay", "autolink", "crossfade", "overlap"]);
const TRANSITION_PAD_BEHAVIORS = new Set(["off", "hold-current-key", "next-song-key", "crossfade-to-next-key"]);

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
      const metadata = await ensureSetMetadata(setlist, { allowAnalysis: false });
      await cleanupSetlistGeneratedArtifacts(setlist);
      await markUnavailableSetlistSongsUnconfirmed(setlist, library);
      await refreshEngineManifestForMixer();
      return json(res, { ...library, currentSetlist: setlist, metadata });
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

    if (req.method === "GET" && url.pathname === "/api/audio/diagnostics") {
      return json(res, await audioDeviceDiagnostics());
    }

    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readJsonBody(req);
      const update = playbackCommandQueue.then(() => updateSettingsTransaction(body));
      playbackCommandQueue = update.catch(() => {});
      return json(res, await update);
    }

    if (req.method === "GET" && url.pathname === "/api/setlist/current") {
      return json(res, await loadCurrentSetlist());
    }

    if (req.method === "PUT" && url.pathname === "/api/setlist/current") {
      const body = await readJsonBody(req);
      const previousSetlist = await loadCurrentSetlist();
      const previousFingerprint = setFingerprint(previousSetlist);
      const setlist = await prepareSetlistCache(normalizeSetlist(body));
      const nextFingerprint = setFingerprint(setlist);
      await saveCurrentSetlist(setlist);
      await ensureSetMetadata(setlist, { allowAnalysis: false });
      await cleanupSetlistGeneratedArtifacts(setlist);
      if (nextFingerprint !== previousFingerprint) {
        await markSetUnconfirmed(setlist);
      }
      return json(res, setlist);
    }

    const slotKeyMatch = url.pathname.match(/^\/api\/setlist\/slot\/(\d+)\/key$/);
    if (req.method === "PUT" && slotKeyMatch) {
      const body = await readJsonBody(req);
      return json(res, await updateSetlistSlotKey(positiveNumber(slotKeyMatch[1]), body.key));
    }

    if (req.method === "GET" && url.pathname === "/api/playback/state") {
      return json(res, await playbackStateSnapshot());
    }

    if (req.method === "GET" && url.pathname === "/api/playback/state-stream") {
      return openPlaybackStateStream(req, res);
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

    if (req.method === "POST" && url.pathname === "/api/set-metadata/current/rehydrate") {
      const body = await readJsonBody(req);
      return json(res, await rehydrateCurrentSetMetadata({
        includeWaveforms: body.includeWaveforms === true
      }));
    }

    if (req.method === "GET" && url.pathname === "/api/set-metadata/current/audit") {
      return json(res, await auditCurrentSetMetadata());
    }

    const metadataSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)$/);
    if (metadataSlotMatch && req.method === "PUT") {
      const body = await readJsonBody(req);
      return json(res, await saveSlotMetadata(Number(metadataSlotMatch[1]), body));
    }

    const approveSlotMatch = url.pathname.match(/^\/api\/set-metadata\/current\/slot\/(\d+)\/approve$/);
    if (approveSlotMatch && req.method === "POST") {
      return json(res, await approveSlotCueRegionMetadata(Number(approveSlotMatch[1])));
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
  startLiveSupervisor();
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
  const temporaryPath = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, SETTINGS_FILE);
}

async function updateSettingsTransaction(input) {
  const previous = await loadSettings();
  const settings = mergeSettingsUpdate(previous, input);
  await validateConfiguredAudioAssets(settings);

  const playback = await loadPlaybackState();
  const activeSlot = activePlaybackProcess?.slot || null;
  if (activeSlot && playback.mode === "performance") {
    throw new Error("Stop playback or leave Performance Mode before changing audio settings.");
  }

  const resumeAtSeconds = activeSlot ? computedPlaybackTimeSeconds(playback) : 0;
  const resumePaused = activeSlot && playback.transport === "paused";
  const restartRequired = activeSlot && settingsRequireJuceRestart(previous, settings);
  let liveUpdateApplied = false;
  await saveSettings(settings);

  try {
    if (activeSlot && restartRequired) {
      await stopNativePlayback({ fade: true, durationMs: 120 });
      const prepared = await ensureEditPlaybackManifest(activeSlot);
      if (!prepared.ok) throw new Error(prepared.error || "Could not rebuild the JUCE playback manifest.");
      const restarted = await startNativeSlotPlayback(activeSlot, { startSeconds: resumeAtSeconds });
      if (!restarted.ok) throw new Error(restarted.error || "JUCE rejected the updated audio settings.");
      if (resumePaused) await sendNativePlaybackCommand("pause");
      await savePlaybackState({
        ...playback,
        transport: resumePaused ? "paused" : "playing",
        currentTimeSeconds: resumeAtSeconds,
        transportAnchorSeconds: resumeAtSeconds,
        transportStartedAt: resumePaused ? "" : new Date().toISOString(),
        lastMessage: "Audio settings applied and JUCE reconfigured.",
        updatedAt: new Date().toISOString()
      });
    } else if (activeSlot) {
      const prepared = await ensureEditPlaybackManifest(activeSlot);
      if (!prepared.ok) throw new Error(prepared.error || "Could not rebuild the JUCE playback manifest.");
      const song = prepared.manifest?.songs?.find((item) => Number(item.slot) === Number(activeSlot));
      if (!song) throw new Error("The active slot is missing from the updated JUCE manifest.");
      const mixerUpdate = await requestNativePlaybackCommand("updateMixer", {
        stems: song.stems || []
      }, { timeoutMs: 2500 });
      if (!mixerUpdate.ok) throw new Error(mixerUpdate.error || "JUCE rejected the updated stem routing.");
      const dynamicUpdate = await requestNativePlaybackCommand("updateDynamicMixer", {
        dynamicClick: song.dynamicClick || null,
        dynamicCue: song.dynamicCue || null,
        dynamicPad: song.dynamicPad || null
      }, { timeoutMs: 2500 });
      if (!dynamicUpdate.ok) throw new Error(dynamicUpdate.error || "JUCE rejected the updated dynamic routing.");
      liveUpdateApplied = true;
    } else {
      await refreshEngineManifestForMixer();
      const readiness = await probeEngineReadiness(settings, ENGINE_MANIFEST_FILE);
      if (!["ready", "device-missing"].includes(readiness.state)) {
        throw new Error(readiness.message || "JUCE rejected the updated audio settings.");
      }
    }
  } catch (error) {
    await saveSettings(previous);
    if (activeSlot) {
      await ensureEditPlaybackManifest(activeSlot);
      const rollback = await startNativeSlotPlayback(activeSlot, { startSeconds: resumeAtSeconds });
      if (rollback.ok) {
        if (resumePaused) await sendNativePlaybackCommand("pause");
        await savePlaybackState({
          ...playback,
          transport: resumePaused ? "paused" : "playing",
          currentTimeSeconds: resumeAtSeconds,
          transportAnchorSeconds: resumeAtSeconds,
          transportStartedAt: resumePaused ? "" : new Date().toISOString(),
          lastMessage: "Previous audio settings restored.",
          updatedAt: new Date().toISOString()
        });
      }
    } else {
      await refreshEngineManifestForMixer();
      await probeEngineReadiness(previous, ENGINE_MANIFEST_FILE);
    }
    throw new Error(`Settings were not applied; the previous configuration was restored. ${error.message}`);
  }

  return {
    ...settings,
    runtimeUpdate: {
      applied: true,
      juceReconfigured: Boolean(activeSlot),
      mode: restartRequired ? "restart-and-resume" : (liveUpdateApplied ? "live" : "readiness-probe"),
      resumedAtSeconds: restartRequired ? resumeAtSeconds : null
    }
  };
}

function settingsRequireJuceRestart(previous, next) {
  if (!sameText(previous.audioEngine.selectedDeviceName, next.audioEngine.selectedDeviceName)) return true;
  if (Number(previous.audioEngine.sampleRate) !== Number(next.audioEngine.sampleRate)) return true;
  if (!sameText(previous.dynamicClick.clickSoundPath, next.dynamicClick.clickSoundPath)) return true;
  if (!sameText(previous.dynamicClick.accentSoundPath, next.dynamicClick.accentSoundPath)) return true;
  if (!sameText(previous.dynamicCue.folderPath, next.dynamicCue.folderPath)) return true;
  if (!sameText(previous.pads.folderPath, next.pads.folderPath)) return true;
  return requiredOutputsForSettings(next) > requiredOutputsForSettings(previous);
}

function mergeSettingsUpdate(current, input = {}) {
  input = input || {};
  const merged = {
    ...current,
    ...input,
    library: { ...current.library, ...(input.library || {}) },
    audioEngine: { ...current.audioEngine, ...(input.audioEngine || {}) },
    routing: input.routing ? { ...current.routing, ...input.routing } : current.routing,
    dynamicCue: { ...current.dynamicCue, ...(input.dynamicCue || {}) },
    pads: { ...current.pads, ...(input.pads || {}) },
    dynamicClick: { ...current.dynamicClick, ...(input.dynamicClick || {}) }
  };

  merged.library.rootPath = configuredPath(input.library?.rootPath, current.library.rootPath);
  merged.audioEngine.selectedDeviceId = configuredPath(input.audioEngine?.selectedDeviceId, current.audioEngine.selectedDeviceId);
  merged.audioEngine.selectedDeviceName = configuredPath(input.audioEngine?.selectedDeviceName, current.audioEngine.selectedDeviceName);
  merged.dynamicCue.folderPath = configuredPath(input.dynamicCue?.folderPath, current.dynamicCue.folderPath);
  merged.pads.folderPath = configuredPath(input.pads?.folderPath, current.pads.folderPath);
  merged.dynamicClick.soundFolderPath = configuredPath(input.dynamicClick?.soundFolderPath, current.dynamicClick.soundFolderPath);
  merged.dynamicClick.clickSoundPath = configuredPath(input.dynamicClick?.clickSoundPath, current.dynamicClick.clickSoundPath);
  merged.dynamicClick.accentSoundPath = configuredPath(input.dynamicClick?.accentSoundPath, current.dynamicClick.accentSoundPath);
  return normalizeSettings(merged);
}

function configuredPath(nextValue, currentValue) {
  const next = stringValue(nextValue);
  return next || stringValue(currentValue);
}

async function validateConfiguredAudioAssets(settings) {
  const files = [
    ["Normal click WAV", settings.dynamicClick.clickSoundPath],
    ["Accent click WAV", settings.dynamicClick.accentSoundPath]
  ];
  const folders = [
    ["Dynamic cue folder", settings.dynamicCue.folderPath],
    ["Pad folder", settings.pads.folderPath]
  ];
  for (const [label, filePath] of files) {
    if (!filePath) continue;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`${label} is missing: ${filePath}`);
  }
  for (const [label, folderPath] of folders) {
    if (!folderPath) continue;
    const info = await stat(folderPath).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`${label} is missing: ${folderPath}`);
  }
}

function normalizeSettings(value = {}) {
  value = value || {};
  const selectedDeviceName = stringValue(value.audioEngine?.selectedDeviceName);
  const activeRoutingPresetId = stringValue(value.routing?.activePresetId || (isDanteDeviceName(selectedDeviceName) ? "dante-32" : "tracks-click-cue"));
  return {
    library: {
      rootPath: stringValue(value.library?.rootPath || ROOT)
    },
    audioEngine: {
      helper: ENGINE_HELPER,
      target: "cross-platform",
      selectedDeviceId: stringValue(value.audioEngine?.selectedDeviceId),
      selectedDeviceName,
      missingDevicePolicy: "warn-and-wait",
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      sampleRate: [44100, 48000].includes(Number(value.audioEngine?.sampleRate)) ? Number(value.audioEngine.sampleRate) : 48000
    },
    routing: {
      activePresetId: activeRoutingPresetId,
      presets: normalizeRoutingPresets(value.routing?.presets)
    },
    dynamicCue: {
      folderPath: stringValue(value.dynamicCue?.folderPath),
      outputBus: "dynamic-cue"
    },
    pads: {
      folderPath: stringValue(value.pads?.folderPath || APP_PADS_DIR),
      outputBus: "pads",
      defaultEnabled: value.pads?.defaultEnabled !== false,
      startWithSong: value.pads?.startWithSong !== false,
      continueBetweenSongs: value.pads?.continueBetweenSongs !== false,
      defaultVolume: clampNumber(value.pads?.defaultVolume, 0, 1, 0.65),
      fadeInMs: Math.max(0, Number(value.pads?.fadeInMs) || 1500),
      fadeOutMs: Math.max(0, Number(value.pads?.fadeOutMs) || 2500)
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

function isDanteDeviceName(value) {
  return /dante/i.test(stringValue(value));
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
    setMetadataDir: SET_METADATA_DIR,
    remoteUrls: remoteAccessUrls()
  };
}

function remoteAccessUrls() {
  const urls = [`http://127.0.0.1:${PORT}/remote`];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      urls.push(`http://${address.address}:${PORT}/remote`);
    }
  }
  return [...new Set(urls)];
}

async function loadAudioDevices() {
  const settings = await loadSettings();
  let selectedName = settings.audioEngine.selectedDeviceName;
  const helper = await runEngineCommand({ type: "listDevices", requestId: "list-devices" });
  const juceDevices = Array.isArray(helper.response?.devices)
    ? helper.response.devices.map((device) => ({
      id: stringValue(device.id),
      name: stringValue(device.name),
      driver: stringValue(device.type),
      channels: positiveNumber(device.channelCount),
      available: device.available !== false,
      isDefault: Boolean(device.isDefault),
      source: "juce-helper"
    }))
    : [];
  const devices = mergeAudioDevices(juceDevices, await listRegistryAsioDevices());
  let selectedDevice = selectEngineDevice(devices, selectedName);
  if (!selectedName && devices.length) {
    selectedDevice = chooseDefaultAudioDevice(devices);
    selectedName = selectedDevice?.id || selectedDevice?.name || "";
    if (selectedName) {
      await saveSettings({
        ...settings,
        audioEngine: {
          ...settings.audioEngine,
          selectedDeviceId: selectedDevice.id || selectedName,
          selectedDeviceName: selectedName
        }
      });
    }
  }
  const selectedMissing = Boolean(selectedName && devices.length && !selectedDevice);
  return {
    source: helper.ok ? "juce-helper" : "juce-helper-unavailable",
    selectedDeviceName: selectedName,
    selectedDevice: selectedDevice || null,
    selectedMissing,
    helperPath: helper.helperPath,
    error: helper.ok ? "" : helper.error,
    devices: devices.map((device) => ({
      ...device,
      selected: selectedDevice ? device.id === selectedDevice.id : false
    }))
  };
}

async function audioDeviceDiagnostics() {
  const settings = await loadSettings();
  const helper = await runEngineCommand({ type: "listDevices", requestId: "diagnostic-list-devices" }, { timeoutMs: 10000 });
  const asioRegistry = await listRegistryAsioDevices();
  const windowsSoundDevices = await listWindowsSoundDevices();
  const merged = await loadAudioDevices();
  const outputSignals = await liveOutputSignalDiagnostics();
  const danteMatches = [
    ...(merged.devices || []),
    ...asioRegistry,
    ...windowsSoundDevices
  ].filter((device) => /dante/i.test(`${device.id || ""} ${device.name || ""} ${device.driver || ""} ${device.description || ""}`));

  return {
    generatedAt: new Date().toISOString(),
    selectedDeviceName: settings.audioEngine?.selectedDeviceName || "",
    helper: {
      ok: helper.ok,
      helperPath: helper.helperPath,
      error: helper.error || "",
      exitCode: helper.exitCode ?? null,
      signal: helper.signal || "",
      stdout: helper.stdout || "",
      stderr: helper.stderr || "",
      rawResponseType: helper.response?.type || "",
      rawDeviceCount: Array.isArray(helper.response?.devices) ? helper.response.devices.length : 0,
      rawDevices: Array.isArray(helper.response?.devices) ? helper.response.devices : []
    },
    mergedDeviceCount: merged.devices?.length || 0,
    mergedDevices: merged.devices || [],
    asioRegistryCount: asioRegistry.length,
    asioRegistry,
    windowsSoundDeviceCount: windowsSoundDevices.length,
    windowsSoundDevices,
    outputSignals,
    danteMatches,
    conclusion: diagnosticConclusion({ helper, merged, asioRegistry, windowsSoundDevices, danteMatches })
  };
}

async function liveOutputSignalDiagnostics() {
  const meters = await playbackMeterSnapshot();
  const manifest = await readJsonFile(ENGINE_MANIFEST_FILE, null);
  const song = manifest?.songs?.find((item) => Number(item.slot) === Number(meters.slot)) || null;
  if (!meters.active || !song) {
    return {
      active: false,
      slot: null,
      measurementPoint: "JUCE source meters before ASIO output summing",
      outputs: []
    };
  }

  const routes = new Map();
  for (const stem of song.stems || []) {
    routes.set(stringValue(stem.id), Array.isArray(stem.routing?.outputChannels) ? stem.routing.outputChannels : []);
  }
  routes.set("dynamic-click", Array.isArray(song.dynamicClick?.routing?.outputChannels) ? song.dynamicClick.routing.outputChannels : []);
  routes.set("dynamic-cue", Array.isArray(song.dynamicCue?.routing?.outputChannels) ? song.dynamicCue.routing.outputChannels : []);
  routes.set("dynamic-pad", Array.isArray(song.dynamicPad?.routing?.outputChannels) ? song.dynamicPad.routing.outputChannels : []);

  const outputs = new Map();
  for (const meter of meters.stems || []) {
    for (const channel of routes.get(stringValue(meter.id)) || []) {
      const output = outputs.get(channel) || { channel, peak: 0, sources: [] };
      output.peak = Math.max(output.peak, clampNumber(meter.level, 0, 1, 0));
      output.sources.push({
        id: stringValue(meter.id),
        name: stringValue(meter.name),
        level: clampNumber(meter.level, 0, 1, 0)
      });
      outputs.set(channel, output);
    }
  }

  return {
    active: true,
    slot: meters.slot,
    title: meters.title,
    measurementPoint: "JUCE source meters before ASIO output summing",
    outputs: [...outputs.values()].sort((a, b) => a.channel - b.channel)
  };
}

function diagnosticConclusion({ helper, merged, asioRegistry, windowsSoundDevices, danteMatches }) {
  if (danteMatches.length) return "Dante-like device is visible to the app. Select it in Settings and save.";
  if (asioRegistry.length) return "ASIO drivers are registered, but none contain Dante in the name. Check Dante Virtual Soundcard installation/license/name.";
  if (windowsSoundDevices.length && !(merged.devices || []).length) return "Windows sees sound devices, but JUCE/native app discovery is empty.";
  if (!helper.ok) return `JUCE helper failed: ${helper.error || "unknown error"}`;
  if (!(merged.devices || []).length) return "No output devices were reported by JUCE, ASIO registry, or Windows sound-device scan.";
  return "Audio devices are visible, but no Dante-like device was found.";
}

function mergeAudioDevices(primaryDevices, secondaryDevices) {
  const devices = [];
  const seen = new Set();
  for (const device of [...primaryDevices, ...secondaryDevices]) {
    const key = `${stringValue(device.driver).toLowerCase()}:${stringValue(device.name).toLowerCase()}`;
    if (!stringValue(device.name) || seen.has(key)) continue;
    seen.add(key);
    devices.push(device);
  }
  return devices;
}

async function listRegistryAsioDevices() {
  const registryRoots = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\ASIO",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\ASIO"
  ];
  const devices = [];
  const seen = new Set();
  for (const root of registryRoots) {
    const keys = await queryRegistryKeys(root);
    for (const key of keys) {
      const name = basename(key);
      const detail = await queryRegistryValues(key);
      const deviceName = stringValue(detail.Description || name);
      const id = `ASIO:${deviceName}`;
      const dedupeKey = deviceName.toLowerCase();
      if (!deviceName || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      devices.push({
        id,
        name: deviceName,
        driver: "ASIO",
        channels: null,
        available: true,
        source: "asio-registry",
        registryName: name,
        clsid: stringValue(detail.CLSID)
      });
    }
  }
  return devices;
}

function queryRegistryKeys(root) {
  return new Promise((resolveKeys) => {
    execFile("reg.exe", ["query", root], { windowsHide: true }, (error, stdout) => {
      if (error) return resolveKeys([]);
      resolveKeys(stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.toUpperCase().startsWith(`${root}\\`.toUpperCase())));
    });
  });
}

function queryRegistryValues(key) {
  return new Promise((resolveValues) => {
    execFile("reg.exe", ["query", key], { windowsHide: true }, (error, stdout) => {
      if (error) return resolveValues({});
      const values = {};
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(.+?)\s+REG_\w+\s+(.+)$/);
        if (match) values[match[1].trim()] = match[2].trim();
      }
      resolveValues(values);
    });
  });
}

function listWindowsSoundDevices() {
  return new Promise((resolveDevices) => {
    const command = "Get-CimInstance Win32_SoundDevice | Select-Object Name,Manufacturer,Status,PNPDeviceID | ConvertTo-Json -Depth 3";
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) return resolveDevices([]);
      try {
        const parsed = JSON.parse(stdout.trim() || "[]");
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolveDevices(rows
          .filter((row) => stringValue(row?.Name))
          .map((row) => ({
            id: stringValue(row.PNPDeviceID || row.Name),
            name: stringValue(row.Name),
            driver: "Windows SoundDevice",
            manufacturer: stringValue(row.Manufacturer),
            status: stringValue(row.Status),
            available: stringValue(row.Status).toUpperCase() === "OK"
          })));
      } catch {
        resolveDevices([]);
      }
    });
  });
}

async function loadCurrentSetlist() {
  try {
    const raw = await readJsonFile(SETLIST_FILE, null);
    const normalized = normalizeSetlist(raw);
    if (JSON.stringify(raw?.transitions || []) !== JSON.stringify(normalized.transitions || [])) {
      await saveCurrentSetlist(normalized);
    }
    return normalized;
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
  value = value || {};
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
        stdout,
        stderr,
        exitCode: null,
        error: error.message
      });
    });

    child.on("close", (code, signal) => {
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
        stdout,
        stderr,
        exitCode: code,
        signal,
        error: response?.reason || stderr.trim() || (!response ? `JUCE helper returned no JSON response. Exit code: ${code ?? "unknown"}${signal ? `, signal: ${signal}` : ""}.` : "")
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
    timeSignature: slot.timeSignature || "",
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
  const cueTiming = cueTimingContextForReport(report);
  const entries = report.candidates.map((candidate) => {
    const phrase = candidate.normalizedPhrase || candidate.rawTranscript || candidate.label;
    const parts = matchDynamicCuePhrase(phrase, available);
    const approved = ["trusted", "review"].includes(candidate.status);
    const trigger = sectionCuePositionFromReport(candidate, report, cueTiming);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      phrase,
      command: candidate.command,
      status: approved && parts.every((part) => part.filePath) ? "mapped" : approved ? "missing-dynamic-cue-files" : "not-approved",
      triggerMeasure: trigger.bar,
      triggerBeat: trigger.beat,
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
    .map((candidate, index) => cueMarkerFromAnalysisCandidate(candidate, report, index))
    .filter((cue) => cue.name && cue.bar > 0 && cue.beat > 0);
  await writeFile(cueMarkerPath, `${JSON.stringify({
    ...current,
    dynamicCueMatching: current.dynamicCueMatching || "fuzzy-name",
    cueMarkers,
    updatedAt: new Date().toISOString(),
    source: "dynamic-cue-analysis",
    sourceFingerprint: cueMarkerDefaultsFingerprint(report)
  }, null, 2)}\n`, "utf8");
  return { created: cueMarkers.length };
}

function buildDefaultRegionsFromReport(report) {
  const analyzerRegions = analyzerRegionsFromReport(report);
  if (analyzerRegions.regions.length) {
    return analyzerRegions;
  }

  const regionCandidates = (report.regionCandidates || [])
    .filter((candidate) => candidate.status === "verified" && candidate.startMeasure && candidate.startBeat)
    .sort((a, b) => (a.startMeasure - b.startMeasure) || (a.startBeat - b.startBeat));
  if (regionCandidates.length) {
    const endMeasure = positiveNumber(report.gridReference?.measureCount);
    const regions = regionCandidates.map((candidate, index) => {
      const next = regionCandidates[index + 1];
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
      sourceFingerprint: stringValue(report.sourceFingerprint),
      updatedAt: new Date().toISOString()
    };
  }

  const timing = cueTimingContextForReport(report);
  const candidates = (report.candidates || [])
    .filter((candidate) => ["trusted", "review", "verified"].includes(stringValue(candidate.status)))
    .map((candidate, index) => {
      const cue = cueMarkerFromAnalysisCandidate(candidate, report, index);
      const start = shiftBarBeatByBeats(cue.bar, cue.beat, timing.sectionCueLeadBeats, timing.beatsPerMeasure);
      return { candidate, cue, start, index };
    })
    .filter((entry) => entry.cue.name && entry.start.bar > 0 && entry.start.beat > 0)
    .sort((a, b) => (a.start.bar - b.start.bar) || (a.start.beat - b.start.beat));
  const endMeasure = positiveNumber(report.gridReference?.measureCount);
  const regions = candidates.map((entry, index) => {
    const next = candidates[index + 1];
    const candidateId = entry.candidate.id || entry.index + 1;
    return {
      id: `region-${candidateId}`,
      name: entry.cue.name,
      startBar: entry.start.bar,
      startBeat: entry.start.beat,
      endBar: next?.start.bar || endMeasure || entry.start.bar + 1,
      endBeat: next?.start.beat || 1,
      sourceCueId: `cue-${candidateId}`,
      source: "derived-from-cue-lead-rule",
      cueLeadBeats: timing.sectionCueLeadBeats
    };
  }).filter((region) => region.endBar > region.startBar || (region.endBar === region.startBar && region.endBeat > region.startBeat));
  return {
    regions,
    source: regions.length ? "derived-from-cue-lead-rule" : "empty-default",
    sourceFingerprint: stringValue(report.sourceFingerprint),
    updatedAt: new Date().toISOString()
  };
}

function analyzerRegionsFromReport(report) {
  const sourceRegions = Array.isArray(report?.inferredRegions?.regions) ? report.inferredRegions.regions : [];
  const regions = sourceRegions.map((region, index) => ({
    id: stringValue(region.id || `region-${region.sourceCueId || index + 1}`),
    name: stringValue(region.name || region.label || `Region ${index + 1}`),
    startBar: positiveNumber(region.startMeasure || region.startBar) || 1,
    startBeat: positiveNumber(region.startBeat) || 1,
    endBar: positiveNumber(region.endMeasure || region.endBar) || positiveNumber(region.startMeasure || region.startBar) || 1,
    endBeat: positiveNumber(region.endBeat) || 1,
    sourceCueId: stringValue(region.sourceCueId || region.sourceCueCandidateId || ""),
    source: "analyzer-cue-intelligence-inferred-regions"
  })).filter((region) => region.endBar > region.startBar || (region.endBar === region.startBar && region.endBeat > region.startBeat));
  return {
    regions,
    source: regions.length ? "analyzer-cue-intelligence-inferred-regions" : "empty-default",
    regionSource: regions.length ? "inferred-from-cues" : "",
    sourceFingerprint: stringValue(report?.sourceFingerprint),
    updatedAt: new Date().toISOString()
  };
}

function analyzerDefaultNeedsRefresh(current, sourceFingerprint) {
  if (!sourceFingerprint || !current || typeof current !== "object") return false;
  if (metadataMapIsOperatorApproved(current)) return false;
  const analyzerSources = new Set([
    "",
    "empty-default",
    "dynamic-cue-analysis",
    "derived-from-analyzer-region-candidates",
    "derived-from-cue-lead-rule",
    "analyzer-cue-phrase-marker-refresh",
    "analyzer-cue-intelligence",
    "analyzer-cue-intelligence-inferred-regions",
    "editor-autosave"
  ]);
  if (!analyzerSources.has(stringValue(current.source))) return false;
  return stringValue(current.sourceFingerprint) !== sourceFingerprint;
}

function metadataMapIsOperatorApproved(current) {
  const status = stringValue(current?.status || current?.approvalStatus);
  return Boolean(
    current?.approved === true
    || current?.operatorApproved === true
    || current?.locked === true
    || status === "approved"
    || stringValue(current?.source) === "operator-approved"
  );
}

function metadataMapIsOperatorWorkingDraft(current) {
  return Boolean(
    current && typeof current === "object"
    && stringValue(current.source) === "operator-working-draft"
  );
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
  if (options.reuseActive === true && activePlaybackProcess) {
    const settings = await loadSettings();
    const device = await resolveEngineDevice(settings.audioEngine.selectedDeviceName);
    const nativePlayback = await requestNativePlaybackCommand("playSlot", {
      manifestPath: ENGINE_MANIFEST_FILE,
      slot,
      deviceName: device.name,
      deviceType: device.driver,
      sampleRate: settings.audioEngine?.sampleRate || 48000,
      startSeconds: nonNegativeNumber(options.startSeconds) ?? 0
    }, { timeoutMs: 10000 });
    if (!nativePlayback.ok || nativePlayback.response?.type !== "playbackStarted") {
      return { ok: false, error: nativePlayback.error || nativePlayback.response?.reason || "JUCE playback failed to start." };
    }
    activePlaybackProcess.slot = slot;
    activePlaybackProcess.outputChannels = positiveNumber(nativePlayback.response.outputChannels);
    activePlaybackProcess.requestedOutputChannels = positiveNumber(nativePlayback.response.requestedOutputChannels);
    latestPlaybackMeters = {
      active: true,
      slot,
      title: stringValue(nativePlayback.response.title),
      currentTimeSeconds: nonNegativeNumber(nativePlayback.response.currentPositionSeconds) ?? nonNegativeNumber(options.startSeconds) ?? 0,
      stems: [],
      updatedAt: new Date().toISOString()
    };
    broadcastMeterSnapshot();
    await saveEngineStatus(normalizeEngineStatus({
      state: "ready",
      simulated: false,
      selectedDeviceName: stringValue(nativePlayback.response.deviceName || device.name),
      deviceType: stringValue(nativePlayback.response.deviceType || device.driver),
      requestedOutputChannels: positiveNumber(nativePlayback.response.requestedOutputChannels),
      outputChannels: positiveNumber(nativePlayback.response.outputChannels),
      sampleRate: positiveNumber(nativePlayback.response.sampleRate),
      bufferSize: positiveNumber(nativePlayback.response.bufferSize),
      manifestPath: ENGINE_MANIFEST_FILE,
      message: `JUCE ready on ${nativePlayback.response.deviceName || device.name}.`,
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    return { ok: true, response: nativePlayback.response };
  }

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
    let stdoutBuffer = "";
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
      const text = chunk.toString();
      stdout = `${stdout}${text}`.slice(-1_000_000);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.requestId !== requestId) {
            handleNativePlaybackResponse(response);
            continue;
          }
          if (response.type === "playbackStarted") {
            activePlaybackProcess = {
              child,
              slot,
              stdout,
              stderr,
              pending: new Map(),
              outputChannels: positiveNumber(response.outputChannels),
              requestedOutputChannels: positiveNumber(response.requestedOutputChannels)
            };
            latestPlaybackMeters = {
              active: true,
              slot,
              title: stringValue(response.title),
              currentTimeSeconds: nonNegativeNumber(response.currentPositionSeconds) ?? nonNegativeNumber(options.startSeconds) ?? 0,
              stems: [],
              updatedAt: new Date().toISOString()
            };
            broadcastMeterSnapshot();
            saveEngineStatus(normalizeEngineStatus({
              state: "ready",
              simulated: false,
              selectedDeviceName: stringValue(response.deviceName || device.name),
              deviceType: stringValue(response.deviceType || device.driver),
              requestedOutputChannels: positiveNumber(response.requestedOutputChannels),
              outputChannels: positiveNumber(response.outputChannels),
              sampleRate: positiveNumber(response.sampleRate),
              bufferSize: positiveNumber(response.bufferSize),
              manifestPath: ENGINE_MANIFEST_FILE,
              message: `JUCE ready on ${response.deviceName || device.name}.`,
              lastHeartbeatAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }))
              .catch(() => {})
              .finally(() => finish({ ok: true, response }));
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

    child.stdin.on("error", (error) => {
      stderr += `\nstdin error: ${error.message}`;
      if (activePlaybackProcess?.child === child) activePlaybackProcess = null;
      finish({ ok: false, error: error.message });
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
      sampleRate: settings.audioEngine?.sampleRate || 48000,
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

  try {
    child.stdin.write(`${JSON.stringify({
      type,
      requestId: `${type}-${Date.now()}`,
      ...body
    })}\n`);
  } catch (error) {
    activePlaybackProcess = null;
    return { ok: false, active: false, error: error.message };
  }

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
    try {
      child.stdin.write(`${JSON.stringify({ type, requestId, ...body })}\n`);
    } catch (error) {
      pending?.delete(requestId);
      clearTimeout(timeout);
      activePlaybackProcess = null;
      resolveRequest({ ok: false, active: false, error: error.message });
    }
  });
}

function handleNativePlaybackResponse(response) {
  if (!response || typeof response !== "object") return;
  if (response.type === "meterUpdate") {
    latestPlaybackMeters = {
      active: Boolean(response.nativeAudioActive),
      slot: positiveNumber(response.slot),
      title: stringValue(response.title),
      currentTimeSeconds: nonNegativeNumber(response.currentPositionSeconds),
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
    name: match?.driver === "ASIO" && match?.registryName ? match.registryName : match?.name || selectedDeviceName,
    label: match?.name || selectedDeviceName,
    driver: match?.driver || "",
    id: match?.id || selectedDeviceName,
    source: match?.source || "",
    channels: positiveNumber(match?.channels),
    isDefault: Boolean(match?.isDefault)
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

function chooseDefaultAudioDevice(devices) {
  return [...devices]
    .filter((device) => stringValue(device.name))
    .sort((a, b) => audioDevicePreferenceScore(b) - audioDevicePreferenceScore(a))[0] || null;
}

function audioDevicePreferenceScore(device) {
  const id = stringValue(device.id).toLowerCase();
  const name = stringValue(device.name).toLowerCase();
  const driver = stringValue(device.driver);
  const haystack = `${id} ${name}`;
  let score = 0;
  if (haystack.includes("dante")) score += 1000;
  if (driver === "ASIO") score += 800;
  if (driver.includes("Low Latency")) score += 500;
  if (driver === "Windows Audio") score += 300;
  if (driver.includes("Exclusive")) score += 200;
  if (driver === "DirectSound") score += 50;
  if (haystack.includes("primary sound driver")) score -= 100;
  if (haystack.includes("steam")) score -= 200;
  return score;
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
  const requiredOutputChannels = requiredOutputsForSettings(settings);
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
  if (device.driver === "WaveOut") {
    const status = normalizeEngineStatus({
      state: "ready",
      simulated: false,
      selectedDeviceName: device.id || selectedDeviceName,
      deviceType: "WaveOut",
      requestedOutputChannels: requiredOutputChannels,
      outputChannels: device.channels || 2,
      sampleRate: settings.audioEngine?.sampleRate || 48000,
      bufferSize: 512,
      manifestPath,
      message: `Windows WaveOut detected on ${device.label || device.name || selectedDeviceName}. Use a JUCE Windows Audio or ASIO device for production playback.`,
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await saveEngineStatus(status);
    return status;
  }

  const probe = await runEngineCommand({
    type: "probeDevice",
    requestId: "engine-probe",
    deviceName: device.name || selectedDeviceName,
    deviceType: device.driver,
    requestedOutputChannels: requiredOutputChannels,
    sampleRate: settings.audioEngine?.sampleRate || 48000
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
  value = value || {};
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
    pad: normalizePadRuntime(value.pad),
    panic: normalizePanicRuntime(value.panic),
    transition: normalizeTransitionRuntime(value.transition),
    lastCommand: stringValue(value.lastCommand),
    commandStatus: stringValue(value.commandStatus),
    confirmed: Boolean(value.confirmed),
    confirmedFingerprint: stringValue(value.confirmedFingerprint),
    confirmedAt: stringValue(value.confirmedAt),
    lastMessage: stringValue(value.lastMessage),
    updatedAt: stringValue(value.updatedAt || new Date().toISOString())
  };
}

function normalizeTransitionRuntime(value = {}) {
  value = value || {};
  const mode = TRANSITION_MODES.has(value.mode) ? value.mode : "cue-next";
  const padBehavior = TRANSITION_PAD_BEHAVIORS.has(value.padBehavior) ? value.padBehavior : "next-song-key";
  const status = ["idle", "waiting-next", "active", "completed", "blocked"].includes(value.status) ? value.status : "idle";
  return {
    active: Boolean(value.active),
    fromSlot: positiveNumber(value.fromSlot),
    toSlot: positiveNumber(value.toSlot),
    mode,
    padBehavior,
    startedAt: value.startedAt === null ? null : stringValue(value.startedAt),
    durationSeconds: positiveNumber(value.durationSeconds) || 5,
    status,
    message: stringValue(value.message)
  };
}

function normalizePadRuntime(value = {}) {
  value = value || {};
  return {
    active: Boolean(value.active),
    slot: positiveNumber(value.slot),
    songId: stringValue(value.songId),
    padKey: stringValue(value.padKey),
    source: stringValue(value.source || "operator"),
    updatedAt: stringValue(value.updatedAt)
  };
}

function normalizePanicRuntime(value = {}) {
  value = value || {};
  const state = value.state === PANIC_STATES.PANIC_HOLD ? PANIC_STATES.PANIC_HOLD : PANIC_STATES.NORMAL;
  return {
    state,
    active: state !== PANIC_STATES.NORMAL && value.active !== false,
    label: state === PANIC_STATES.PANIC_HOLD ? stringValue(value.label || "Panic Active") : "",
    detail: state === PANIC_STATES.PANIC_HOLD ? stringValue(value.detail || "Tracks Down / Click Alive") : "",
    startedAt: stringValue(value.startedAt),
    slot: positiveNumber(value.slot),
    songId: stringValue(value.songId),
    heldPadKey: stringValue(value.heldPadKey),
    tracksMuted: Boolean(state === PANIC_STATES.PANIC_HOLD && value.tracksMuted !== false),
    clickMuted: Boolean(value.clickMuted),
    cueMuted: false,
    recoveryTarget: value.recoveryTarget || null,
    trackTargetDb: state === PANIC_STATES.PANIC_HOLD ? PANIC_TRACK_TARGET_DB : 0,
    source: stringValue(value.source),
    updatedAt: stringValue(value.updatedAt)
  };
}

function normalizeLiveRepeat(value = {}) {
  value = value || {};
  const mode = ["once", "loop"].includes(value.mode) ? value.mode : "";
  return {
    mode,
    regionId: mode ? stringValue(value.regionId) : "",
    regionName: mode ? stringValue(value.regionName) : "",
    queued: Boolean(mode && value.queued !== false),
    releaseRequested: Boolean(mode === "loop" && value.releaseRequested),
    releaseAfterNextPass: Boolean(mode === "loop" && value.releaseAfterNextPass),
    cueFired: Boolean(mode && value.cueFired),
    actionInFlight: Boolean(mode && value.actionInFlight),
    repeatCuePlan: mode ? normalizeRepeatCuePlan(value.repeatCuePlan) : null
  };
}

function normalizeRepeatCuePlan(value = {}) {
  if (!value || typeof value !== "object") return null;
  const triggerSeconds = nonNegativeNumber(value.triggerSeconds);
  const startSeconds = nonNegativeNumber(value.startSeconds);
  const endSeconds = nonNegativeNumber(value.endSeconds);
  if (triggerSeconds === null || startSeconds === null || endSeconds === null) return null;
  return {
    triggerSeconds,
    startSeconds,
    endSeconds,
    repeatedCueDelayMs: Math.max(0, Math.min(3000, Number(value.repeatedCueDelayMs || 0))),
    suppressCueStartSeconds: nonNegativeNumber(value.suppressCueStartSeconds),
    suppressCueEndSeconds: nonNegativeNumber(value.suppressCueEndSeconds),
    generatedAt: stringValue(value.generatedAt)
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

function openPlaybackStateStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  let closed = false;
  let inFlight = false;
  const send = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const snapshot = await playbackStateSnapshot();
      res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    } finally {
      inFlight = false;
    }
  };
  send();
  const timer = setInterval(send, 200);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

function startLiveSupervisor() {
  setInterval(() => {
    serviceLiveSupervisor().catch((error) => {
      const message = error?.message || String(error);
      if (message !== liveSupervisorLastError) {
        liveSupervisorLastError = message;
        console.error(`Live supervisor failed: ${message}`);
      }
    });
  }, 50);
}

async function serviceLiveSupervisor() {
  if (liveSupervisorInFlight) return;
  liveSupervisorInFlight = true;
  try {
    await playbackCommandQueue;
    liveSupervisorLastTickAt = new Date().toISOString();
    const state = await loadPlaybackState();
    if (state.transport !== "playing" || !state.currentSlot) return;
    if (!activePlaybackProcess) {
      await savePlaybackState(normalizePlaybackState({
        ...state,
        transport: "stopped",
        currentTimeSeconds: computedPlaybackTimeSeconds(state),
        transportAnchorSeconds: computedPlaybackTimeSeconds(state),
        transportStartedAt: "",
        liveRepeat: {},
        panic: {},
        lastCommand: "engine-lost",
        commandStatus: "stopped",
        lastMessage: "Playback engine stopped unexpectedly. Restart playback from the selected song.",
        updatedAt: new Date().toISOString()
      }));
      markLiveSupervisorAction("engine-lost-stop");
      return;
    }

    if (await servicePanicRecoveryBackend(state)) return;
    if (await serviceLiveRepeatBackend(state)) return;
    await serviceSongEndBackend(state);
  } finally {
    liveSupervisorInFlight = false;
  }
}

async function servicePanicRecoveryBackend(state) {
  const pending = state.panic?.recoveryTarget;
  if (state.panic?.active !== true || !pending?.pending) return false;
  const current = computedPlaybackTimeSeconds(state);
  const slot = positiveNumber(pending.slot || state.currentSlot);
  const cueSeconds = nonNegativeNumber(pending.cueSeconds);
  if (!pending.cueFired && cueSeconds !== null && current >= cueSeconds - 0.035) {
    markLiveSupervisorAction("panic-recovery-cue");
    const nextState = normalizePlaybackState({
      ...state,
      panic: normalizePanicRuntime({
        ...state.panic,
        recoveryTarget: {
          ...pending,
          cueFired: true
        }
      }),
      lastCommand: "triggerPanicRecoveryCue",
      commandStatus: "accepted",
      lastMessage: `Recovery cue reached for ${pending.regionName || "target region"}.`,
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(nextState);
    return true;
  }
  const executeSeconds = nonNegativeNumber(pending.executeSeconds ?? pending.targetSeconds);
  if (executeSeconds !== null && current >= executeSeconds - 0.035) {
    markLiveSupervisorAction("panic-release");
    await handlePlaybackCommand("exitPanic", {
      slot,
      targetSeconds: nonNegativeNumber(pending.targetSeconds ?? pending.seekSeconds) ?? 0,
      regionId: pending.regionId,
      regionName: pending.regionName,
      recoveryCueAlreadyTriggered: pending.cueFired === true,
      recoveryCueSkipped: pending.cueSkipped === true,
      systemAction: true
    });
    return true;
  }
  return false;
}

async function serviceLiveRepeatBackend(state) {
  const repeat = normalizeLiveRepeat(state.liveRepeat);
  const plan = repeat.repeatCuePlan || {};
  if (!["once", "loop"].includes(repeat.mode) || !plan || repeat.actionInFlight) return false;
  const current = computedPlaybackTimeSeconds(state);
  const triggerSeconds = nonNegativeNumber(plan.triggerSeconds);
  const startSeconds = nonNegativeNumber(plan.startSeconds);
  const endSeconds = nonNegativeNumber(plan.endSeconds);
  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds + 0.1) return false;

  if (!repeat.cueFired && !repeat.releaseRequested && triggerSeconds !== null && current >= triggerSeconds && current < endSeconds - 0.1) {
    markLiveSupervisorAction("repeat-cue");
    await handlePlaybackCommand("triggerRepeatCue", {
      slot: state.currentSlot,
      regionId: repeat.regionId,
      regionName: repeat.regionName,
      repeatedCueDelayMs: Number(plan.repeatedCueDelayMs || 0),
      suppressCueStartSeconds: plan.suppressCueStartSeconds,
      suppressCueEndSeconds: plan.suppressCueEndSeconds,
      systemAction: true
    });
    return true;
  }

  if (current < Math.max(startSeconds + 0.1, endSeconds) - 0.08) return false;
  if (repeat.mode === "loop" && repeat.releaseRequested) {
    markLiveSupervisorAction("repeat-clear-release");
    await handlePlaybackCommand("clearRegionRepeat", {
      slot: state.currentSlot,
      regionId: repeat.regionId,
      regionName: repeat.regionName,
      systemAction: true
    });
    return true;
  }
  if (repeat.mode === "loop" && repeat.releaseAfterNextPass) {
    markLiveSupervisorAction("repeat-loop-defer-release");
    await handlePlaybackCommand("seek", {
      slot: state.currentSlot,
      seconds: startSeconds,
      regionId: repeat.regionId,
      regionName: repeat.regionName,
      systemAction: true
    });
    await handlePlaybackCommand("goOnRegion", {
      slot: state.currentSlot,
      regionId: repeat.regionId,
      regionName: repeat.regionName,
      systemAction: true
    });
    return true;
  }
  markLiveSupervisorAction("repeat-seek");
  await handlePlaybackCommand("seek", {
    slot: state.currentSlot,
    seconds: startSeconds,
    regionId: repeat.regionId,
    regionName: repeat.regionName,
    systemAction: true
  });
  if (repeat.mode === "once") {
    markLiveSupervisorAction("repeat-once-clear");
    await handlePlaybackCommand("clearRegionRepeat", {
      slot: state.currentSlot,
      regionId: repeat.regionId,
      regionName: repeat.regionName,
      systemAction: true
    });
  }
  return true;
}

async function serviceSongEndBackend(state) {
  if (state.panic?.active === true) return false;
  const liveSong = await activeManifestSong(state.currentSlot);
  const duration = manifestSongDurationSeconds(liveSong);
  if (!duration) return false;
  const setlist = await loadCurrentSetlist();
  const transition = transitionForFromSlot(setlist, state.currentSlot);
  const current = computedPlaybackTimeSeconds(state);
  const lead = ["crossfade", "overlap"].includes(transition?.mode)
    ? Math.max(0.25, Number(transition.durationSeconds || 5))
    : 0.08;
  if (current < duration - lead) return false;
  if (state.mode === "performance" && transition) {
    markLiveSupervisorAction("song-transition");
    await handlePlaybackCommand("songTransition", {
      fromSlot: transition.fromSlot,
      toSlot: transition.toSlot,
      systemAction: true
    });
  } else {
    markLiveSupervisorAction("song-end-stop");
    await handlePlaybackCommand("stop", {
      slot: state.currentSlot,
      systemAction: true
    });
  }
  return true;
}

function markLiveSupervisorAction(action) {
  liveSupervisorLastAction = action;
  liveSupervisorLastActionAt = new Date().toISOString();
}

function manifestSongDurationSeconds(song) {
  if (!song) return 0;
  const explicit = nonNegativeNumber(song.durationSeconds) ?? (nonNegativeNumber(song.durationMs) !== null ? nonNegativeNumber(song.durationMs) / 1000 : null);
  if (explicit) return explicit;
  return Math.max(0, ...(Array.isArray(song.stems) ? song.stems : [])
    .map((stem) => nonNegativeNumber(stem.durationMs) !== null ? nonNegativeNumber(stem.durationMs) / 1000 : nonNegativeNumber(stem.durationSeconds) || 0));
}

function computedPlaybackTimeSeconds(state) {
  const meterTime = activeMeterPositionSeconds(state?.currentSlot);
  if (meterTime !== null) return meterTime;
  const anchor = nonNegativeNumber(state.transportAnchorSeconds) ?? nonNegativeNumber(state.currentTimeSeconds) ?? 0;
  if (state.transport !== "playing" || !state.transportStartedAt) return anchor;
  const startedAt = Date.parse(state.transportStartedAt);
  if (!Number.isFinite(startedAt)) return anchor;
  return Math.max(0, anchor + ((Date.now() - startedAt) / 1000));
}

function activeMeterPositionSeconds(slotNumber) {
  if (!activePlaybackProcess || !latestPlaybackMeters.active) return null;
  if (positiveNumber(latestPlaybackMeters.slot) !== positiveNumber(slotNumber)) return null;
  const updatedAt = Date.parse(latestPlaybackMeters.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 500) return null;
  return nonNegativeNumber(latestPlaybackMeters.currentTimeSeconds);
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
  const heartbeatRequired = Boolean(activePlaybackProcess);
  const heartbeatFresh = engineStatus.state === "ready" && heartbeatRequired && effectiveHeartbeatAgeMs <= ENGINE_HEARTBEAT_GRACE_MS;
  const engine = {
    ...engineStatus,
    heartbeatRequired,
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
  } else if (settings.audioEngine?.selectedDeviceName && heartbeatRequired && !heartbeatFresh) {
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
  const readiness = playback.readiness || {};

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SONG_METADATA_DIR, { recursive: true });
  await checkDirectory(libraryRoot, "Library scan folder", errors);
  await checkDirectory(DATA_DIR, "App data folder", errors);
  await checkDirectory(SONG_METADATA_DIR, "Song metadata folder", errors);
  const padReadiness = await padFolderReadiness(settings.pads?.folderPath, filledSlots);
  errors.push(...padReadiness.errors);
  warnings.push(...padReadiness.warnings);

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
    if (slot.folderPath) {
      const currentFingerprint = await sourceMetadataFingerprintForSongFolder(slot.folderPath);
      const importedFingerprint = stringValue(slot.metadataVersionInfo?.fingerprint);
      if (importedFingerprint && currentFingerprint && importedFingerprint !== currentFingerprint) {
        errors.push(`Slot ${slot.slot}: source metadata changed after import. Refresh Library before testing or performing this song.`);
      }
    }
  }
  if (filledSlots.length && metadata.slots.length !== filledSlots.length) {
    errors.push("Set metadata slot count does not match filled setlist slots.");
  }
  for (const blocker of readiness.performanceBlockers || []) {
    errors.push(blocker);
  }
  if (
    readiness.engine?.state === "ready"
    && positiveNumber(readiness.engine.sampleRate)
    && positiveNumber(settings.audioEngine?.sampleRate)
    && positiveNumber(readiness.engine.sampleRate) !== positiveNumber(settings.audioEngine.sampleRate)
  ) {
    errors.push(`JUCE sample rate ${readiness.engine.sampleRate} does not match Settings sample rate ${settings.audioEngine.sampleRate}.`);
  }
  for (const slotMetadata of metadata.slots || []) {
    const metadataFolder = stringValue(slotMetadata.metadataFolder);
    const regionsPath = stringValue(slotMetadata.files?.regions || (metadataFolder ? join(metadataFolder, "regions.json") : ""));
    const cuesPath = stringValue(slotMetadata.files?.cues || (metadataFolder ? join(metadataFolder, "cue-markers.json") : ""));
    const regions = regionsPath ? await readJsonFile(regionsPath, null) : null;
    const cues = cuesPath ? await readJsonFile(cuesPath, null) : null;
    if (regions?.sourceMetadataChangedUnderDraft) {
      warnings.push(`Slot ${slotMetadata.slot}: regions are an operator draft preserved over newer analyzer metadata. Approve, reload from analyzer, or clear the draft before judging analyzer timing.`);
    }
    if (cues?.sourceMetadataChangedUnderDraft) {
      warnings.push(`Slot ${slotMetadata.slot}: cue markers are an operator draft preserved over newer analyzer metadata. Approve, reload from analyzer, or clear the draft before judging dynamic cues.`);
    }
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
    if (manifest.exists) {
      const liveCueReadiness = await liveCommandCueReadiness(manifest.manifest, settings.dynamicCue?.folderPath);
      errors.push(...liveCueReadiness.errors);
      warnings.push(...liveCueReadiness.warnings);
    }
    for (const song of manifest.exists ? manifest.manifest?.songs || [] : []) {
      if (song.dynamicPad?.sourcePath && song.dynamicPad?.cacheStatus === "cache-failed") {
        errors.push(`Slot ${song.slot}: dynamic pad cache failed for ${song.tempoMap?.key || "song key"}. ${song.dynamicPad.cacheError || ""}`.trim());
      }
      const click = song.dynamicClick || {};
      if (click.status === "ready" && Number(click.clickEventCount || 0) === 0 && Number(click.patternLength || 0) < 16) {
        warnings.push(`Slot ${song.slot}: dynamic click is grid/pattern driven with only ${Number(click.patternLength || 0)} pattern beats. Analyzer should provide first-16/event click data for best click-stem match.`);
      }
      const missingCueCount = (Array.isArray(song.dynamicCues) ? song.dynamicCues : []).filter((cue) => cue.status !== "matched").length;
      if (missingCueCount) {
        warnings.push(`Slot ${song.slot}: ${missingCueCount} dynamic cue event(s) have no matching WAV in the dynamic cue folder.`);
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
    },
    liveSupervisor: {
      lastTickAt: liveSupervisorLastTickAt,
      inFlight: liveSupervisorInFlight,
      lastAction: liveSupervisorLastAction,
      lastActionAt: liveSupervisorLastActionAt,
      lastError: liveSupervisorLastError
    }
  };
}

async function liveCommandCueReadiness(manifest, folderPath) {
  const errors = [];
  const warnings = [];
  const folder = stringValue(folderPath);
  if (!folder) {
    errors.push("Dynamic cue folder is not configured. Repeat and Panic recovery cues cannot sound.");
    return { errors, warnings };
  }
  let entries = [];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    errors.push("Dynamic cue folder is unavailable. Repeat and Panic recovery cues cannot sound.");
    return { errors, warnings };
  }
  const wavs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({ name: entry.name, filePath: join(folder, entry.name), key: cueMatchKey(entry.name.replace(/\.wav$/i, "")) }));

  if (!findCueWav(wavs, "Repeat")) {
    errors.push("Repeat.wav is missing from the dynamic cue folder. Region repeat announcements cannot sound.");
  }
  if (!findCueWav(wavs, "In")) {
    warnings.push("In.wav is missing from the dynamic cue folder. Panic recovery will announce only the target region.");
  }

  for (const song of Array.isArray(manifest?.songs) ? manifest.songs : []) {
    const missingRegionNames = [...new Set((Array.isArray(song.regions) ? song.regions : [])
      .map((region) => stringValue(region.name))
      .filter(Boolean)
      .filter((name) => !liveRegionCueCommands(name, wavs).length))];
    if (missingRegionNames.length) {
      warnings.push(`Slot ${song.slot}: ${missingRegionNames.slice(0, 8).join(", ")} region cue WAV${missingRegionNames.length === 1 ? " is" : "s are"} missing for repeat/Panic recovery.${missingRegionNames.length > 8 ? ` ${missingRegionNames.length - 8} more.` : ""}`);
    }
  }

  return { errors, warnings };
}

async function padFolderReadiness(folderPath, filledSlots = []) {
  const errors = [];
  const warnings = [];
  const folder = stringValue(folderPath);
  if (!folder) {
    errors.push("Pad folder is not configured. Dynamic pads cannot sound.");
    return { errors, warnings };
  }
  let entries = [];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    errors.push("Pad folder is unavailable. Dynamic pads cannot sound.");
    return { errors, warnings };
  }
  const available = new Set(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => padFileMatchKey(entry.name.replace(/\.wav$/i, "")))
    .filter(Boolean));
  const missingKeys = KEY_OPTIONS
    .map((key) => padFileMatchKey(key))
    .filter((key) => !available.has(key));
  if (missingKeys.length) {
    warnings.push(`Pad folder is missing ${missingKeys.join(", ")} pad WAV${missingKeys.length === 1 ? "" : "s"}. Songs in those keys will not have dynamic pad.`);
  }
  for (const slot of filledSlots) {
    const key = padFileMatchKey(slot.padKey || slot.selectedKey || slot.key);
    if (key && !available.has(key)) {
      errors.push(`Slot ${slot.slot}: dynamic pad WAV for key ${slot.padKey || slot.selectedKey || slot.key} is missing.`);
    }
  }
  return { errors, warnings };
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
    const dynamicClickRouting = routeForStem(canonicalBus(dynamicClickMixer?.routeBus || "click"), 0, routingPreset);
    const dynamicCueRouting = routeForStem(canonicalBus(dynamicCueMixer?.routeBus || "dynamicCue"), 0, routingPreset);
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
      songKey: slotMetadata.padKey || slotMetadata.tempoMap.key || slot.key,
      mixer: dynamicPadMixer,
      routingPreset,
      settings: confirmedSet.settings.pads
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
        volume: dynamicClickRouting.outputChannels.length ? clampNumber(dynamicClickMixer?.volume, 0, 100, 80) : 0,
        solo: Boolean(dynamicClickMixer?.solo),
        routing: dynamicClickRouting
      },
      dynamicCue: {
        volume: dynamicCueRouting.outputChannels.length ? clampNumber(dynamicCueMixer?.volume, 0, 100, 80) : 0,
        solo: Boolean(dynamicCueMixer?.solo),
        routing: dynamicCueRouting
      },
      pad: dynamicPad.pad,
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
  const normalizedRegions = normalizeRegions(regions.regions || []);
  const normalizedCues = normalizeCueMarkers(cues.cueMarkers || []);
  const normalizedTempoMap = extendTempoMapForSongPositions(
    normalizeTempoMap(tempoMap, slot),
    songGridPositions(normalizedRegions, normalizedCues)
  );
  return {
    regions: normalizedRegions,
    cueMarkers: normalizedCues,
    tempoMap: normalizedTempoMap,
    padKey: stringValue(songMetadata?.padKey || songMetadata?.key || tempoMap.key || slot.key),
    mixer: normalizeMixer(mixer, slot),
    arrangement: normalizeArrangement(arrangement),
    dynamicClick: songMetadata?.dynamicClick || normalizeSongDynamicClick(null),
    dynamicCueMap,
    dynamicCues: await buildDynamicCueManifest(normalizedCues, settings.dynamicCue.folderPath, normalizedTempoMap)
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
    triggerTimeSeconds: timeForCueMarker(cue, tempoMap),
    status,
    filePath: match?.filePath || ""
  };
}

function dynamicCueSequenceEntries(cue, wavs, tempoMap) {
  const entries = [];
  const sectionCue = sectionOnlyCueMatch(cue, wavs);
  entries.push(dynamicCueManifestEntry({
    ...cue,
    name: sectionCue.name,
    triggerTimeSeconds: timeForCueMarker(cue, tempoMap)
  }, sectionCue.match, sectionCue.match ? "matched" : "missing", tempoMap));

  for (const countCue of countCueMarkersForSectionCue(cue, tempoMap)) {
    const match = findCueWav(wavs, countCue.name);
    entries.push(dynamicCueManifestEntry(countCue, match, match ? "matched" : "missing", tempoMap));
  }

  return entries;
}

function sectionCueInstruction(cueName) {
  const text = stringValue(cueName).trim();
  const match = text.match(/^(.+?)\s+([2-8]{1,7})$/);
  if (!match) return { sectionName: text, counts: null };
  const counts = [...match[2]]
    .map((value) => Number(value))
    .filter((value, index, values) => value >= 2 && value <= 8 && values.indexOf(value) === index);
  return {
    sectionName: match[1].trim() || text,
    counts: counts.length ? counts : null
  };
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

function sectionOnlyCueMatch(cue, wavs) {
  const exactMatch = findCueWav(wavs, cue.name);
  if (exactMatch) return { name: cue.name, match: exactMatch };
  const instruction = sectionCueInstruction(cue.name);
  if (!instruction.counts) return { name: cue.name, match: null };
  const baseName = instruction.sectionName;
  if (!baseName) return { name: cue.name, match: null };
  const baseMatch = findCueWav(wavs, baseName);
  return baseMatch ? { name: baseName, match: baseMatch } : { name: cue.name, match: null };
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
  const instruction = sectionCueInstruction(cue.name);
  const explicitCounts = Array.isArray(instruction.counts) ? instruction.counts : null;
  const counts = explicitCounts
    ? explicitCounts.map((beat) => ({ beat, name: cueNumberNameForSignature(beat, signature) }))
    : isSixEight
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
  const useSequentialOffsets = !explicitCounts && counts.some((count) => count.beat < (positiveNumber(cue.beat) || 1));

  return counts.map((count, index) => ({
    id: `${cue.id}-count-${count.beat}`,
    name: count.name,
    ...countCueGridPosition(cue, tempoMap, countCueOffsetFromCue(cue, count.beat, index, useSequentialOffsets))
  }));
}

function countCueOffsetFromCue(cue, countBeat, countIndex = 0, useSequentialOffsets = false) {
  if (useSequentialOffsets) return countIndex + 1;
  const cueBeat = positiveNumber(cue.beat) || 1;
  const beat = positiveNumber(countBeat) || 1;
  const sameMeasureOffset = beat - cueBeat;
  return sameMeasureOffset >= 0 ? sameMeasureOffset : beat - 1;
}

function cueNumberNameForSignature(number, signature) {
  const word = cueNumberWord(number);
  if (!word) return "";
  return stringValue(signature).startsWith("6/8") ? `${word} 6/8` : word;
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
      arranged.push({
        ...associated,
        id: `${associated.id}-${block.id}`,
        bar: Math.max(1, Number(block.startBar || 1) - 2),
        beat: positiveNumber(associated.beat) || 1
      });
    }
    cues.forEach((cue) => {
      if (removedCueIds.has(cue.id)) return;
      if (associatedCueIds.has(cue.id)) return;
      if (usedCueIds.has(cue.id)) return;
      const cueBar = positiveNumber(cue.bar) || 1;
      if (cueBar < block.rawStartBar || cueBar >= block.rawEndBar) return;
      arranged.push({
        ...cue,
        id: `${cue.id}-${block.id}`,
        bar: Number(block.startBar || 1) + (cueBar - Number(block.rawStartBar || 1)),
        beat: positiveNumber(cue.beat) || 1
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
  const routing = routeForStem(role, index, routingPreset);
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
    volume: routing.outputChannels.length ? clampNumber(mixerStem?.volume, 0, 100, 80) : 0,
    solo: Boolean(mixerStem?.solo),
    iemSend,
    sourceRelativePath: stem.relativePath,
    cacheRelativePath: stem.cacheRelativePath || stem.relativePath,
    cachePath: stem.cachePath,
    routing,
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
  const hasPresetRoute = Array.isArray(routingPreset.routes?.[routeKey]);
  const presetOutputs = hasPresetRoute ? routingPreset.routes[routeKey] : [];
  const defaultOutputChannels = [index + 1];
  const outputChannels = hasPresetRoute ? presetOutputs : defaultOutputChannels;
  return {
    presetId: routingPreset.id,
    bus: routeKey,
    outputChannels,
    defaultOutputChannels,
    source: hasPresetRoute ? "routing-preset" : "stem-index-default"
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

async function dynamicPadManifestObject({ folderPath, songKey, mixer, routingPreset, settings = {} }) {
  const sourcePath = await dynamicPadFilePath(folderPath, songKey);
  const cached = sourcePath ? await cacheDynamicPadFile(sourcePath, songKey) : { filePath: "", status: "missing", error: "No matching pad WAV." };
  const routing = routeForStem(canonicalBus(mixer?.routeBus || "pads"), 0, routingPreset);
  const mixerVolume = routing.outputChannels.length ? clampNumber(mixer?.volume, 0, 100, Math.round((settings.defaultVolume ?? 0.65) * 100)) : 0;
  const pad = {
    enabled: settings.defaultEnabled !== false,
    padKey: stringValue(songKey),
    source: "settings-pads-folder",
    filePath: cached.filePath || sourcePath,
    volume: mixerVolume / 100,
    startWithSong: settings.startWithSong !== false,
    continueAfterSong: settings.continueBetweenSongs !== false,
    status: cached.status === "cached" || sourcePath ? "ready" : "missing"
  };
  return {
    enabled: pad.enabled,
    key: pad.padKey,
    folderPath,
    bus: "pads",
    sourcePath,
    filePath: cached.filePath || sourcePath,
    fadeInMs: Math.max(0, Number(settings.fadeInMs) || 1500),
    fadeOutMs: Math.max(0, Number(settings.fadeOutMs) || 2500),
    cacheStatus: cached.status,
    cacheError: cached.error || "",
    active: false,
    volume: mixerVolume,
    solo: Boolean(mixer?.solo),
    routing,
    pad
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
    .map((token) => token.endsWith("#") ? `${token.slice(0, -1)}sharp` : token)
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
    "togglePad",
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
    "triggerRepeatCue",
    "triggerPanicRecoveryCue",
    "selectSlot",
    "songTransition"
  ]);
  const action = stringValue(command);
  if (!allowed.has(action)) {
    throw new Error(`Unknown playback command: ${action || "(blank)"}`);
  }

  const state = await loadPlaybackState();
  let setlist = await loadCurrentSetlist();
  if (action === "selectSlot") {
    const targetSlotNumber = positiveNumber(payload.slot);
    const targetSlot = (setlist.slots || []).find((slot) => Number(slot.slot) === targetSlotNumber && slot.songId);
    const switchingActivePlayback = state.transport === "playing" && Number(state.currentSlot) !== targetSlotNumber;
    if (!targetSlot || switchingActivePlayback) {
      const rejected = normalizePlaybackState({
        ...state,
        lastCommand: action,
        commandStatus: "rejected",
        lastMessage: switchingActivePlayback
          ? "Pause or stop before selecting another song."
          : "No setlist song is available for selection.",
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
    const sameSlot = Number(state.currentSlot) === targetSlotNumber;
    const nextState = normalizePlaybackState({
      ...state,
      currentSlot: targetSlotNumber,
      currentTimeSeconds: sameSlot ? state.currentTimeSeconds : 0,
      transportAnchorSeconds: sameSlot ? state.transportAnchorSeconds : 0,
      transportStartedAt: state.transport === "playing" ? state.transportStartedAt : "",
      activeRegionId: sameSlot ? state.activeRegionId : "",
      liveRepeat: sameSlot ? state.liveRepeat : {},
      transition: sameSlot ? state.transition : {},
      lastCommand: action,
      commandStatus: "accepted",
      lastMessage: commandMessage(action, { ...payload, title: targetSlot.title }),
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(nextState);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: true,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: Boolean(activePlaybackProcess)
    };
  }
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
  const confirmed = state.confirmed && state.confirmedFingerprint === setFingerprint(setlist);
  const requiresConfirmedSet = new Set(["play", "restart", "nextSong", "previousSong", "seek", "jumpRegion", "skipRegion", "repeatRegion", "loopRegion", "goOnRegion", "clearRegionRepeat", "triggerRepeatCue", "triggerPanicRecoveryCue", "togglePad", "songTransition"]);
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
  if (action === "songTransition") {
    return applySetlistTransitionLocked(state, setlist, payload);
  }
  const filledSlots = (setlist.slots || []).filter((slot) => slot.songId);
  const requestedSlot = positiveNumber(payload.slot);
  const baseSlot = action === "nextSong"
    ? state.currentSlot || requestedSlot
    : requestedSlot || state.currentSlot;
  const currentSlot = action === "previousSong"
    ? baseSlot || filledSlots[0]?.slot || null
    : nextCommandSlot(action, baseSlot, filledSlots);
  if (state.panic?.active === true && (action === "panic" || (action === "exitPanic" && payload.systemAction !== true))) {
    const queued = await queuePanicReleaseFromState(state, currentSlot || state.currentSlot, payload);
    const nextState = normalizePlaybackState({
      ...state,
      currentSlot: currentSlot || state.currentSlot || positiveNumber(payload.slot),
      panic: queued.panic,
      lastCommand: action,
      commandStatus: queued.ok ? "accepted" : "rejected",
      lastMessage: queued.message,
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(nextState);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: queued.ok,
      reason: queued.ok ? "" : queued.message,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: Boolean(activePlaybackProcess)
    };
  }
  if (state.panic?.active === true && action === "jumpRegion") {
    const queued = await queuePanicReleaseFromState(state, currentSlot || state.currentSlot, payload);
    const nextState = normalizePlaybackState({
      ...state,
      currentSlot: currentSlot || state.currentSlot || positiveNumber(payload.slot),
      panic: queued.panic,
      activeRegionId: stringValue(payload.regionId || state.activeRegionId),
      lastCommand: action,
      commandStatus: queued.ok ? "accepted" : "rejected",
      lastMessage: queued.message,
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(nextState);
    return {
      state: await playbackStateSnapshot(),
      command: action,
      accepted: queued.ok,
      reason: queued.ok ? "" : queued.message,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: Boolean(activePlaybackProcess)
    };
  }
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
  const explicitEditStartSeconds = nonNegativeNumber(payload.startSeconds ?? payload.seconds);
  const previousTimeSeconds = computedPlaybackTimeSeconds(state);
  const resumesPausedPlay = action === "play"
    && explicitEditStartSeconds === null
    && state.transport === "paused"
    && activePlaybackProcess
    && activePlaybackProcess.slot === currentSlot;
  const playStartSeconds = action === "play" && !resumesPausedPlay
    ? explicitEditStartSeconds ?? (state.transport === "stopped" ? previousTimeSeconds : 0)
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
        startSeconds: playStartSeconds ?? 0,
        reuseActive: action === "play"
          && state.transition?.status === "waiting-next"
          && Number(state.transition?.toSlot) === Number(currentSlot)
          && Boolean(activePlaybackProcess)
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
  if (action === "exitPanic") {
    const recoverySeconds = nonNegativeNumber(payload.targetSeconds ?? payload.recoveryTargetSeconds ?? payload.seekSeconds);
    if (recoverySeconds !== null) {
      await sendNativePlaybackCommand("seek", { seconds: recoverySeconds });
    }
  }
  if (action === "triggerRepeatCue") {
    const repeatCue = await repeatCueCommandPayload(payload);
    if (repeatCue.ok) {
      const suppressStart = nonNegativeNumber(payload.suppressCueStartSeconds);
      const suppressEnd = nonNegativeNumber(payload.suppressCueEndSeconds);
      if (suppressStart !== null && suppressEnd !== null && suppressEnd > suppressStart) {
        await sendNativePlaybackCommand("markDynamicCuesTriggeredBetween", {
          startSeconds: suppressStart,
          endSeconds: suppressEnd
        });
      }
      for (const command of repeatCue.commands) {
        await requestNativePlaybackCommand("triggerCue", command, { timeoutMs: 1500 });
        await sleep(command.delayAfterMs ?? 520);
      }
    }
  }
  if (action === "triggerPanicRecoveryCue") {
    const pendingRecovery = state.panic?.recoveryTarget;
    const cueSeconds = nonNegativeNumber(pendingRecovery?.cueSeconds);
    const recoveryCurrentSeconds = computedPlaybackTimeSeconds(state);
    if (!pendingRecovery?.pending || cueSeconds === null || recoveryCurrentSeconds < cueSeconds - 0.1) {
      const rejected = normalizePlaybackState({
        ...state,
        lastCommand: action,
        commandStatus: "rejected",
        lastMessage: "Panic recovery cue is not scheduled.",
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
    const liveSong = await activeManifestSong(currentSlot || state.currentSlot) || await liveMixerManifestSong(currentSlot || state.currentSlot);
    payload.recoveryCue = liveSong
      ? await triggerPanicRecoveryCue(liveSong, { ...payload, keepScheduledCuesSuppressed: true })
      : { ok: false, regionName: stringValue(payload.regionName), error: "No live manifest song was available." };
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
      ? await exitPanicHold(currentSlot || state.currentSlot, payload.source || "operator", payload)
    : action === "triggerPanicRecoveryCue" && state.panic?.recoveryTarget
      ? normalizePanicRuntime({
        ...state.panic,
        recoveryTarget: {
          ...state.panic.recoveryTarget,
          cueFired: true
        }
      })
    : ["play", "stop", "fadeOut", "restart", "nextSong", "previousSong"].includes(action)
      ? normalizePanicRuntime({})
      : state.panic;
  const padRuntime = await nextPadRuntimeState(action, state.pad, payload, currentSlot || state.currentSlot, setlist, panicRuntime);
  const liveRepeatPayload = ["repeatRegion", "loopRegion"].includes(action)
    ? { ...payload, repeatCuePlan: await liveRepeatCuePlanForCommand(currentSlot || state.currentSlot, payload) }
    : payload;
  const liveRepeat = nextLiveRepeatState(action, state.liveRepeat, liveRepeatPayload);
  const transportByCommand = {
    play: "playing",
    pause: "paused",
    stop: "stopped",
    fadeOut: "stopped",
    panic: state.transport === "playing" ? "playing" : "panic",
    exitPanic: state.transport === "panic" ? "playing" : state.transport,
    restart: "playing",
    nextSong: "playing"
  };
  const nextTransport = transportByCommand[action] || state.transport || "stopped";
  const startsFromZero = ["restart", "nextSong", "previousSong"].includes(action)
    || (action === "play" && !resumesPausedPlay && playStartSeconds === null);
  const seekSeconds = action === "seek"
    ? nonNegativeNumber(payload.seconds)
    : action === "exitPanic"
      ? nonNegativeNumber(payload.targetSeconds ?? payload.recoveryTargetSeconds ?? payload.seekSeconds)
      : null;
  const nextTimeSeconds = nextTransport === "stopped"
    ? 0
    : seekSeconds !== null
      ? seekSeconds
      : playStartSeconds !== null
      ? playStartSeconds
      : startsFromZero
      ? 0
      : previousTimeSeconds;
  const nextStartedAt = nextTransport === "playing" ? new Date().toISOString() : "";
  const nextState = normalizePlaybackState({
    ...state,
    currentSlot: currentSlot || state.currentSlot || positiveNumber(payload.slot),
    activeRegionId: stringValue(payload.regionId || state.activeRegionId),
    liveRepeat,
    pad: padRuntime,
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
  if (["play", "restart", "nextSong", "previousSong", "togglePad", "panic", "exitPanic", "stop", "fadeOut"].includes(action)) {
    await applyLivePadState(nextState.currentSlot, nextState);
  }
  if (["panic", "exitPanic", "stop", "fadeOut", "restart", "nextSong", "previousSong"].includes(action)) {
    await setLiveScheduledDynamicCuesSuppressed(nextState.currentSlot, nextState.panic?.active === true);
  }
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

async function applySetlistTransitionLocked(state, setlist, payload = {}) {
  const fromSlot = positiveNumber(payload.fromSlot || state.currentSlot);
  const transition = transitionForFromSlot(setlist, fromSlot);
  if (!transition) {
    const blocked = normalizePlaybackState({
      ...state,
      lastCommand: "songTransition",
      commandStatus: "rejected",
      transition: {
        active: false,
        fromSlot,
        status: "blocked",
        message: "No transition is available for this slot."
      },
      lastMessage: "No transition is available for this slot.",
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(blocked);
    return {
      state: await playbackStateSnapshot(),
      command: "songTransition",
      accepted: false,
      reason: blocked.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: Boolean(activePlaybackProcess)
    };
  }
  const currentSlot = (setlist.slots || []).find((slot) => slot.slot === transition.fromSlot && slot.songId);
  const nextSlot = (setlist.slots || []).find((slot) => slot.slot === transition.toSlot && slot.songId);
  if (!currentSlot || !nextSlot) {
    const blocked = normalizePlaybackState({
      ...state,
      transport: "stopped",
      transition: {
        ...transition,
        active: false,
        status: "blocked",
        message: "Transition target song is missing."
      },
      lastCommand: "songTransition",
      commandStatus: "rejected",
      lastMessage: "Transition target song is missing.",
      updatedAt: new Date().toISOString()
    });
    await stopNativePlayback();
    await savePlaybackState(blocked);
    return {
      state: await playbackStateSnapshot(),
      command: "songTransition",
      accepted: false,
      reason: blocked.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: false
    };
  }

  if (["crossfade", "overlap"].includes(transition.mode)) {
    await stopNativePlayback({ fade: true, durationMs: 250 });
    const blocked = normalizePlaybackState({
      ...state,
      transport: "stopped",
      currentSlot: transition.fromSlot,
      currentTimeSeconds: 0,
      transportAnchorSeconds: 0,
      transportStartedAt: "",
      transition: {
        ...transition,
        active: false,
        status: "blocked",
        message: `${transition.mode} needs deeper engine support and is planned.`
      },
      lastCommand: "songTransition",
      commandStatus: "rejected",
      lastMessage: `${transition.mode} transition is planned but not enabled yet.`,
      updatedAt: new Date().toISOString()
    });
    await savePlaybackState(blocked);
    return {
      state: await playbackStateSnapshot(),
      command: "songTransition",
      accepted: false,
      reason: blocked.lastMessage,
      engine: ENGINE_HELPER,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      nativeEngineConnected: false
    };
  }

  const pad = transitionPadRuntime(transition, currentSlot, nextSlot);
  let nativePlayback = { ok: true };
  let transport = "stopped";
  let currentSlotNumber = transition.mode === "stay" ? transition.fromSlot : transition.toSlot;
  let status = transition.mode === "cue-next" ? "waiting-next" : "completed";
  let message = transitionMessage(transition, currentSlot, nextSlot);
  if (transition.mode === "autolink") {
    nativePlayback = await startNativeSlotPlayback(transition.toSlot, { startSeconds: 0 });
    if (!nativePlayback.ok) {
      status = "blocked";
      message = nativePlayback.error || `${transitionModeLabel(transition.mode)} could not start the next song.`;
      transport = "stopped";
      currentSlotNumber = transition.toSlot;
    } else {
      transport = "playing";
    }
  } else if (transition.mode === "cue-next") {
    await applyTransitionPadHold(currentSlot, nextSlot, pad);
  } else {
    await stopNativePlayback();
  }

  const nextState = normalizePlaybackState({
    ...state,
    currentSlot: currentSlotNumber,
    transport,
    currentTimeSeconds: 0,
    transportAnchorSeconds: 0,
    transportStartedAt: transport === "playing" ? new Date().toISOString() : "",
    liveRepeat: normalizeLiveRepeat({}),
    pad,
    panic: normalizePanicRuntime({}),
    transition: {
      ...transition,
      active: transition.mode === "autolink" && transport === "playing",
      startedAt: new Date().toISOString(),
      status,
      message
    },
    lastCommand: "songTransition",
    commandStatus: status === "blocked" ? "rejected" : "accepted",
    lastMessage: message,
    updatedAt: new Date().toISOString()
  });
  await savePlaybackState(nextState);
  if (transport === "playing") {
    await applyLivePadState(nextState.currentSlot, nextState);
  }
  const snapshot = await playbackStateSnapshot();
  return {
    state: snapshot,
    command: "songTransition",
    accepted: status !== "blocked",
    reason: status === "blocked" ? message : "",
    engine: ENGINE_HELPER,
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    nativeEngineConnected: Boolean(snapshot.readiness?.engine?.nativeEngineConnected),
    nativePlaybackStarted: nativePlayback.response?.type === "playbackStarted"
  };
}

function transitionForFromSlot(setlist, fromSlot) {
  const normalized = normalizeSetlistTransitions(setlist?.transitions, setlist?.slots);
  return normalized.find((transition) => transition.fromSlot === fromSlot) || null;
}

function transitionPadRuntime(transition, currentSlot, nextSlot) {
  if (!transition.continuePad || transition.padBehavior === "off") {
    return normalizePadRuntime({
      active: false,
      source: "transition",
      updatedAt: new Date().toISOString()
    });
  }
  const useNext = ["next-song-key", "crossfade-to-next-key"].includes(transition.padBehavior);
  const slot = useNext ? nextSlot : currentSlot;
  return normalizePadRuntime({
    active: true,
    slot: slot?.slot,
    songId: slot?.songId,
    padKey: slot?.padKey || slot?.key,
    source: "transition",
    updatedAt: new Date().toISOString()
  });
}

function transitionMessage(transition, currentSlot, nextSlot) {
  if (transition.mode === "stay") return `Transition Stay: ${currentSlot.title} stopped and remains selected.`;
  if (transition.mode === "autolink") return `AutoLink: starting ${nextSlot.title}.`;
  return `Cue Next: ${nextSlot.title} selected.`;
}

async function applyTransitionPadHold(currentSlot, nextSlot, padRuntime) {
  if (!padRuntime?.active || activePlaybackProcess?.slot !== currentSlot?.slot) {
    await stopNativePlayback();
    return;
  }
  const settings = await loadSettings();
  const currentLiveSong = await activeManifestSong(currentSlot.slot) || await liveMixerManifestSong(currentSlot.slot);
  const nextLiveSong = await liveMixerManifestSong(nextSlot.slot);
  if (!currentLiveSong || !nextLiveSong?.dynamicPad) {
    await stopNativePlayback();
    return;
  }
  await sendNativePlaybackCommand("setScheduledDynamicCuesSuppressed", { suppressed: true });
  await sendNativePlaybackCommand("allowScheduledDynamicCuePrefix", { cueIdPrefix: "" });
  await fadeTransitionPad({
    currentLiveSong,
    nextLiveSong,
    fadeOutMs: transitionPadDelayMs(currentLiveSong, 2),
    fadeInMs: settings.pads?.fadeInMs
  });
}

async function fadeTransitionPad({ currentLiveSong, nextLiveSong, fadeOutMs = 1200, fadeInMs = 1500 }) {
  const currentPad = currentLiveSong.dynamicPad || {};
  const nextPad = nextLiveSong.dynamicPad || {};
  const currentVolume = clampNumber(currentPad.volume, 0, 100, 65);
  const nextVolume = clampNumber(nextPad.volume, 0, 100, 65);
  const click = currentLiveSong.dynamicClick || null;
  const cue = currentLiveSong.dynamicCue || null;
  const fadeOutSteps = Math.max(1, Math.floor(Math.max(0, Number(fadeOutMs) || 0) / 50));
  for (let step = 1; step <= fadeOutSteps; step += 1) {
    const volume = currentVolume * (1 - (step / fadeOutSteps));
    await sendNativePlaybackCommand("updateDynamicMixer", {
      dynamicClick: click,
      dynamicCue: cue,
      dynamicPad: { ...currentPad, active: true, volume }
    });
    await sleep(50);
  }

  const sampleResult = await requestNativePlaybackCommand("updateDynamicPadSample", {
    filePath: nextPad.filePath || nextPad.pad?.filePath || ""
  }, { timeoutMs: 1500 });
  if (!sampleResult.ok) {
    await stopNativePlayback();
    return;
  }

  const fadeInSteps = Math.max(1, Math.floor(Math.max(0, Number(fadeInMs) || 0) / 50));
  for (let step = 1; step <= fadeInSteps; step += 1) {
    const volume = nextVolume * (step / fadeInSteps);
    await sendNativePlaybackCommand("updateDynamicMixer", {
      dynamicClick: click,
      dynamicCue: cue,
      dynamicPad: { ...nextPad, active: true, volume }
    });
    await sleep(50);
  }
}

function transitionPadDelayMs(liveSong, beats = 2) {
  const beatGrid = Array.isArray(liveSong?.tempoMap?.beatGrid) ? liveSong.tempoMap.beatGrid : [];
  const intervals = [];
  for (let index = Math.max(1, beatGrid.length - 10); index < beatGrid.length; index += 1) {
    const previous = nonNegativeNumber(beatGrid[index - 1]?.timeSeconds);
    const current = nonNegativeNumber(beatGrid[index]?.timeSeconds);
    if (previous !== null && current !== null && current > previous) {
      intervals.push(current - previous);
    }
  }
  const beatSeconds = intervals.length
    ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
    : positiveNumber(liveSong?.tempoMap?.bpm)
      ? 60 / positiveNumber(liveSong.tempoMap.bpm)
      : 0.75;
  return Math.max(150, Math.round(beatSeconds * Math.max(1, Number(beats) || 2) * 1000));
}

function nextLiveRepeatState(action, current, payload = {}) {
  const existing = normalizeLiveRepeat(current);
  if (action === "repeatRegion") {
    return normalizeLiveRepeat({
      mode: "once",
      regionId: payload.regionId,
      regionName: payload.regionName,
      queued: true,
      repeatCuePlan: payload.repeatCuePlan
    });
  }
  if (action === "loopRegion") {
    return normalizeLiveRepeat({
      mode: "loop",
      regionId: payload.regionId,
      regionName: payload.regionName,
      queued: true,
      repeatCuePlan: payload.repeatCuePlan
    });
  }
  if (action === "goOnRegion" && existing.mode === "loop") {
    return normalizeLiveRepeat({
      ...existing,
      releaseRequested: !payload.deferRelease,
      releaseAfterNextPass: Boolean(payload.deferRelease),
      actionInFlight: false
    });
  }
  if (action === "triggerRepeatCue" && existing.mode) {
    return normalizeLiveRepeat({
      ...existing,
      cueFired: true
    });
  }
  if (action === "seek" && existing.mode) {
    return normalizeLiveRepeat({
      ...existing,
      cueFired: false,
      actionInFlight: false
    });
  }
  if (["stop", "fadeOut", "panic", "restart", "nextSong", "previousSong", "clearRegionRepeat"].includes(action)) {
    return normalizeLiveRepeat({});
  }
  return existing;
}

async function liveRepeatCuePlanForCommand(slotNumber, payload = {}) {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (!liveSong) return null;
  const regions = normalizeRegions(Array.isArray(liveSong.regions) ? liveSong.regions : []);
  const regionId = stringValue(payload.regionId);
  const regionName = stringValue(payload.regionName);
  const region = regionId
    ? regions.find((item) => item.id === regionId)
    : regions.find((item) => sameText(item.name, regionName));
  if (!region) return null;
  const beatGrid = Array.isArray(liveSong.tempoMap?.beatGrid) ? liveSong.tempoMap.beatGrid : [];
  if (!beatGrid.length) return null;
  const startSeconds = timeForBarBeatServer(liveSong.tempoMap, region.startBar, region.startBeat);
  const endSeconds = timeForBarBeatServer(liveSong.tempoMap, region.endBar, region.endBeat);
  const boundaryIndex = beatGrid.findIndex((beat) => Number(beat.timeSeconds || 0) >= endSeconds - 0.0001);
  const endIndex = boundaryIndex < 0 ? beatGrid.length : boundaryIndex;
  const cueBeat = beatGrid[endIndex - 8];
  if (!cueBeat) return null;
  const repeatedCueBeat = beatGrid[endIndex - 6] || cueBeat;
  const suppressStart = beatGrid[endIndex - 4];
  const suppressEnd = beatGrid[endIndex - 3];
  const triggerSeconds = nonNegativeNumber(cueBeat.timeSeconds);
  const repeatedCueSeconds = nonNegativeNumber(repeatedCueBeat.timeSeconds) ?? triggerSeconds;
  if (triggerSeconds === null) return null;
  return normalizeRepeatCuePlan({
    triggerSeconds,
    startSeconds,
    endSeconds,
    repeatedCueDelayMs: Math.max(0, Math.round((repeatedCueSeconds - triggerSeconds) * 1000)),
    suppressCueStartSeconds: nonNegativeNumber(suppressStart?.timeSeconds),
    suppressCueEndSeconds: suppressStart && suppressEnd
      ? Math.max(Number(suppressStart.timeSeconds || 0) + 0.25, Number(suppressEnd.timeSeconds || 0) - 0.05)
      : null,
    generatedAt: new Date().toISOString()
  });
}

async function nextPadRuntimeState(action, current, payload, slotNumber, setlist, panicRuntime) {
  const existing = normalizePadRuntime(current);
  const slot = (setlist.slots || []).find((item) => item.slot === slotNumber && item.songId);
  const settings = await loadSettings();
  if (action === "togglePad") {
    const active = payload.active === undefined ? !existing.active : Boolean(payload.active);
    return normalizePadRuntime({
      active,
      slot: slot?.slot || slotNumber,
      songId: slot?.songId,
      padKey: slot?.padKey || slot?.key,
      source: "operator",
      updatedAt: new Date().toISOString()
    });
  }
  if (["stop", "fadeOut"].includes(action)) {
    return normalizePadRuntime({
      ...existing,
      active: panicRuntime?.active === true || (existing.active && settings.pads?.continueBetweenSongs === true),
      updatedAt: new Date().toISOString()
    });
  }
  if (["play", "restart", "nextSong", "previousSong"].includes(action)) {
    const shouldStart = settings.pads?.defaultEnabled !== false && settings.pads?.startWithSong !== false;
    return normalizePadRuntime({
      active: shouldStart || existing.active,
      slot: slot?.slot || slotNumber,
      songId: slot?.songId,
      padKey: slot?.padKey || slot?.key,
      source: shouldStart ? "startWithSong" : existing.source,
      updatedAt: new Date().toISOString()
    });
  }
  if (action === "panic") {
    return normalizePadRuntime({
      ...existing,
      active: true,
      slot: slot?.slot || slotNumber,
      songId: slot?.songId,
      padKey: slot?.padKey || slot?.key,
      source: "panic",
      updatedAt: new Date().toISOString()
    });
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
  const recoveryCue = payload.recoveryCue || null;
  const recoveryCueMessage = recoveryCue
      ? recoveryCue.ok
      ? recoveryCue.skipped
        ? " Recovery cue skipped because the cue point already passed."
        : recoveryCue.alreadyTriggered
        ? " Recovery cue already fired."
        : ` Recovery cue fired: ${(recoveryCue.triggered || []).join(", ") || recoveryCue.regionName}.`
      : ` Recovery cue failed: ${recoveryCue.error || "unknown error"}.`
    : "";
  const labels = {
    play: "Play command queued.",
    pause: "Pause command queued.",
    stop: "Stop command queued.",
    fadeOut: "Fade out then stop command queued.",
    togglePad: "Pad toggle queued.",
    panic: "Panic hold active. Tracks down, click alive, scheduled cues suppressed.",
    exitPanic: `Panic recovery${payload.regionName ? ` to ${payload.regionName}` : ""}.${recoveryCueMessage} Tracks fading back in, pad fading out.`,
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
    triggerRepeatCue: "Repeat cue triggered.",
    triggerPanicRecoveryCue: `Recovery cue triggered${payload.regionName ? ` for ${payload.regionName}` : ""}.${recoveryCueMessage}`,
    selectSlot: `Selected ${payload.title || "setlist song"}.`
  };
  return labels[action] || `${action} command queued.`;
}

async function repeatCueCommandPayload(payload = {}) {
  const settings = await loadSettings();
  const folderPath = stringValue(settings.dynamicCue?.folderPath);
  if (!folderPath) return { ok: false, error: "Dynamic cue folder is not configured." };
  let entries = [];
  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch {
    return { ok: false, error: "Dynamic cue folder is unavailable." };
  }
  const wavs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({ name: entry.name, filePath: join(folderPath, entry.name), key: cueMatchKey(entry.name.replace(/\.wav$/i, "")) }));
  const match = findCueWav(wavs, "Repeat");
  if (!match) return { ok: false, error: "Repeat.wav was not found in the dynamic cue folder." };
  const regionName = stringValue(payload.regionName).trim();
  const regionCue = regionName ? liveRegionCueCommands(regionName, wavs) : [];
  const repeatedCueDelayMs = Math.max(0, Math.min(3000, Number(payload.repeatedCueDelayMs || 0)));
  return {
    ok: true,
    commands: [
      {
        cueId: "live-repeat",
        cueName: "Repeat",
        filePath: match.filePath,
        delayAfterMs: regionCue.length ? repeatedCueDelayMs : 500
      },
      ...regionCue
    ]
  };
}

async function recoveryCueCommandPayload(regionName) {
  const settings = await loadSettings();
  const folderPath = stringValue(settings.dynamicCue?.folderPath);
  if (!folderPath) return { ok: false, commands: [], error: "Dynamic cue folder is not configured." };
  let entries = [];
  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch {
    return { ok: false, commands: [], error: "Dynamic cue folder is unavailable." };
  }
  const wavs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => ({ name: entry.name, filePath: join(folderPath, entry.name), key: cueMatchKey(entry.name.replace(/\.wav$/i, "")) }));
  const intro = findCueWav(wavs, "In");
  const regionCue = liveRegionCueCommands(regionName, wavs);
  const commands = [];
  if (intro) {
    commands.push({
      cueId: "panic-recovery-in",
      cueName: "In",
      filePath: intro.filePath,
      delayAfterMs: regionCue.length ? 220 : 500
    });
  }
  commands.push(...regionCue.map((command) => ({
    ...command,
    cueId: `panic-recovery-${command.cueId}`,
    delayAfterMs: command.delayAfterMs ?? 650
  })));
  return {
    ok: commands.length > 0,
    commands
  };
}

function liveRegionCueCommands(regionName, wavs) {
  const cue = { id: `live-repeat-${cueMatchKey(regionName)}`, name: regionName };
  const sectionCue = sectionOnlyCueMatch(cue, wavs);
  return sectionCue.match
    ? [{ cueId: cue.id, cueName: sectionCue.name, filePath: sectionCue.match.filePath, delayAfterMs: 650 }]
    : [];
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
  const tempoMap = extendTempoMapForSongPositions(
    normalizeTempoMap(metadata.tempoMap || {}, slot),
    songGridPositions(regions, cueMarkers)
  );
  const mixer = normalizeMixer(metadata.mixer || {}, slot);
  const arrangement = normalizeArrangement(metadata.arrangement || {});

  const savedAt = new Date().toISOString();
  await writeFile(join(slotDir, "regions.json"), `${JSON.stringify({
    regions,
    source: "operator-working-draft",
    updatedAt: savedAt
  }, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "cue-markers.json"), `${JSON.stringify({
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: "operator-working-draft",
    updatedAt: savedAt
  }, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "tempo-map.json"), `${JSON.stringify(tempoMap, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "mixer.json"), `${JSON.stringify(mixer, null, 2)}\n`, "utf8");
  await writeFile(join(slotDir, "arrangement.json"), `${JSON.stringify(arrangement, null, 2)}\n`, "utf8");
  await renderArrangementCacheForSlot(slot, { regions, cueMarkers, tempoMap, arrangement, mixer });
  await markSetUnconfirmed(setlist);
  return readCurrentSetMetadata();
}

async function approveSlotCueRegionMetadata(slotNumber) {
  const state = await playbackStateSnapshot();
  if (state.mode === "performance") {
    throw new Error("Cue/region approval is locked in Performance mode.");
  }
  const setlist = await loadCurrentSetlist();
  const slot = setlist.slots.find((item) => item.slot === slotNumber && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  const slotDir = join(SET_METADATA_DIR, `slot-${String(slotNumber).padStart(2, "0")}`);
  const regions = normalizeRegions((await readJsonFile(join(slotDir, "regions.json"), { regions: [] })).regions || []);
  const cueMarkers = normalizeCueMarkers((await readJsonFile(join(slotDir, "cue-markers.json"), { cueMarkers: [] })).cueMarkers || []);
  await saveApprovedSongRegionCueMetadata(slot, regions, cueMarkers);
  return {
    ok: true,
    slot: slotNumber,
    songId: slot.songId,
    approvedAt: new Date().toISOString(),
    cueCount: cueMarkers.length,
    regionCount: regions.length
  };
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

async function saveApprovedSongRegionCueMetadata(slot, regions, cueMarkers) {
  if (!slot.folderPath) return;
  const overrideDir = appSongOverridesDir(slot.songId);
  await mkdir(overrideDir, { recursive: true });
  const approvedAt = new Date().toISOString();
  await writeFile(appApprovedRegionsPath(slot.songId), `${JSON.stringify({
    regions,
    source: "operator-approved",
    approved: true,
    approvedAt,
    updatedAt: approvedAt
  }, null, 2)}\n`, "utf8");
  await writeFile(appApprovedCueMarkersPath(slot.songId), `${JSON.stringify({
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: "operator-approved",
    approved: true,
    approvedAt,
    updatedAt: approvedAt
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
  const hasSongTrim = (positiveNumber(arrangement.trimStartBar) || 1) > 1
    || positiveNumber(arrangement.trimEndBar)
    || nonNegativeNumber(arrangement.trimStartSeconds)
    || nonNegativeNumber(arrangement.trimEndSeconds);
  const hasArrangement = arrangement.enabled !== false && (arrangement.blocks.length || arrangement.cuts.length || hasSongTrim);
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
  const trimStartBar = positiveNumber(arrangement.trimStartBar) || 1;
  const trimEndBar = positiveNumber(arrangement.trimEndBar);
  const trimStartSeconds = nonNegativeNumber(arrangement.trimStartSeconds) ?? 0;
  const trimEndSeconds = nonNegativeNumber(arrangement.trimEndSeconds);
  let cursor = 1;
  let arrangedSeconds = 0;
  return sourceBlocks.map((block, index) => {
    const region = orderedRegions.find((item) => item.id === block.regionId);
    if (!region) return null;
    const regionStartBar = positiveNumber(region.startBar) || 1;
    const regionEndBar = Math.max(regionStartBar + 1, positiveNumber(region.endBar) || regionStartBar + 1);
    const rawStartBar = Math.max(regionStartBar, trimStartBar, positiveNumber(block.trimStartBar) || regionStartBar);
    const useMeasureEndTrim = Boolean(trimEndBar && trimEndSeconds === null);
    const rawEndBar = Math.min(regionEndBar, useMeasureEndTrim ? trimEndBar : regionEndBar, Math.max(rawStartBar + 1, positiveNumber(block.trimEndBar) || regionEndBar));
    if (rawEndBar <= rawStartBar) return null;
    if (activeCuts.some((cut) => rawStartBar >= cut.startBar && rawEndBar <= cut.endBar)) return null;
    const blockStartSeconds = timeForBarBeatServer(tempoMap, rawStartBar, positiveNumber(region.startBeat) || 1);
    const blockEndSeconds = timeForBarBeatServer(tempoMap, rawEndBar, positiveNumber(region.endBeat) || 1);
    const blockTrimStartSeconds = nonNegativeNumber(block.trimStartSeconds);
    const blockTrimEndSeconds = nonNegativeNumber(block.trimEndSeconds);
    const rawStartSeconds = Math.max(blockStartSeconds, trimStartSeconds, blockTrimStartSeconds ?? 0);
    const rawEndSeconds = Math.min(
      blockEndSeconds,
      trimEndSeconds !== null ? trimEndSeconds : blockEndSeconds,
      blockTrimEndSeconds !== null ? blockTrimEndSeconds : blockEndSeconds
    );
    if (rawEndSeconds <= rawStartSeconds) return null;
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
      dynamicPad: { ...(liveSong?.dynamicPad || {}), active: playbackState.panic?.active === true || playbackState.pad?.active === true }
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
    dynamicPad: { ...dynamic.dynamicPad, active: playbackState.panic?.active === true || playbackState.pad?.active === true }
  });
  return { ok: true, active: true, slot: slotNumber };
}

async function liveDynamicMixerObjects(slot, mixer, routingPreset, settings) {
  const base = await activeManifestSong(slot.slot) || {};
  const dynamicClickMixer = matchMixerStem({ id: "dynamic-click" }, mixer);
  const dynamicCueMixer = matchMixerStem({ id: "dynamic-cue" }, mixer);
  const dynamicPadMixer = matchMixerStem({ id: "dynamic-pad" }, mixer);
  const dynamicClickRouting = routeForStem(canonicalBus(dynamicClickMixer?.routeBus || "click"), 0, routingPreset);
  const dynamicCueRouting = routeForStem(canonicalBus(dynamicCueMixer?.routeBus || "dynamicCue"), 0, routingPreset);
  const songMetadata = slot.folderPath ? await readSongMetadata(slot.folderPath) : null;
  const dynamicPad = await dynamicPadManifestObject({
    folderPath: settings.pads.folderPath,
    songKey: slot.padKey || slot.key,
    mixer: dynamicPadMixer,
    routingPreset,
    settings: settings.pads
  });
  return {
    dynamicClick: {
      ...(base.dynamicClick || songMetadata?.dynamicClick || {}),
      volume: dynamicClickRouting.outputChannels.length ? clampNumber(dynamicClickMixer?.volume, 0, 100, 80) : 0,
      solo: Boolean(dynamicClickMixer?.solo),
      routing: dynamicClickRouting
    },
    dynamicCue: {
      ...(base.dynamicCue || {}),
      volume: dynamicCueRouting.outputChannels.length ? clampNumber(dynamicCueMixer?.volume, 0, 100, 80) : 0,
      solo: Boolean(dynamicCueMixer?.solo),
      routing: dynamicCueRouting
    },
    dynamicPad: {
      ...(base.dynamicPad || {}),
      ...dynamicPad
    }
  };
}

async function setLiveScheduledDynamicCuesSuppressed(slotNumber, suppressed) {
  if (!slotNumber || activePlaybackProcess?.slot !== slotNumber) return;
  await sendNativePlaybackCommand("setScheduledDynamicCuesSuppressed", { suppressed: Boolean(suppressed) });
}

async function applyLivePadState(slotNumber, playbackState = null) {
  if (!slotNumber || activePlaybackProcess?.slot !== slotNumber) return;
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (!liveSong) return;
  const state = playbackState || await loadPlaybackState();
  const active = state.panic?.active === true || state.pad?.active === true;
  await sendNativePlaybackCommand("updateDynamicMixer", {
    dynamicClick: liveSong.dynamicClick || null,
    dynamicCue: liveSong.dynamicCue || null,
    dynamicPad: { ...(liveSong.dynamicPad || {}), active }
  });
}

async function enterPanicHold(slotNumber, source = "operator") {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (activePlaybackProcess?.slot === slotNumber && liveSong) {
    await setLiveScheduledDynamicCuesSuppressed(slotNumber, true);
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
    detail: "Tracks Down / Click Alive / Scheduled Cues Suppressed",
    startedAt: new Date().toISOString(),
    slot: slotNumber,
    songId: stringValue(liveSong?.songId),
    heldPadKey: stringValue(liveSong?.dynamicPad?.key || liveSong?.pad?.padKey || liveSong?.tempoMap?.key),
    tracksMuted: true,
    clickMuted: false,
    cueMuted: false,
    recoveryTarget: null,
    trackTargetDb: PANIC_TRACK_TARGET_DB,
    source,
    updatedAt: new Date().toISOString()
  };
}

async function exitPanicHold(slotNumber, source = "operator", payload = {}) {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  const state = await loadPlaybackState();
  const recoveryRegion = recoveryRegionFromPayload(liveSong, payload, computedPlaybackTimeSeconds(state));
  if (recoveryRegion?.name) {
    payload.regionId = recoveryRegion.id || payload.regionId || "";
    payload.regionName = recoveryRegion.name;
    if (payload.targetSeconds === undefined && Number.isFinite(recoveryRegion.startSeconds)) {
      payload.targetSeconds = recoveryRegion.startSeconds;
    }
  }
  if (activePlaybackProcess?.slot === slotNumber && liveSong) {
    payload.recoveryCue = payload.recoveryCueAlreadyTriggered
      ? { ok: true, regionName: stringValue(payload.regionName), triggered: [], alreadyTriggered: !payload.recoveryCueSkipped, skipped: Boolean(payload.recoveryCueSkipped) }
      : { ok: true, regionName: stringValue(payload.regionName), triggered: [], skipped: true };
    await sendNativePlaybackCommand("setScheduledDynamicCuesSuppressed", { suppressed: false });
    await sendNativePlaybackCommand("allowScheduledDynamicCuePrefix", { cueIdPrefix: "" });
    fadeRecoverLiveMusicAndPad(liveSong, PANIC_RECOVERY_FADE_MS)
      .catch((error) => console.warn(`[panic-recovery] fade restore failed: ${error.message}`));
  } else {
    payload.recoveryCue = {
      ok: false,
      regionName: stringValue(payload.regionName),
      error: activePlaybackProcess?.slot === slotNumber ? "No live manifest song was available." : "No active playback engine was running for this slot."
    };
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

function recoveryRegionFromPayload(liveSong, payload = {}, fallbackCurrentSeconds = null) {
  const regions = normalizeRegions(Array.isArray(liveSong?.regions)
    ? liveSong.regions
    : Array.isArray(liveSong?.regions?.regions)
      ? liveSong.regions.regions
      : []);
  if (!regions.length) {
    const name = stringValue(payload.regionName);
    return name ? { id: stringValue(payload.regionId), name } : null;
  }

  const targetSeconds = nonNegativeNumber(payload.targetSeconds ?? payload.recoveryTargetSeconds);
  if (targetSeconds !== null) {
    const starts = recoveryRegionStarts(liveSong, regions);
    const exact = starts.find((entry) => Math.abs(entry.seconds - targetSeconds) <= 0.35);
    if (exact) return { ...exact.region, startSeconds: exact.seconds };
    const next = starts.find((entry) => entry.seconds >= targetSeconds - 0.35);
    if (next) return { ...next.region, startSeconds: next.seconds };
    const nearest = starts
      .slice()
      .sort((a, b) => Math.abs(a.seconds - targetSeconds) - Math.abs(b.seconds - targetSeconds))[0];
    if (nearest) return { ...nearest.region, startSeconds: nearest.seconds };
  }

  const id = stringValue(payload.regionId);
  if (id) {
    const starts = recoveryRegionStarts(liveSong, regions);
    const match = starts.find((entry) => entry.region.id === id);
    if (match) return { ...match.region, startSeconds: match.seconds };
  }
  const name = stringValue(payload.regionName);
  if (name) {
    const starts = recoveryRegionStarts(liveSong, regions);
    const match = starts.find((entry) => sameText(entry.region.name, name));
    if (match) return { ...match.region, startSeconds: match.seconds };
    return { id, name };
  }

  const currentSeconds = nonNegativeNumber(fallbackCurrentSeconds);
  if (currentSeconds !== null) {
    const starts = recoveryRegionStarts(liveSong, regions);
    const next = starts.find((entry) => entry.seconds > currentSeconds + 0.25);
    if (next) return { ...next.region, startSeconds: next.seconds };
    const current = starts
      .slice()
      .reverse()
      .find((entry) => entry.seconds <= currentSeconds + 0.25);
    if (current) return { ...current.region, startSeconds: current.seconds };
  }

  return null;
}

function recoveryRegionStarts(liveSong, regions) {
  return regions
    .map((region) => ({
      region,
      seconds: timeForBarBeatServer(liveSong?.tempoMap, region.startBar, region.startBeat)
    }))
      .filter((entry) => Number.isFinite(entry.seconds))
      .sort((a, b) => a.seconds - b.seconds);
}

async function queuePanicReleaseFromState(state, slotNumber, payload = {}) {
  const liveSong = await activeManifestSong(slotNumber) || await liveMixerManifestSong(slotNumber);
  if (!liveSong) {
    return {
      ok: false,
      panic: state.panic,
      message: "Cannot queue Panic release because the live song map is not loaded."
    };
  }
  const regions = normalizeRegions(Array.isArray(liveSong.regions)
    ? liveSong.regions
    : Array.isArray(liveSong.regions?.regions)
      ? liveSong.regions.regions
      : []);
  const currentSeconds = computedPlaybackTimeSeconds(state);
  const starts = recoveryRegionStarts(liveSong, regions);
  const requestedId = stringValue(payload.regionId);
  const requestedName = stringValue(payload.regionName);
  const targetSeconds = nonNegativeNumber(payload.targetSeconds ?? payload.recoveryTargetSeconds ?? payload.seekSeconds);
  const requested = requestedId
    ? starts.find((entry) => stringValue(entry.region.id) === requestedId)
    : requestedName
      ? starts.find((entry) => sameText(entry.region.name, requestedName))
      : targetSeconds !== null
      ? starts.slice().sort((a, b) => Math.abs(a.seconds - targetSeconds) - Math.abs(b.seconds - targetSeconds))[0]
      : null;
  const execute = starts.find((entry) => entry.seconds > currentSeconds + 0.25);
  const target = requested || execute;
  if (!target) {
    return {
      ok: false,
      panic: state.panic,
      message: "Cannot queue Panic release because no next region was found."
    };
  }
  const regionName = stringValue(target.region.name);
  const cue = (Array.isArray(liveSong.cueMarkers)
    ? liveSong.cueMarkers
    : Array.isArray(liveSong.cues)
      ? liveSong.cues
      : Array.isArray(liveSong.cues?.cueMarkers)
        ? liveSong.cues.cueMarkers
      : [])
    .map((marker) => ({
      marker,
      seconds: timeForBarBeatServer(liveSong.tempoMap, marker.bar, marker.beat)
    }))
    .filter((entry) => Number.isFinite(entry.seconds)
      && entry.seconds < target.seconds - 0.02
      && sameText(entry.marker.name, regionName))
    .sort((a, b) => b.seconds - a.seconds)[0];
  const recoveryTarget = {
    pending: true,
    slot: slotNumber,
    executeSeconds: target.seconds,
    targetSeconds: target.seconds,
    cueSeconds: Number.isFinite(cue?.seconds) ? cue.seconds : null,
    cueFired: Number.isFinite(cue?.seconds) && cue.seconds < currentSeconds - 0.1,
    cueSkipped: Number.isFinite(cue?.seconds) && cue.seconds < currentSeconds - 0.1,
    cueId: stringValue(cue?.marker?.id),
    regionId: stringValue(target.region.id),
    regionName,
    seekSeconds: null,
    queuedAt: new Date().toISOString()
  };
  if (activePlaybackProcess?.slot === slotNumber && recoveryTarget.cueId && !recoveryTarget.cueFired) {
    await sendNativePlaybackCommand("allowScheduledDynamicCuePrefix", {
      cueIdPrefix: recoveryTarget.cueId
    });
  }
  recoveryTarget.message = `Panic release queued at ${regionName || formatSecondsForLog(target.seconds)}.${Number.isFinite(recoveryTarget.cueSeconds) ? recoveryTarget.cueFired ? " Cue point already passed." : ` Cue at ${formatSecondsForLog(recoveryTarget.cueSeconds)}.` : ""}`;
  return {
    ok: true,
    panic: {
      ...state.panic,
      recoveryTarget,
      detail: recoveryTarget.message,
      updatedAt: new Date().toISOString()
    },
    message: recoveryTarget.message
  };
}

function formatSecondsForLog(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
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
      const state = await loadPlaybackState();
      if (Number(state.currentSlot) !== Number(liveSong.slot)) return;
      if (state.pad?.active === true && state.pad?.source === "transition") return;
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
    const state = await loadPlaybackState();
    if (Number(state.currentSlot) !== Number(liveSong.slot)) return;
    if (state.pad?.active === true && state.pad?.source === "transition") return;
    await sendNativePlaybackCommand("markDynamicCuesTriggeredNow");
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
  await writeFile(CONFIRMED_SET_FILE, `${JSON.stringify(confirmed, null, 2)}\n`, "utf8");
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
    trimStartBar: positiveNumber(value.trimStartBar),
    trimStartBeat: positiveNumber(value.trimStartBeat),
    trimEndBar: positiveNumber(value.trimEndBar),
    trimEndBeat: positiveNumber(value.trimEndBeat),
    trimStartSeconds: nonNegativeNumber(value.trimStartSeconds),
    trimEndSeconds: nonNegativeNumber(value.trimEndSeconds),
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
      trimEndBeat: positiveNumber(block.trimEndBeat),
      trimStartSeconds: nonNegativeNumber(block.trimStartSeconds),
      trimEndSeconds: nonNegativeNumber(block.trimEndSeconds)
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

function songGridPositions(regions = [], cues = []) {
  const positions = [];
  for (const region of regions) {
    positions.push({ measure: region.startBar, beat: region.startBeat });
    positions.push({ measure: region.endBar, beat: region.endBeat });
  }
  for (const cue of cues) positions.push({ measure: cue.bar, beat: cue.beat });
  return positions;
}

function extendTempoMapForSongPositions(tempoMap, positions = []) {
  const beatGrid = Array.isArray(tempoMap?.beatGrid) ? tempoMap.beatGrid.map((beat) => ({ ...beat })) : [];
  if (!beatGrid.length || !Array.isArray(positions) || !positions.length) return tempoMap;
  const beatsPerMeasure = beatsPerMeasureForTempoMap(tempoMap);
  const positionValue = (position) => {
    const measure = Number(position?.measure);
    const beat = Number(position?.beat);
    if (!Number.isFinite(measure) || !Number.isFinite(beat)) return null;
    return ((measure - 1) * beatsPerMeasure) + (beat - 1);
  };
  const requested = Math.max(...positions.map(positionValue).filter((value) => value !== null));
  let last = beatGrid.at(-1);
  let lastPosition = positionValue({ measure: last?.measure, beat: last?.beat });
  if (!Number.isFinite(requested) || !Number.isFinite(lastPosition) || requested <= lastPosition) return tempoMap;
  const previous = beatGrid.slice(0, -1).reverse().find((beat) => Number.isFinite(Number(beat.timeSeconds)));
  const measuredInterval = previous ? Number(last.timeSeconds) - Number(previous.timeSeconds) : null;
  const beatInterval = measuredInterval && measuredInterval > 0
    ? measuredInterval
    : positiveNumber(tempoMap?.bpm)
      ? 60 / positiveNumber(tempoMap.bpm)
      : null;
  if (!beatInterval) return tempoMap;
  const extended = {
    ...tempoMap,
    source: `${tempoMap.source || "tempo-map"}+tail-grid`
  };
  let guard = 0;
  while (lastPosition < requested && guard < 64) {
    const nextBeat = Number(last.beat || last.beatInMeasure || 1) >= beatsPerMeasure ? 1 : Number(last.beat || last.beatInMeasure || 1) + 1;
    const nextMeasure = nextBeat === 1 ? Number(last.measure || 1) + 1 : Number(last.measure || 1);
    last = {
      index: Number(last.index || beatGrid.length) + 1,
      timeSeconds: Number((Number(last.timeSeconds || 0) + beatInterval).toFixed(6)),
      measure: nextMeasure,
      beat: nextBeat,
      globalBeat: Number.isFinite(Number(last.globalBeat)) ? Number(last.globalBeat) + 1 : beatGrid.length,
      isDownbeat: nextBeat === 1,
      isCountIn: false,
      tempoSegmentIndex: Number.isFinite(Number(last.tempoSegmentIndex)) ? Number(last.tempoSegmentIndex) : 0,
      confidence: positiveNumber(last.confidence)
    };
    beatGrid.push(last);
    lastPosition = positionValue({ measure: last.measure, beat: last.beat });
    guard += 1;
  }
  extended.beatGrid = beatGrid;
  return extended;
}

function beatsPerMeasureForTempoMap(tempoMap) {
  const signature = stringValue(tempoMap?.timeSignature || "4/4");
  const numerator = positiveNumber(signature.split("/")[0]);
  return Math.max(1, Math.floor(numerator || 4));
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
  const includeWaveforms = options.includeWaveforms === true;
  await mkdir(SET_METADATA_DIR, { recursive: true });
  const library = await loadLibrary();
  const slots = [];
  for (const slot of setlist.slots) {
    if (!slot.songId) continue;
    const song = (library.songs || []).find((item) => item.id === slot.songId);
    if (slot.folderPath || song?.folderPath) {
      await importSongMetadata(slot.folderPath || song.folderPath, { autoAnalyze: false });
    }
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
    await ensureSongCueAnalysis(slot, song, { allowAnalysis });
    await ensureSongDefaultMetadata(slot, song, { allowAnalysis });
    await migrateExistingSlotMetadataToSongDefaults(slot, files);
    const analyzerTempoMap = await readAnalyzerTempoMapForSlot(slot, song);
    await hydrateSlotRegionsFromDefaults(files.regions, await readSongDefaultRegions(slot));
    await hydrateSlotCuesFromDefaults(files.cues, await readSongDefaultCueMarkers(slot));
    await syncCueAnalysisToSlot(slot, files);
    await writeIfMissing(files.tempoMap, analyzerTempoMap);
    await ensureMixerMetadata(files.mixer, slot, library);
    if (includeWaveforms && slot.cachedStems?.length) {
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
  const cueReport = await readJsonFile(appCueRecognitionReportPath(folderPath), null);
  const currentSourceFingerprint = stringValue(cueReport?.sourceFingerprint);
  const currentCueFingerprint = cueMarkerDefaultsFingerprint(cueReport);

  let defaultCues = await readJsonFile(defaultCuesPath, null);
  if (
    !defaultCues
    || (!defaultCues.cueMarkers?.length && defaultCues.source === "empty-default")
    || analyzerDefaultNeedsRefresh(defaultCues, currentCueFingerprint)
  ) {
    defaultCues = await buildDefaultCueMarkersFromAnalysis(folderPath, slot.songId);
    if (defaultCues.cueMarkers?.length || allowAnalysis) {
      await writeFile(defaultCuesPath, `${JSON.stringify(defaultCues, null, 2)}\n`, "utf8");
    }
  }

  const defaultRegions = await readJsonFile(defaultRegionsPath, null);
  if (
    !defaultRegions
    || (!defaultRegions.regions?.length && defaultRegions.source === "empty-default")
    || analyzerDefaultNeedsRefresh(defaultRegions, currentSourceFingerprint)
  ) {
    const nextRegions = await buildDefaultRegionsFromAnalysis(folderPath, slot.songId);
    if (nextRegions.regions?.length || allowAnalysis) {
      await writeFile(defaultRegionsPath, `${JSON.stringify(nextRegions, null, 2)}\n`, "utf8");
    }
  } else {
    await writeIfMissing(defaultRegionsPath, { regions: [] });
  }
}

async function ensureSongCueAnalysis(slot, song, options = {}) {
  const allowAnalysis = options.allowAnalysis !== false;
  const folderPath = slot.folderPath || song?.folderPath || "";
  if (!folderPath) return;
  const reportPath = appCueRecognitionReportPath(folderPath);
  const mapPath = appDynamicCueMapPath(folderPath);
  const currentReport = await readJsonFile(reportPath, null);
  const currentMap = await readJsonFile(mapPath, null);
  const sourceReport = await cueReportFromSourceCueIntelligence(folderPath, slot);
  if (
    sourceReport
    && (
      currentReport?.songId !== slot.songId
      || currentMap?.songId !== slot.songId
      || currentReport?.sourceFingerprint !== sourceReport.sourceFingerprint
    )
  ) {
    const settings = await loadSettings();
    const timedReport = await cueReportWithSongTiming(sourceReport, folderPath, slot);
    const dynamicCueMap = await buildDynamicCueMapFromCandidates(timedReport, settings.dynamicCue.folderPath);
    await writeFile(reportPath, `${JSON.stringify(timedReport, null, 2)}\n`, "utf8");
    await writeFile(mapPath, `${JSON.stringify(dynamicCueMap, null, 2)}\n`, "utf8");
    return;
  }
  if (
    currentReport?.songId === slot.songId
    && currentMap?.songId === slot.songId
    && currentReport.candidates?.length
    && Array.isArray(currentReport.regionCandidates)
  ) return;
  if (!allowAnalysis) return;

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
    timeSignature: slot.timeSignature || "",
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

async function cueReportFromSourceCueIntelligence(folderPath, slot) {
  const sourcePath = join(folderPath, "analysis", "cue-intelligence.json");
  let source;
  try {
    source = await readJsonFile(sourcePath, null);
  } catch {
    return null;
  }
  if (!source || !Array.isArray(source.markers) || !source.markers.length) return null;
  const sourceFingerprint = await fileSha1(sourcePath);
  const candidates = source.markers
    .filter((marker) => marker && (marker.label || marker.target || marker.normalizedText))
    .map((marker, index) => ({
      id: stringValue(marker.id || `cue_${index + 1}`),
      rawTranscript: stringValue(marker.heardText || marker.rawTranscript || marker.label),
      status: ["trusted", "verified"].includes(stringValue(marker.status)) ? "trusted" : stringValue(marker.status || "review"),
      label: stringValue(marker.label || marker.target || marker.normalizedText),
      normalizedPhrase: stringValue(marker.normalizedText || marker.label || marker.target),
      command: stringValue(marker.command || marker.phraseRecognition?.command || "normal"),
      confidence: positiveNumber(marker.confidence) || positiveNumber(marker.labelConfidence) || 0,
      spokenAtSeconds: nonNegativeNumber(marker.heardTimeSeconds ?? marker.spokenAtSeconds),
      sectionWordAtSeconds: nonNegativeNumber(marker.sectionWordAtSeconds),
      targetMeasure: positiveNumber(marker.targetMeasure || marker.snappedMeasure),
      targetBeat: positiveNumber(marker.targetBeatInMeasure || marker.targetBeat || marker.snappedBeatInMeasure),
      snappedMeasure: positiveNumber(marker.snappedMeasure || marker.targetMeasure),
      snappedBeat: positiveNumber(marker.snappedBeatInMeasure || marker.snappedBeat || marker.targetBeatInMeasure),
      gridStatus: stringValue(marker.alignmentStatus || marker.status),
      rejectionReasons: Array.isArray(marker.phraseRecognition?.rejectionReasons) ? marker.phraseRecognition.rejectionReasons.map(stringValue).filter(Boolean) : [],
      words: []
    }));
  const regions = source.inferredRegions && Array.isArray(source.inferredRegions.regions) ? source.inferredRegions.regions : [];
  const regionCandidates = regions.map((region, index) => ({
    id: stringValue(region.id || `region_${index + 1}`),
    sourceCueCandidateId: stringValue(region.sourceCueCandidateId || candidates[index]?.id || `cue_${index + 1}`),
    sourceCueText: stringValue(region.name || candidates[index]?.label),
    status: ["trusted", "verified", "draft"].includes(stringValue(region.status)) ? "verified" : stringValue(region.status || "review"),
    cueMeasure: positiveNumber(candidates[index]?.targetMeasure),
    cueBeat: positiveNumber(candidates[index]?.targetBeat),
    startMeasure: positiveNumber(region.startMeasure || region.startBar),
    startBeat: positiveNumber(region.startBeat),
    leadInMeasures: 0,
    gridBeats: positiveNumber(source.gridReference?.timeSignature?.gridBeatsPerMeasure),
    reason: stringValue(region.source || "cue-intelligence")
  })).filter((candidate) => candidate.id && candidate.startMeasure && candidate.startBeat);
  return {
    generatedAt: new Date().toISOString(),
    slot: slot.slot,
    songId: slot.songId,
    analyzerSongId: stringValue(source.songId),
    title: slot.title,
    sourceFolder: folderPath,
    sourceFile: "analysis/cue-intelligence.json",
    sourceFingerprint,
    recognizer: stringValue(source.speechEngine?.cueRecognizer || source.speechEngine?.cueProvider || "vosk-closed-grammar"),
    voskStatus: stringValue(source.speechEngine?.voskStatus),
    status: stringValue(source.status || "trusted"),
    summary: source.summary || {},
    gridReference: source.gridReference || null,
    source: source.source || null,
    candidates,
    regionCandidates
  };
}

async function rehydrateCurrentSetMetadata(options = {}) {
  const includeWaveforms = options.includeWaveforms === true;
  const setlist = await loadCurrentSetlist();
  const filledSlots = (setlist.slots || []).filter((slot) => slot.songId);
  const cleared = [];
  for (const slot of filledSlots) {
    const slotDir = join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
    const songDir = appSongMetadataDir(slot.folderPath);
    const paths = [
      join(slotDir, "cue-markers.json"),
      join(slotDir, "regions.json"),
      join(slotDir, "cue-recognition-report.json"),
      join(slotDir, "dynamic-cue-map.json"),
      join(slotDir, "slot-info.json"),
      appDefaultCueMarkersPath(slot.folderPath),
      appDefaultRegionsPath(slot.folderPath),
      appCueRecognitionReportPath(slot.folderPath),
      appDynamicCueMapPath(slot.folderPath)
    ];
    if (includeWaveforms) paths.push(join(slotDir, "waveform-summary.json"));
    for (const filePath of paths) {
      const current = await readJsonFile(filePath, null);
      if (metadataMapIsOperatorApproved(current)) continue;
      await rm(filePath, { force: true });
      cleared.push(filePath);
    }
  }
  await ensureSetMetadata(setlist, { allowAnalysis: false, includeWaveforms });
  return {
    ok: true,
    rehydratedAt: new Date().toISOString(),
    slotCount: filledSlots.length,
    clearedCount: cleared.length,
    cleared,
    audit: await auditCurrentSetMetadata()
  };
}

async function auditCurrentSetMetadata() {
  const setlist = await loadCurrentSetlist();
  const rows = [];
  for (const slot of (setlist.slots || []).filter((item) => item.songId)) {
    const slotDir = join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
    const rawSource = await readJsonFile(join(slot.folderPath, "analysis", "cue-intelligence.json"), null);
    const source = rawSource ? await cueReportWithSongTiming(cueIntelligenceSourceToReport(rawSource, slot), slot.folderPath, slot) : null;
    const appCueMap = await readJsonFile(join(slotDir, "cue-markers.json"), { cueMarkers: [] });
    const appRegionMap = await readJsonFile(join(slotDir, "regions.json"), { regions: [] });
    const appCues = appCueMap.cueMarkers || [];
    const appRegions = appRegionMap.regions || [];
    const approvedOverride = metadataMapIsOperatorApproved(appCueMap) || metadataMapIsOperatorApproved(appRegionMap);
    const sourceCues = (source?.candidates || [])
      .filter((candidate) => ["trusted", "review", "verified"].includes(stringValue(candidate.status)))
      .map((candidate, index) => cueMarkerFromAnalysisCandidate(candidate, source, index));
    const sourceRegions = buildDefaultRegionsFromReport(source || {}).regions || [];
    const firstAppCue = appCues[0] || null;
    const firstSourceCue = sourceCues[0] || null;
    const firstAppRegion = appRegions[0] || null;
    const firstSourceRegion = sourceRegions[0] || null;
    const appCuePosition = firstAppCue ? `${firstAppCue.bar}.${firstAppCue.beat}` : "";
    const sourceCuePosition = firstSourceCue ? `${firstSourceCue.bar}.${firstSourceCue.beat}` : "";
    const appRegionPosition = firstAppRegion ? `${firstAppRegion.startBar}.${firstAppRegion.startBeat}-${firstAppRegion.endBar}.${firstAppRegion.endBeat}` : "";
    const sourceRegionPosition = firstSourceRegion ? `${firstSourceRegion.startBar}.${firstSourceRegion.startBeat}-${firstSourceRegion.endBar}.${firstSourceRegion.endBeat}` : "";
    const cueCountOk = appCues.length === sourceCues.length;
    const regionCountOk = appRegions.length === sourceRegions.length;
    const cuePositionOk = appCuePosition === sourceCuePosition;
    const regionPositionOk = appRegionPosition === sourceRegionPosition;
    const ok = Boolean(source && cueCountOk && regionCountOk && cuePositionOk && regionPositionOk);
    rows.push({
      slot: slot.slot,
      songId: slot.songId,
      title: slot.title,
      status: ok ? "ok" : approvedOverride ? "approved-override" : "mismatch",
      sourceExists: Boolean(source),
      approvedOverride,
      cueCountOk,
      regionCountOk,
      cuePositionOk,
      regionPositionOk,
      appCueCount: appCues.length,
      sourceCueCount: sourceCues.length,
      appRegionCount: appRegions.length,
      sourceRegionCount: sourceRegions.length,
      appFirstCue: appCuePosition,
      sourceFirstCue: sourceCuePosition,
      appFirstRegion: appRegionPosition,
      sourceFirstRegion: sourceRegionPosition
    });
  }
  const mismatches = rows.filter((row) => row.status === "mismatch");
  const approvedOverrides = rows.filter((row) => row.status === "approved-override");
  return {
    ok: mismatches.length === 0,
    checkedAt: new Date().toISOString(),
    checked: rows.length,
    mismatchCount: mismatches.length,
    approvedOverrideCount: approvedOverrides.length,
    rows,
    mismatches,
    approvedOverrides
  };
}

function cueIntelligenceSourceToReport(source, slot = {}) {
  if (!source || typeof source !== "object") return source;
  if (Array.isArray(source.candidates)) return source;
  const markers = Array.isArray(source.markers) ? source.markers : [];
  return {
    generatedAt: stringValue(source.generatedAt || source.updatedAt) || new Date().toISOString(),
    slot: slot.slot,
    songId: slot.songId || stringValue(source.songId),
    analyzerSongId: stringValue(source.songId),
    title: slot.title || stringValue(source.title),
    sourceFolder: slot.folderPath || stringValue(source.sourceFolder),
    sourceFile: "analysis/cue-intelligence.json",
    sourceFingerprint: stringValue(source.sourceFingerprint || source.fingerprint) || createHash("sha1").update(JSON.stringify(markers)).digest("hex"),
    recognizer: stringValue(source.speechEngine?.cueRecognizer || source.speechEngine?.cueProvider || source.recognizer || "vosk-closed-grammar"),
    status: stringValue(source.status || "trusted"),
    summary: source.summary || {},
    gridReference: source.gridReference || null,
    source: source.source || null,
    inferredRegions: source.inferredRegions || null,
    timeSignature: stringValue(source.timeSignature || source.gridReference?.timeSignature),
    candidates: markers.map((marker, index) => ({
      id: stringValue(marker.id || `cue_${index + 1}`),
      rawTranscript: stringValue(marker.heardText || marker.rawTranscript || marker.label),
      status: ["trusted", "verified"].includes(stringValue(marker.status)) ? "trusted" : stringValue(marker.status || "review"),
      label: stringValue(marker.label || marker.target || marker.normalizedText),
      normalizedPhrase: stringValue(marker.normalizedText || marker.label || marker.target),
      command: stringValue(marker.command || marker.phraseRecognition?.command || "normal"),
      confidence: positiveNumber(marker.confidence?.overall) || positiveNumber(marker.confidence) || positiveNumber(marker.labelConfidence) || 0,
      spokenAtSeconds: nonNegativeNumber(marker.heardTimeSeconds ?? marker.spokenAtSeconds),
      sectionWordAtSeconds: nonNegativeNumber(marker.sectionWordAtSeconds),
      targetMeasure: positiveNumber(marker.targetMeasure || marker.snappedMeasure),
      targetBeat: positiveNumber(marker.targetBeatInMeasure || marker.targetBeat || marker.snappedBeatInMeasure || marker.snappedBeat),
      snappedMeasure: positiveNumber(marker.snappedMeasure || marker.targetMeasure),
      snappedBeat: positiveNumber(marker.snappedBeatInMeasure || marker.snappedBeat || marker.targetBeatInMeasure || marker.targetBeat),
      gridStatus: stringValue(marker.alignmentStatus || marker.status),
      rejectionReasons: Array.isArray(marker.phraseRecognition?.rejectionReasons) ? marker.phraseRecognition.rejectionReasons.map(stringValue).filter(Boolean) : [],
      words: []
    })),
    regionCandidates: []
  };
}

async function triggerPanicRecoveryCue(liveSong, payload = {}) {
  const recoveryRegion = recoveryRegionFromPayload(liveSong, payload);
  const regionName = stringValue(recoveryRegion?.name || payload.regionName).trim();
  if (!regionName) {
    const result = { ok: false, regionName: "", error: "No recovery region was resolved." };
    console.warn(`[panic-recovery] ${result.error}`);
    return result;
  }
  const cueProgram = await recoveryCueCommandPayload(regionName);
  if (!cueProgram.ok || !cueProgram.commands.length) {
    const result = { ok: false, regionName, error: cueProgram.error || `No recovery cue WAV matched "${regionName}".` };
    console.warn(`[panic-recovery] ${result.error}`);
    return result;
  }
  const markResult = await requestNativePlaybackCommand("markDynamicCuesTriggeredNow", {}, { timeoutMs: 1200 });
  if (!markResult.ok) {
    const result = { ok: false, regionName, error: markResult.error || "Could not mark scheduled cues before recovery." };
    console.warn(`[panic-recovery] ${result.error}`);
    return result;
  }
  if (!payload.keepScheduledCuesSuppressed) {
    await requestNativePlaybackCommand("setScheduledDynamicCuesSuppressed", { suppressed: false }, { timeoutMs: 1200 });
  }
  const mixerResult = await requestNativePlaybackCommand("updateDynamicMixer", {
    dynamicClick: liveSong.dynamicClick || null,
    dynamicCue: liveSong.dynamicCue || null,
    dynamicPad: { ...(liveSong.dynamicPad || {}), active: true }
  }, { timeoutMs: 1200 });
  if (!mixerResult.ok) {
    const result = { ok: false, regionName, error: mixerResult.error || "Could not route dynamic cue for recovery." };
    console.warn(`[panic-recovery] ${result.error}`);
    return result;
  }
  await sleep(80);
  const triggered = [];
  for (const command of cueProgram.commands) {
    const result = await requestNativePlaybackCommand("triggerCue", command, { timeoutMs: 1500 });
    if (!result.ok) {
      const error = `cue failed: ${command.cueName || command.cueId || "unknown"} ${result.error || ""}`.trim();
      console.warn(`[panic-recovery] ${error}`);
      return { ok: false, regionName, triggered, error };
    }
    triggered.push(command.cueName || command.cueId || "cue");
    await sleep(command.delayAfterMs ?? 450);
  }
  const restoreResult = await requestNativePlaybackCommand("updateDynamicMixer", {
    dynamicClick: liveSong.dynamicClick || null,
    dynamicCue: liveSong.dynamicCue || null,
    dynamicPad: { ...(liveSong.dynamicPad || {}), active: true }
  }, { timeoutMs: 1200 });
  if (!restoreResult.ok) {
    console.warn(`[panic-recovery] dynamic mixer restore failed: ${restoreResult.error || "unknown"}`);
  }
  console.log(`[panic-recovery] fired ${triggered.join(" + ")} for ${regionName}`);
  return { ok: true, regionName, triggered };
}

async function migrateExistingSlotMetadataToSongDefaults(slot, files) {
  if (!slot.folderPath) return;
  // Slot cue/region files are working cache. Only explicit operator approvals become reusable song defaults.
  await copyCueAnalysisIfSongMatches(slot, files);
}

async function readSongDefaultRegions(slot) {
  const folderPath = slot.folderPath || "";
  const approved = await readJsonFile(appApprovedRegionsPath(slot.songId), null);
  if (approved?.approved === true && approved?.regions?.length) return approved;
  return await readJsonFile(appDefaultRegionsPath(folderPath), { regions: [] });
}

async function readSongDefaultCueMarkers(slot) {
  const folderPath = slot.folderPath || "";
  const approved = await readJsonFile(appApprovedCueMarkersPath(slot.songId), null);
  if (approved?.approved === true && approved?.cueMarkers?.length) return approved;
  return await readJsonFile(appDefaultCueMarkersPath(folderPath), { cueMarkers: [], dynamicCueMatching: "fuzzy-name" });
}

async function buildDefaultCueMarkersFromAnalysis(folderPath, expectedSongId = "") {
  const report = await cueReportWithSongTiming(
    await readJsonFile(appCueRecognitionReportPath(folderPath), null),
    folderPath
  );
  if (expectedSongId && report?.songId !== expectedSongId) {
    return {
      cueMarkers: [],
      dynamicCueMatching: "fuzzy-name",
      source: "empty-default"
    };
  }
  const cueMarkers = (report?.candidates || [])
    .filter((candidate) => ["trusted", "review"].includes(candidate.status))
    .map((candidate, index) => cueMarkerFromAnalysisCandidate(candidate, report, index))
    .filter((cue) => cue.name && cue.bar > 0 && cue.beat > 0);
  return {
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: cueMarkers.length ? "dynamic-cue-analysis" : "empty-default",
    sourceFingerprint: cueMarkerDefaultsFingerprint(report),
    updatedAt: new Date().toISOString()
  };
}

function cueMarkerDefaultsFingerprint(report) {
  const source = stringValue(report?.sourceFingerprint);
  return source ? `${source}:${CUE_MARKER_RULE_VERSION}` : CUE_MARKER_RULE_VERSION;
}

async function cueReportWithSongTiming(report, folderPath, slot = {}) {
  if (!report || typeof report !== "object") return report;
  const currentSignature = cueReportTimeSignature(report);
  if (currentSignature && currentSignature !== "4/4") return report;
  const metadata = folderPath ? await readSongMetadata(folderPath) : {};
  const timeSignature = stringValue(slot.timeSignature || metadata.timeSignature || report.timeSignature || currentSignature || "4/4");
  return {
    ...report,
    sourceFolder: report.sourceFolder || folderPath || "",
    timeSignature
  };
}

function cueMarkerFromAnalysisCandidate(candidate, report, index) {
  const timing = cueTimingContextForReport(report);
  const position = sectionCuePositionFromReport(candidate, report, timing);
  return {
    id: `cue-${candidate.id || index + 1}`,
    name: cueMarkerName(candidate, index),
    bar: position.bar,
    beat: position.beat
  };
}

function sectionCuePositionFromReport(candidate, report, timing = cueTimingContextForReport(report)) {
  return {
    bar: positiveNumber(candidate.snappedMeasure || candidate.targetMeasure) || 1,
    beat: positiveNumber(candidate.snappedBeat || candidate.targetBeat) || 1
  };
}

function findRegionCandidateForCue(candidate, report) {
  const cueId = stringValue(candidate?.id);
  const regions = Array.isArray(report?.regionCandidates) ? report.regionCandidates : [];
  return regions.find((region) => {
    return region.status === "verified"
      && region.startMeasure
      && region.startBeat
      && stringValue(region.sourceCueCandidateId || region.id) === cueId;
  });
}

function cueTimingContextForReport(report) {
  const signature = cueReportTimeSignature(report);
  const beatsPerMeasure = beatsPerMeasureForTimeSignature(signature);
  return {
    timeSignature: signature,
    beatsPerMeasure,
    sectionCueLeadBeats: signature.startsWith("6/8") ? 6 : 4
  };
}

function cueReportTimeSignature(report) {
  const values = [
    report?.timeSignature,
    report?.gridReference?.timeSignature,
    report?.summary?.timeSignature,
    report?.metadata?.timeSignature
  ];
  for (const value of values) {
    const display = displayTimeSignature(value);
    if (display) return display;
  }
  return "4/4";
}

function beatsPerMeasureForTimeSignature(signature) {
  const match = stringValue(signature || "4/4").match(/^(\d+)\s*\//);
  return positiveNumber(match?.[1]) || 4;
}

function shiftBarBeatByBeats(bar, beat, beatOffset, beatsPerMeasure) {
  const beatsInMeasure = positiveNumber(beatsPerMeasure) || 4;
  const startIndex = ((positiveNumber(bar) || 1) - 1) * beatsInMeasure + ((positiveNumber(beat) || 1) - 1);
  const shifted = Math.max(0, startIndex + beatOffset);
  return {
    bar: Math.floor(shifted / beatsInMeasure) + 1,
    beat: (shifted % beatsInMeasure) + 1
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
  if (metadataMapIsOperatorWorkingDraft(current)) {
    return;
  }
  const needsRefresh = analyzerDefaultNeedsRefresh(current, stringValue(defaults?.sourceFingerprint));
  if (current?.regions?.length && !needsRefresh) {
    return;
  }
  if (!needsRefresh && (current?.regions?.length || !defaults?.regions?.length)) {
    await writeIfMissing(filePath, defaults || { regions: [] });
    return;
  }
  await writeFile(filePath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
}

async function hydrateSlotCuesFromDefaults(filePath, defaults) {
  const current = await readJsonFile(filePath, null);
  if (metadataMapIsOperatorWorkingDraft(current)) {
    return;
  }
  const needsRefresh = analyzerDefaultNeedsRefresh(current, stringValue(defaults?.sourceFingerprint));
  if (current?.cueMarkers?.length && !needsRefresh) {
    return;
  }
  if (!needsRefresh && (current?.cueMarkers?.length || !defaults?.cueMarkers?.length)) {
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
  const currentRegions = await readJsonFile(files.regions, null);
  const currentCues = await readJsonFile(files.cues, null);
  if (metadataMapIsOperatorWorkingDraft(currentRegions)) {
    await markWorkingDraftSourceChange(files.regions, currentRegions, current?.sourceMetadataFingerprint, sourceMetadataFingerprint);
  } else {
    await rm(files.regions, { force: true });
  }
  if (metadataMapIsOperatorWorkingDraft(currentCues)) {
    await markWorkingDraftSourceChange(files.cues, currentCues, current?.sourceMetadataFingerprint, sourceMetadataFingerprint);
  } else {
    await rm(files.cues, { force: true });
  }
  await rm(files.tempoMap, { force: true });
  await rm(files.mixer, { force: true });
  await rm(files.waveform, { force: true });
  await rm(files.cueRecognition, { force: true });
  await rm(files.dynamicCueMap, { force: true });
}

async function markWorkingDraftSourceChange(filePath, current, previousFingerprint, currentFingerprint) {
  if (!currentFingerprint || stringValue(previousFingerprint) === stringValue(currentFingerprint)) return;
  await writeFile(filePath, `${JSON.stringify({
    ...current,
    sourceMetadataChangedUnderDraft: true,
    previousSourceMetadataFingerprint: stringValue(previousFingerprint),
    currentSourceMetadataFingerprint: stringValue(currentFingerprint),
    sourceMetadataChangedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function songMetadataFingerprintForSlot(slot) {
  if (!slot?.folderPath) return "";
  return sourceMetadataFingerprintForSongFolder(slot.folderPath);
}

async function sourceMetadataFingerprintForSongFolder(songFolder) {
  const hash = createHash("sha1");
  let found = false;
  const sourceFiles = [
    join(songFolder, "song-metadata.json"),
    join(songFolder, "analysis", "cue-intelligence.json"),
    join(songFolder, "analysis", "grid-analysis.json")
  ];
  for (const sourceFile of sourceFiles) {
    try {
      hash.update(sourceFile);
      hash.update(await readFile(sourceFile));
      found = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return found ? hash.digest("hex") : "";
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
    "derived-from-analyzer-region-candidates",
    "analyzer-cue-phrase-marker-refresh"
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
    originalKey: slot.originalKey || slot.key || "",
    selectedKey: slot.selectedKey || slot.key || "",
    transposeCents: Number(slot.transposeCents || 0),
    padKey: slot.padKey || slot.key || "",
    bpm: slot.bpm || null,
    timeSignature: slot.timeSignature || ""
  }));
  const transitions = normalizeSetlistTransitions(setlist.transitions, setlist.slots)
    .map((transition) => ({
      fromSlot: transition.fromSlot,
      toSlot: transition.toSlot,
      mode: transition.mode,
      padBehavior: transition.padBehavior,
      continuePad: transition.continuePad,
      durationSeconds: transition.durationSeconds
  }));
  return createHash("sha1").update(JSON.stringify({ slots: payload, transitions })).digest("hex");
}

function normalizeSetlist(value = {}) {
  value = value && typeof value === "object" ? value : {};
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const slotCount = Math.max(10, slots.length);
  const normalizedSlots = Array.from({ length: slotCount }, (_, index) => normalizeSetlistSlot(slots[index], index));
  return {
    id: "current",
    name: "Current Set",
    slotCount,
    updatedAt: new Date().toISOString(),
    slots: normalizedSlots,
    transitions: normalizeSetlistTransitions(value.transitions, normalizedSlots)
  };
}

function normalizeSetlistTransitions(value, slots = []) {
  const filled = (slots || [])
    .filter((slot) => slot?.songId)
    .map((slot) => Number(slot.slot))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const adjacentPairs = [];
  for (let index = 0; index < filled.length - 1; index += 1) {
    adjacentPairs.push({ fromSlot: filled[index], toSlot: filled[index + 1] });
  }
  const existingByPair = new Map((Array.isArray(value) ? value : [])
    .map((transition) => normalizeSetlistTransition(transition))
    .filter(Boolean)
    .map((transition) => [`${transition.fromSlot}:${transition.toSlot}`, transition]));
  return adjacentPairs.map((pair) => normalizeSetlistTransition({
    ...existingByPair.get(`${pair.fromSlot}:${pair.toSlot}`),
    fromSlot: pair.fromSlot,
    toSlot: pair.toSlot
  }));
}

function normalizeSetlistTransition(value = {}) {
  const fromSlot = positiveNumber(value.fromSlot);
  const toSlot = positiveNumber(value.toSlot);
  if (!fromSlot || !toSlot || fromSlot === toSlot) return null;
  const mode = TRANSITION_MODES.has(value.mode) ? value.mode : "cue-next";
  const padBehavior = TRANSITION_PAD_BEHAVIORS.has(value.padBehavior) ? value.padBehavior : "next-song-key";
  return {
    fromSlot,
    toSlot,
    mode,
    padBehavior,
    durationSeconds: positiveNumber(value.durationSeconds) || 5,
    continuePad: value.continuePad !== false
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
    originalKey: stringValue(slot.originalKey || slot.key),
    selectedKey: stringValue(slot.selectedKey || slot.key),
    transposeCents: Number.isFinite(Number(slot.transposeCents)) ? Number(slot.transposeCents) : 0,
    padKey: stringValue(slot.padKey || slot.key),
    bpm: positiveNumber(slot.bpm),
    timeSignature: stringValue(slot.timeSignature),
    trackCount: positiveNumber(slot.trackCount),
    metadataVersionInfo: normalizeMetadataVersionInfo(slot.metadataVersionInfo),
    cacheStatus: stringValue(slot.cacheStatus),
    cacheFolder: stringValue(slot.cacheFolder),
    cachedTrackCount: positiveNumber(slot.cachedTrackCount),
    cachedAt: stringValue(slot.cachedAt),
    keyChangeCache: slot.keyChangeCache && typeof slot.keyChangeCache === "object" ? slot.keyChangeCache : null,
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
        key: canonicalMajorKey(slot.selectedKey || song.key) || song.key,
        originalKey: canonicalMajorKey(song.key) || song.key,
        selectedKey: canonicalMajorKey(slot.selectedKey || song.key) || song.key,
        transposeCents: effectiveTransposeCents(song.key, slot.selectedKey || song.key, slot.transposeCents),
        padKey: canonicalMajorKey(slot.selectedKey || song.padKey || song.key) || song.padKey || song.key,
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
    transposeCached: Boolean(stem.transposeCached),
    transposeCents: Number.isFinite(Number(stem.transposeCents)) ? Number(stem.transposeCents) : 0,
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
      const cache = await cacheSongForSetlistSlot(song, slot);
      preparedSlots.push({
        ...slot,
        folderPath: song.folderPath,
        key: cache.selectedKey || slot.key || song.key,
        originalKey: cache.originalKey || slot.originalKey || song.key,
        selectedKey: cache.selectedKey || slot.selectedKey || song.key,
        transposeCents: Number(cache.transposeCents || 0),
        padKey: cache.selectedKey || slot.padKey || song.padKey || song.key,
        trackCount: cache.expectedTrackCount,
        cacheStatus: cache.missingStems.length ? "cached-with-warnings" : "cached",
        readinessState: cache.missingStems.length ? "warning" : "ready",
        cacheFolder: cache.cacheFolder,
        cachedTrackCount: cache.cachedTrackCount,
        keyChangeCache: cache.keyChangeCache,
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

async function updateSetlistSlotKey(slotNumber, selectedKeyInput) {
  if (!slotNumber) throw new Error("A setlist slot is required for key change.");
  const playback = await loadPlaybackState();
  if (playback.mode === "performance") {
    throw new Error("Leave Performance Mode before changing a song key.");
  }
  const selectedKey = canonicalMajorKey(selectedKeyInput);
  if (!selectedKey) throw new Error("Choose a valid song key.");
  const setlist = await loadCurrentSetlist();
  const library = await loadLibrary();
  const slot = (setlist.slots || []).find((item) => Number(item.slot) === Number(slotNumber) && item.songId);
  if (!slot) throw new Error(`Setlist slot ${slotNumber} is empty.`);
  const song = (library.songs || []).find((item) => item.id === slot.songId);
  if (!song) throw new Error("Song is no longer available in the library.");
  const originalKey = canonicalMajorKey(slot.originalKey || song.key || slot.key);
  const transposeCents = effectiveTransposeCents(originalKey, selectedKey);
  const next = normalizeSetlist({
    ...setlist,
    slots: (setlist.slots || []).map((item) => Number(item.slot) === Number(slotNumber)
      ? {
          ...item,
          key: selectedKey,
          originalKey,
          selectedKey,
          transposeCents,
          padKey: selectedKey
        }
      : item)
  });
  const prepared = await prepareSetlistCache(next, { slotNumbers: [slotNumber] });
  await saveCurrentSetlist(prepared);
  await ensureSetMetadata(prepared, { allowAnalysis: false });
  await cleanupSetlistGeneratedArtifacts(prepared);
  await markSetUnconfirmed(prepared);
  await refreshEngineManifestForMixer();
  return prepared;
}

async function cacheSongForSetlistSlot(song, slot) {
  const slotNumber = positiveNumber(slot?.slot) || 1;
  const tracks = Array.isArray(song.tracks) ? song.tracks : [];
  if (!tracks.length) {
    throw new Error("No metadata WAV files found for song.");
  }
  const alignment = await readSongAudioAlignment(song.folderPath);
  const originalKey = canonicalMajorKey(slot.originalKey || song.key || "");
  const selectedKey = canonicalMajorKey(slot.selectedKey || slot.key || song.key || "") || originalKey;
  const transposeCents = effectiveTransposeCents(originalKey, selectedKey, slot.transposeCents);
  const keyChange = await prepareKeyChangeCacheForSong(song, {
    originalKey,
    selectedKey,
    transposeCents,
    sampleRate: positiveNumber((await loadSettings()).audioEngine?.sampleRate) || 48000
  });
  const cacheFolder = resolve(CACHE_DIR, "current-setlist", `slot-${String(slotNumber).padStart(2, "0")}-${song.id}`);
  assertInsideCache(cacheFolder);
  await rm(cacheFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(cacheFolder, { recursive: true });

  const missingStems = [];
  const cachedStems = [];
  let cachedTrackCount = 0;
  for (const track of tracks) {
    const keyChangedTrack = keyChange.tracksById.get(track.id) || keyChange.tracksById.get(track.relativePath) || null;
    const sourcePath = keyChangedTrack?.filePath || resolve(song.folderPath, track.relativePath);
    const targetPath = resolve(cacheFolder, track.relativePath);
    try {
      if (keyChangedTrack) assertInsideKeyCache(sourcePath);
      else assertInsideRoot(sourcePath);
      assertInsideCache(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      const shifted = await applyWavShiftIfNeeded(targetPath, alignment.shiftSeconds);
      cachedTrackCount += 1;
      cachedStems.push({
        ...trackSummary(track),
        transposeCached: Boolean(keyChangedTrack),
        transposeCents,
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
    originalKey,
    selectedKey,
    transposeCents,
    keyChangeCache: keyChange.summary,
    expectedTrackCount: tracks.length,
    cachedTrackCount,
    missingStems,
    cachedStems,
    cachedAt: new Date().toISOString()
  };
}

async function prepareKeyChangeCacheForSong(song, context) {
  const transposeCents = Number(context.transposeCents || 0);
  const originalKey = canonicalMajorKey(context.originalKey || song.key || "");
  const selectedKey = canonicalMajorKey(context.selectedKey || song.key || "") || originalKey;
  const transposableTracks = (song.tracks || []).filter(shouldTransposeTrackForKeyChange);
  if (!song.id || Math.abs(transposeCents) < 0.01 || !transposableTracks.length) {
    return {
      tracksById: new Map(),
      summary: {
        active: false,
        reason: Math.abs(transposeCents) < 0.01 ? "original-key" : "no-transposable-stems",
        originalKey,
        selectedKey,
        transposeCents
      }
    };
  }

  const ffmpeg = await firstExistingFile(FFMPEG_EXE_CANDIDATES);
  if (!ffmpeg) throw new Error("FFmpeg with Rubber Band is required for key changes.");
  const cacheFolder = resolve(KEY_CACHE_DIR, song.id, keyCacheFolderName(selectedKey, transposeCents));
  assertInsideKeyCache(cacheFolder);
  const manifestPath = join(cacheFolder, "preparation-manifest.json");
  await mkdir(cacheFolder, { recursive: true });
  const sourceManifest = await keyChangeSourceManifest(song, transposableTracks, context.sampleRate, originalKey, selectedKey, transposeCents);
  const existing = await readJsonFile(manifestPath, null);
  const tracksById = new Map();
  if (existing?.fingerprint === sourceManifest.fingerprint && Array.isArray(existing.generatedFiles)) {
    for (const file of existing.generatedFiles) {
      const filePath = resolve(cacheFolder, file.relativePath);
      assertInsideKeyCache(filePath);
      try {
        await stat(filePath);
        tracksById.set(file.id, { filePath });
        tracksById.set(file.relativePath, { filePath });
      } catch {
        tracksById.clear();
        break;
      }
    }
    if (tracksById.size) {
      return {
        tracksById,
        summary: {
          active: true,
          reused: true,
          originalKey,
          selectedKey,
          transposeCents,
          cacheFolder,
          manifestPath,
          renderedCount: existing.generatedFiles.length
        }
      };
    }
  }

  const tempFolder = `${cacheFolder}.generating`;
  assertInsideKeyCache(tempFolder);
  await rm(tempFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(tempFolder, { recursive: true });
  const generatedFiles = [];
  for (const track of transposableTracks) {
    const sourcePath = resolve(song.folderPath, track.relativePath);
    assertInsideRoot(sourcePath);
    const relativePath = track.relativePath;
    const outputPath = resolve(tempFolder, relativePath);
    assertInsideKeyCache(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await renderTransposedWav({ ffmpeg, sourcePath, outputPath, sampleRate: context.sampleRate, transposeCents });
    generatedFiles.push({
      id: track.id,
      relativePath,
      sourceRelativePath: track.relativePath,
      sha1: await fileSha1(outputPath)
    });
  }
  const manifest = {
    schema: "playback-v2-key-change-cache",
    version: 1,
    generator: KEY_CHANGE_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    songId: song.id,
    title: song.title,
    originalKey,
    selectedKey,
    transposeCents,
    sampleRate: context.sampleRate,
    fingerprint: sourceManifest.fingerprint,
    sources: sourceManifest.sources,
    generatedFiles
  };
  await writeFile(join(tempFolder, "preparation-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(cacheFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rename(tempFolder, cacheFolder);
  for (const file of generatedFiles) {
    const filePath = resolve(cacheFolder, file.relativePath);
    tracksById.set(file.id, { filePath });
    tracksById.set(file.relativePath, { filePath });
  }
  return {
    tracksById,
    summary: {
      active: true,
      reused: false,
      generated: true,
      originalKey,
      selectedKey,
      transposeCents,
      cacheFolder,
      manifestPath,
      renderedCount: generatedFiles.length
    }
  };
}

function shouldTransposeTrackForKeyChange(track) {
  const role = stringValue(track.playbackRole).toLowerCase();
  const group = stringValue(track.stemGroup).toLowerCase();
  const bus = canonicalBus(track.bus || "");
  if (track.playLive === false) return false;
  if (["click-reference", "cue-reference"].includes(role)) return false;
  if (["click", "cues", "dynamiccue"].includes(bus.toLowerCase())) return false;
  if (/\b(click|cue|cues|guide|guides|count|countoff|metronome|talkback|utility)\b/i.test(group)) return false;
  return role === "music-stem" || bus === "tracks" || bus === "pads" || !bus;
}

async function keyChangeSourceManifest(song, tracks, sampleRate, originalKey, selectedKey, transposeCents) {
  const sources = [];
  for (const track of tracks) {
    const sourcePath = resolve(song.folderPath, track.relativePath);
    assertInsideRoot(sourcePath);
    const sourceStat = await stat(sourcePath);
    sources.push({
      id: track.id,
      relativePath: track.relativePath,
      bytes: sourceStat.size,
      mtimeMs: Math.round(sourceStat.mtimeMs),
      sha1: track.sha256 || await fileSha1(sourcePath)
    });
  }
  const fingerprint = createHash("sha1").update(JSON.stringify({
    generator: KEY_CHANGE_CACHE_VERSION,
    songId: song.id,
    sampleRate,
    originalKey,
    selectedKey,
    transposeCents,
    sources
  })).digest("hex");
  return { fingerprint, sources };
}

async function renderTransposedWav({ ffmpeg, sourcePath, outputPath, sampleRate, transposeCents }) {
  const ratio = Math.pow(2, Number(transposeCents || 0) / 1200);
  const args = [
    "-y",
    "-i", sourcePath,
    "-af", `rubberband=pitch=${ratio.toFixed(8)}`,
    "-ar", String(sampleRate || 48000),
    outputPath
  ];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`FFmpeg key change failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function firstExistingFile(paths) {
  for (const filePath of paths) {
    try {
      await stat(filePath);
      return filePath;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return "";
}

function keyCacheFolderName(selectedKey, transposeCents) {
  return `${keyFolderNameForKey(selectedKey)}_${Math.round(Number(transposeCents || 0))}c`;
}

function keyFolderNameForKey(key) {
  return canonicalMajorKey(key).replace(/b/g, "b").replace(/[^A-Gb]/g, "") || "Key";
}

function effectiveTransposeCents(originalKey, selectedKey, storedCents = 0) {
  const computed = centsBetweenKeys(originalKey, selectedKey);
  if (computed !== 0) return computed;
  return Number.isFinite(Number(storedCents)) ? Number(storedCents) : 0;
}

function centsBetweenKeys(originalKey, selectedKey) {
  const original = KEY_OPTIONS.indexOf(canonicalMajorKey(originalKey).replace(/m$/i, ""));
  const selected = KEY_OPTIONS.indexOf(canonicalMajorKey(selectedKey).replace(/m$/i, ""));
  if (original < 0 || selected < 0) return 0;
  let delta = selected - original;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return delta * 100;
}

function canonicalMajorKey(value) {
  const normalized = stringValue(value).trim().replace(/♯/g, "#").replace(/♭/g, "b").replace(/\s+/g, "");
  if (!normalized) return "";
  const minor = /m$/i.test(normalized);
  const root = normalized.charAt(0).toUpperCase();
  const accidental = normalized.slice(1).replace(/m$/i, "");
  const candidate = `${root}${accidental}`;
  const aliases = {
    "C#": "Db",
    "D#": "Eb",
    "F#": "Gb",
    "G#": "Ab",
    "A#": "Bb"
  };
  const canonical = aliases[candidate] || (KEY_OPTIONS.includes(candidate) ? candidate : "");
  return canonical ? `${canonical}${minor ? "m" : ""}` : "";
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
        padKey: metadata.padKey || metadata.key,
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
    const sourceFingerprint = await sourceMetadataFingerprintForSongFolder(songFolder);
    const sourceManifestPath = join(metadataDir, "source-manifest.json");
    const previousSource = await readJsonFile(sourceManifestPath, null);
    if (previousSource?.fingerprint && previousSource.fingerprint !== sourceFingerprint) {
      await clearAnalyzerDerivedSongDefaults(songFolder);
      await rm(appCueRecognitionReportPath(songFolder), { force: true });
      await rm(appDynamicCueMapPath(songFolder), { force: true });
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
  const padKey = stringValue(musical.padKey || parsed.padKey || key);
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
    padKey,
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

function appSongOverridesDir(songIdValue) {
  return join(SONG_OVERRIDES_DIR, stringValue(songIdValue) || "unknown-song");
}

function appApprovedRegionsPath(songIdValue) {
  return join(appSongOverridesDir(songIdValue), "regions.approved.json");
}

function appApprovedCueMarkersPath(songIdValue) {
  return join(appSongOverridesDir(songIdValue), "cue-markers.approved.json");
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
    transposeCached: Boolean(track.transposeCached),
    transposeCents: Number.isFinite(Number(track.transposeCents)) ? Number(track.transposeCents) : 0,
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

function assertInsideKeyCache(filePath) {
  const normalizedCache = resolve(KEY_CACHE_DIR).toLowerCase();
  const normalizedFile = resolve(filePath).toLowerCase();
  if (normalizedFile !== normalizedCache && !normalizedFile.startsWith(`${normalizedCache}\\`)) {
    throw new Error("Key change cache path is not allowed.");
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
  const requested = pathname === "/" ? "/index.html" : pathname === "/remote" ? "/remote.html" : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  if (!filePath.toLowerCase().startsWith(PUBLIC_DIR.toLowerCase())) {
    return json(res, { error: "Forbidden." }, 403);
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return json(res, { error: "Not found." }, 404);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    });
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

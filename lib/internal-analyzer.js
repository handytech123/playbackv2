import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import XLSX from "xlsx";

const SCHEMA_VERSION = 2;
const ANALYZER_VERSION = "playback-app-v2-internal-analyzer-0.1.0";
const DEFAULT_MASTER_WORKBOOK = "D:\\church_song_master_updated.xlsx";
const VENDORS = ["Loop Community", "Multitracks"];
const KEY_OPTIONS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const PLAYABLE_CLASSIFICATION_CONFIDENCE = 0.75;
const KEY_CONFIDENCE_THRESHOLD = 0.18;
const KEY_ANALYSIS_MAX_SECONDS_PER_STEM = 75;
const CUE_CONFIDENCE_THRESHOLD = 0.65;
const DEFAULT_CUE_PYTHON = "D:\\WavSongAnalyzerV2\\.venv\\Scripts\\python.exe";
const DEFAULT_CUE_WHISPER_MODEL = "C:\\Users\\Luis\\.cache\\huggingface\\hub\\models--Systran--faster-whisper-small.en\\snapshots\\d1d751a5f8271d482d14ca55d9e2deeebbae577f";
const IGNORED_EXTENSIONS = new Set([".rpp", ".rpp-bak", ".reapeaks", ".tmp", ".bak", ".asd", ".pkf", ".sfk"]);
const IGNORED_NAMES = new Set(["desktop.ini", "thumbs.db"]);
const MAJOR_KEY_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_KEY_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SHARP_TO_FLAT_KEY = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };

export async function runInternalAnalyzerForLibrary(options = {}) {
  const root = resolve(stringValue(options.rootPath || options.libraryRoot));
  const workbookPath = stringValue(options.masterWorkbookPath || process.env.PLAYBACK_MASTER_WORKBOOK || DEFAULT_MASTER_WORKBOOK);
  const targets = await songFoldersForRoot(root);
  const master = await readMasterWorkbook(workbookPath).catch((error) => ({
    rows: [],
    error: error.message
  }));
  const summary = {
    ok: true,
    schema: "worship-playback-internal-analyzer-summary",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    generatedAt: new Date().toISOString(),
    rootPath: root,
    masterWorkbookPath: workbookPath,
    masterWorkbookStatus: master.error ? "missing-or-unreadable" : "loaded",
    masterWorkbookError: master.error || "",
    checked: 0,
    ready: 0,
    review: 0,
    partial: 0,
    failed: 0,
    songs: []
  };

  for (const target of targets) {
    const result = await analyzeSongFolder(target.folderPath, {
      root,
      vendor: target.vendor,
      masterRows: master.rows,
      dryRun: false
    });
    summary.checked += 1;
    summary[result.status] = (summary[result.status] || 0) + 1;
    summary.songs.push({
      folderPath: target.folderPath,
      title: result.title,
      vendor: result.vendor,
      status: result.status,
      reviewReasons: result.reviewReasons,
      warnings: result.warnings
    });
  }

  await atomicJsonWrite(join(root, "analysis-summary.json"), summary);
  return summary;
}

export async function previewInternalAnalyzerForSongFolders(songFolders = [], options = {}) {
  const workbookPath = stringValue(options.masterWorkbookPath || process.env.PLAYBACK_MASTER_WORKBOOK || DEFAULT_MASTER_WORKBOOK);
  const master = await readMasterWorkbook(workbookPath).catch((error) => ({
    rows: [],
    error: error.message
  }));
  const summary = {
    ok: true,
    dryRun: true,
    schema: "worship-playback-internal-analyzer-preview",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    generatedAt: new Date().toISOString(),
    masterWorkbookPath: workbookPath,
    masterWorkbookStatus: master.error ? "missing-or-unreadable" : "loaded",
    masterWorkbookError: master.error || "",
    checked: 0,
    ready: 0,
    review: 0,
    partial: 0,
    failed: 0,
    songs: []
  };
  for (const songFolder of songFolders.map(stringValue).filter(Boolean)) {
    const result = await analyzeSongFolder(resolve(songFolder), {
      root: dirname(resolve(songFolder)),
      vendor: vendorFromPath(songFolder),
      masterRows: master.rows,
      dryRun: true
    });
    summary.checked += 1;
    summary[result.status] = (summary[result.status] || 0) + 1;
    summary.songs.push(result);
  }
  return summary;
}

export async function writeInternalAnalyzerForSongFolders(songFolders = [], options = {}) {
  const workbookPath = stringValue(options.masterWorkbookPath || process.env.PLAYBACK_MASTER_WORKBOOK || DEFAULT_MASTER_WORKBOOK);
  const master = await readMasterWorkbook(workbookPath).catch((error) => ({
    rows: [],
    error: error.message
  }));
  const summary = {
    ok: true,
    dryRun: false,
    schema: "worship-playback-internal-analyzer-write",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    generatedAt: new Date().toISOString(),
    masterWorkbookPath: workbookPath,
    masterWorkbookStatus: master.error ? "missing-or-unreadable" : "loaded",
    masterWorkbookError: master.error || "",
    checked: 0,
    ready: 0,
    review: 0,
    partial: 0,
    failed: 0,
    songs: []
  };
  for (const songFolder of songFolders.map(stringValue).filter(Boolean)) {
    const result = await analyzeSongFolder(resolve(songFolder), {
      root: dirname(resolve(songFolder)),
      vendor: vendorFromPath(songFolder),
      masterRows: master.rows,
      dryRun: false,
      keyOverrides: options.keyOverrides || {}
    });
    summary.checked += 1;
    summary[result.status] = (summary[result.status] || 0) + 1;
    summary.songs.push(result);
  }
  return summary;
}

async function analyzeSongFolder(songFolder, context) {
  const createdAt = new Date().toISOString();
  const vendor = context.vendor || vendorFromPath(songFolder);
  const wavInventory = await wavFilesForSong(songFolder);
  const titleMatch = matchMasterRow(songFolder, vendor, context.masterRows);
  const title = titleMatch.row?.title || cleanedFolderTitle(songFolder);
  const artist = titleMatch.row?.artist || "";
  const sourceKey = titleMatch.row?.key || "";
  let keyAnalysis = canonicalMajorKey(sourceKey)
    ? trustedKeyAnalysis(sourceKey)
    : await analyzeSongKeyFromPitchedStems(songFolder, wavInventory);
  const keyOverride = keyOverrideForSong(context.keyOverrides, { songFolder, title, titleMatch });
  if (keyOverride) keyAnalysis = manualKeyOverrideAnalysis(keyOverride, keyAnalysis);
  const key = keyAnalysis.key;
  const bpm = positiveNumber(titleMatch.row?.bpm);
  const timeSignature = normalizeTimeSignature(titleMatch.row?.timeSignature);
  const durationSeconds = round6(Math.max(0, ...wavInventory
    .filter((file) => file.playbackRole !== "ignore")
    .map((file) => file.durationSeconds || 0)));
  const reviewReasons = [];
  const warnings = [];

  if (!titleMatch.row) reviewReasons.push(reason("title-match-review", "No confident master spreadsheet match; using folder title."));
  else if (titleMatch.confidence < 0.92) reviewReasons.push(reason("title-match-review", "Master spreadsheet title match is below strong confidence."));
  if (!KEY_OPTIONS.includes(key)) {
    reviewReasons.push(reason(keyAnalysis.status === "low-confidence" ? "key-low-confidence" : "key-missing", keyAnalysis.message || "Song key is missing or unsupported."));
  }
  if (!bpm) reviewReasons.push(reason("bpm-missing", "Trusted BPM is missing."));
  if (!timeSignature) reviewReasons.push(reason("time-signature-missing", "Trusted time signature is missing."));
  if (!durationSeconds) reviewReasons.push(reason("duration-missing", "No readable WAV duration was found."));

  const playable = wavInventory.filter((file) => file.playLive === true && file.classificationConfidence >= PLAYABLE_CLASSIFICATION_CONFIDENCE);
  if (!playable.length) reviewReasons.push(reason("playable-stem-missing", "No playable music stem was found."));

  const durationSpread = wavDurationSpread(wavInventory.filter((file) => file.playbackRole !== "ignore"));
  if (durationSpread > 2) warnings.push(reason("wav-duration-mismatch", `Readable WAV durations differ by ${round6(durationSpread)} seconds.`));
  if (!wavInventory.some((file) => file.playbackRole === "cue-reference")) {
    reviewReasons.push(reason("cue-reference-missing", "No cue or guide WAV was found."));
  }

  const failed = !bpm || !timeSignature || !durationSeconds || !playable.length;
  const partial = !failed && (!KEY_OPTIONS.includes(key) || !wavInventory.some((file) => file.playbackRole === "cue-reference"));
  const status = failed ? "failed" : partial ? "partial" : reviewReasons.length ? "review" : "ready";
  const songIdValue = stableSongId(vendor, songFolder, titleMatch.row);
  const grid = buildGridAnalysis({ songId: songIdValue, bpm, timeSignature, durationSeconds, status: failed ? "failed" : "trusted" });
  const existingCueIntelligence = await readJsonFile(join(songFolder, "analysis", "cue-intelligence.json"), null);
  const existingRegions = await readJsonFile(join(songFolder, "analysis", "regions.json"), null);
  const cueIntelligence = cueIntelligenceHasMarkers(existingCueIntelligence)
    ? preserveExistingCueIntelligence(existingCueIntelligence, { songId: songIdValue, warnings })
    : await buildCueIntelligence({ songId: songIdValue, status, songFolder, wavInventory, warnings, bpm, timeSignature, durationSeconds });
  const regions = regionsHasEntries(existingRegions)
    ? preserveExistingRegions(existingRegions, { songId: songIdValue, warnings })
    : buildRegions({ songId: songIdValue, status, durationSeconds, cueIntelligence });
  const baseline = buildBaseline({
    songId: songIdValue,
    status,
    title,
    artist,
    vendor,
    bpm,
    timeSignature,
    key,
    sourceKey,
    keyAnalysis,
    wavInventory,
    warnings,
    reviewReasons,
    createdAt
  });
  const metadata = {
    schema: "worship-playback-song-metadata",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    metadataCreatedAt: createdAt,
    metadataUpdatedAt: createdAt,
    songId: songIdValue,
    title,
    sourceTitle: titleMatch.row?.title || null,
    sourceDisplayName: basename(songFolder),
    artist,
    vendor,
    catalogRowId: titleMatch.row?.catalogRowId || "",
    status,
    baselineStatus: status,
    gridStatus: grid.status,
    cueStatus: cueIntelligence.status,
    durationSeconds,
    bpm,
    key,
    sourceKey,
    padKey: key,
    timeSignature,
    musical: {
      bpm,
      displayBpm: bpm,
      timeSignature,
      key,
      sourceKey,
      padKey: key,
      keyConfidence: keyAnalysis.confidence || 0,
      keySource: keyAnalysis.source,
      keyStatus: keyAnalysis.status
    },
    duration: {
      seconds: durationSeconds,
      display: formatDuration(durationSeconds),
      source: "longest-readable-wav"
    },
    baseline: {
      status: failed ? "failed" : "trusted",
      source: "master-spreadsheet-and-wav-inventory",
      stemsStartAtZero: true,
      stemsSampleAligned: true
    },
    gridAnalysis: {
      gridFile: "analysis/grid-analysis.json",
      status: grid.status,
      source: "trusted-metadata"
    },
    cueIntelligence: {
      cueFile: "analysis/cue-intelligence.json",
      status: cueIntelligence.status,
      cueCandidateCount: 0,
      regionCandidateCount: 0
    },
    dynamicClick: {
      status: "app-owned",
      source: "playback-app-owned-time-signature-patterns",
      analysisUsed: false
    },
    sourceAudioIdentity: {
      method: "sha256-per-wav",
      wavFiles: wavInventory
    },
    warnings,
    reviewReasons,
    keyAnalysis,
    wavFiles: wavInventory.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      originalFilename: file.originalFilename,
      relativePath: file.path,
      durationMs: Math.round(file.durationSeconds * 1000),
      durationSeconds: file.durationSeconds,
      sampleRate: file.sampleRate,
      channels: file.channels,
      sha256: file.sha256,
      playbackRole: file.playbackRole,
      stemGroup: file.stemGroup,
      bus: file.bus,
      playLive: file.playLive,
      classificationConfidence: file.classificationConfidence,
      analysisUse: file.analysisUse,
      duplicateOf: file.duplicateOf || ""
    }))
  };

  if (!context.dryRun) {
    await atomicJsonWrite(join(songFolder, "song-metadata.json"), metadata);
    await atomicJsonWrite(join(songFolder, "analysis", "grid-analysis.json"), grid);
    await atomicJsonWrite(join(songFolder, "analysis", "cue-intelligence.json"), cueIntelligence);
    await atomicJsonWrite(join(songFolder, "analysis", "baseline-analysis.json"), baseline);
    await atomicJsonWrite(join(songFolder, "analysis", "regions.json"), regions);
  }
  return {
    folderPath: songFolder,
    title,
    artist,
    vendor,
    status,
    key,
    sourceKey,
    keyConfidence: keyAnalysis.confidence || 0,
    keySource: keyAnalysis.source,
    keyStatus: keyAnalysis.status,
    keyAnalysis,
    bpm,
    timeSignature,
    durationSeconds,
    playableStemCount: playable.length,
    wavCount: wavInventory.length,
    cueReferenceCount: wavInventory.filter((file) => file.playbackRole === "cue-reference").length,
    clickReferenceCount: wavInventory.filter((file) => file.playbackRole === "click-reference").length,
    ignoredCount: wavInventory.filter((file) => file.playbackRole === "ignore").length,
    grid: {
      gridBeatSeconds: grid.gridTiming.gridBeatSeconds,
      measureSeconds: grid.gridTiming.measureSeconds,
      clickBeats: grid.gridTiming.clickBeats,
      firstBeat: grid.beatGrid[0] || null,
      secondMeasure: grid.beatGrid.find((beat) => beat.measure === 2 && beat.beat === 1) || null
    },
    cueStatus: cueIntelligence.status,
    regionStatus: regions.status,
    cueMarkers: Array.isArray(cueIntelligence.markers) ? cueIntelligence.markers : [],
    regions: Array.isArray(regions.regions) ? regions.regions : [],
    preservedExistingCueMarkers: Boolean(cueIntelligence.preservedByInternalAnalyzer),
    preservedExistingRegions: Boolean(regions.preservedByInternalAnalyzer),
    warnings,
    reviewReasons
  };
}

async function songFoldersForRoot(root) {
  const rootName = basename(root);
  if (VENDORS.includes(rootName)) {
    return (await directChildFolders(root)).map((folderPath) => ({ vendor: rootName, folderPath }));
  }
  const vendorFolders = [];
  for (const vendor of VENDORS) {
    const vendorRoot = join(root, vendor);
    const info = await stat(vendorRoot).catch(() => null);
    if (info?.isDirectory()) {
      for (const folderPath of await directChildFolders(vendorRoot)) vendorFolders.push({ vendor, folderPath });
    }
  }
  if (vendorFolders.length) return vendorFolders;
  return [{ vendor: vendorFromPath(root), folderPath: root }];
}

async function directChildFolders(folderPath) {
  const entries = await readdir(folderPath, { withFileTypes: true }).catch(() => []);
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isHiddenName(entry.name) || isReaperName(entry.name)) continue;
    folders.push(resolve(folderPath, entry.name));
  }
  return folders;
}

async function wavFilesForSong(songFolder) {
  const files = [];
  async function visit(folderPath) {
    const entries = await readdir(folderPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (isHiddenName(entry.name) || ignoredTempName(entry.name)) continue;
      const fullPath = resolve(folderPath, entry.name);
      if (entry.isDirectory()) {
        if (!isReaperName(entry.name)) await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
        files.push(fullPath);
      }
    }
  }
  await visit(songFolder);
  files.sort((a, b) => relative(songFolder, a).localeCompare(relative(songFolder, b), undefined, { sensitivity: "base" }));
  const inventory = [];
  const seenHashes = new Map();
  for (const fullPath of files) {
    const relativePath = relative(songFolder, fullPath).replace(/\//g, "\\");
    const summary = await readWavSummary(fullPath).catch((error) => ({ error: error.message }));
    const sha256 = summary.error ? "" : await fileSha256(fullPath);
    const roleInfo = classifyWav(relativePath);
    const duplicateOf = sha256 && seenHashes.has(sha256) ? seenHashes.get(sha256) : "";
    if (sha256 && !seenHashes.has(sha256)) seenHashes.set(sha256, relativePath);
    inventory.push({
      fileId: `audio_${String(inventory.length + 1).padStart(4, "0")}`,
      path: relativePath,
      sourcePath: fullPath,
      originalFilename: basename(fullPath),
      durationSeconds: round6(summary.durationSeconds || 0),
      sampleRate: summary.sampleRate || null,
      channels: summary.channels || null,
      sha256,
      playbackRole: duplicateOf ? "ignore" : roleInfo.playbackRole,
      stemGroup: duplicateOf ? "duplicate" : roleInfo.stemGroup,
      bus: duplicateOf ? "ignore" : roleInfo.bus,
      playLive: duplicateOf ? false : roleInfo.playLive,
      classificationConfidence: duplicateOf ? 1 : roleInfo.confidence,
      analysisUse: duplicateOf ? [] : roleInfo.analysisUse,
      duplicateOf
    });
  }
  return inventory;
}

function classifyWav(relativePath) {
  const name = basename(relativePath).replace(/\.wav$/i, "");
  const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.includes("reaper") || compact.includes("render") || compact.includes("duplicate")) return ignoredRole("filename marked render/duplicate/reaper");
  if (["click", "clicktrack", "metronome"].includes(compact) || /\bclick\b/i.test(name)) {
    return { playbackRole: "click-reference", stemGroup: "click", bus: "click", playLive: false, confidence: 1, analysisUse: ["diagnostic-only"] };
  }
  if (["cue", "cues", "guide", "guides", "vocalcue", "vocalcues"].includes(compact) || /\b(cue|cues|guide)\b/i.test(name)) {
    return { playbackRole: "cue-reference", stemGroup: "cues", bus: "cues", playLive: false, confidence: 1, analysisUse: ["cue-timing", "section-hints"] };
  }
  if (/\b(vocal|alto|tenor|soprano|choir|bgv|backgroundvocal|leadvocal)\b/i.test(name)) {
    return { playbackRole: "vocal-stem", stemGroup: "vocals", bus: "tracks", playLive: false, confidence: 0.9, analysisUse: [] };
  }
  const stemGroup = stemGroupFromName(name);
  return { playbackRole: stemGroup === "pads" ? "pad-stem" : "music-stem", stemGroup, bus: stemGroup === "pads" ? "pads" : "tracks", playLive: true, confidence: 0.9, analysisUse: [] };
}

function ignoredRole() {
  return { playbackRole: "ignore", stemGroup: "ignore", bus: "ignore", playLive: false, confidence: 1, analysisUse: [] };
}

function trustedKeyAnalysis(sourceKey) {
  const key = canonicalMajorKey(sourceKey);
  return {
    status: key ? "trusted" : "missing",
    key,
    sourceKey: stringValue(sourceKey),
    confidence: key ? 1 : 0,
    source: "master-spreadsheet",
    message: key ? "" : "Trusted key is missing."
  };
}

function keyOverrideForSong(overrides = {}, { songFolder, title, titleMatch }) {
  const candidates = [
    resolve(songFolder),
    songFolder,
    title,
    titleMatch.row?.title,
    basename(songFolder)
  ].map(stringValue).filter(Boolean);
  for (const candidate of candidates) {
    const direct = overrides[candidate];
    if (direct) return canonicalMajorKey(direct);
    const lower = candidate.toLowerCase();
    const matchedKey = Object.keys(overrides).find((key) => key.toLowerCase() === lower);
    if (matchedKey) return canonicalMajorKey(overrides[matchedKey]);
  }
  return "";
}

function manualKeyOverrideAnalysis(key, previousAnalysis = {}) {
  return {
    status: "manual-override",
    key,
    detectedKey: previousAnalysis.detectedKey || "",
    mode: "major",
    confidence: 1,
    source: "operator-key-override",
    sourceFileId: previousAnalysis.sourceFileId || "",
    sourceFiles: previousAnalysis.sourceFiles || [],
    previousAnalysis,
    message: `Song key manually corrected to ${key}.`
  };
}

async function analyzeSongKeyFromPitchedStems(songFolder, wavInventory) {
  const candidates = keyAnalysisStemCandidates(wavInventory);
  if (!candidates.length) {
    return {
      status: "missing",
      key: "",
      confidence: 0,
      source: "pitched-stem-analysis",
      sourceFiles: [],
      message: "No pitched stem was available for key analysis."
    };
  }

  const attempts = [];
  for (const file of candidates) {
    const filePath = resolve(songFolder, file.path);
    const result = await chromaFromWavFile(filePath).catch((error) => ({
      ok: false,
      error: error.message,
      chroma: new Array(12).fill(0)
    }));
    const sourceFile = {
      fileId: file.fileId,
      path: file.path,
      stemGroup: file.stemGroup,
      priority: keyStemPriority(file)
    };
    if (!result.ok) {
      attempts.push({ ...sourceFile, ok: false, error: result.error });
      continue;
    }
    const energy = result.chroma.reduce((sum, value) => sum + value, 0);
    if (!energy) {
      attempts.push({ ...sourceFile, ok: false, error: "No harmonic energy found." });
      continue;
    }
    const detected = keyFromChroma(result.chroma);
    const accepted = detected.confidence >= KEY_CONFIDENCE_THRESHOLD && detected.mode === "major" && KEY_OPTIONS.includes(detected.key);
    attempts.push({
      ...sourceFile,
      ok: true,
      accepted,
      detectedKey: detected.key,
      mode: detected.mode,
      confidence: round6(detected.confidence),
      score: round6(detected.score)
    });
    if (accepted) {
      return {
        status: "detected",
        key: detected.key,
        detectedKey: detected.key,
        mode: detected.mode,
        confidence: round6(detected.confidence),
        score: round6(detected.score),
        source: "single-pitched-stem-analysis",
        sourceFileId: file.fileId,
        sourceFiles: [sourceFile],
        attempts,
        chroma: result.chroma.map(round6),
        message: ""
      };
    }
  }

  const best = attempts
    .filter((attempt) => attempt.ok)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
  return {
    status: best ? "low-confidence" : "missing",
    key: "",
    detectedKey: best?.detectedKey || "",
    mode: best?.mode || "",
    confidence: best?.confidence || 0,
    score: best?.score || 0,
    source: "single-pitched-stem-analysis",
    sourceFileId: best?.fileId || "",
    sourceFiles: best ? [{ fileId: best.fileId, path: best.path, stemGroup: best.stemGroup, priority: best.priority }] : [],
    attempts,
    message: best
      ? `Detected ${best.detectedKey} from ${best.path} but confidence ${best.confidence} is below ${KEY_CONFIDENCE_THRESHOLD}.`
      : "Pitched stems did not contain enough harmonic energy for key analysis."
  };
}

function keyAnalysisStemCandidates(wavInventory) {
  return wavInventory
    .filter((file) => ["music-stem", "pad-stem"].includes(file.playbackRole))
    .filter((file) => ["piano", "keys", "pads", "guitars", "bass"].includes(file.stemGroup))
    .filter((file) => !/\b(click|cue|guide|drum|perc|vocal|alto|tenor|soprano|bgv|choir)\b/i.test(file.originalFilename || file.path))
    .sort((a, b) => keyStemPriority(a) - keyStemPriority(b) || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

function keyStemPriority(file) {
  const group = stringValue(file.stemGroup).toLowerCase();
  if (group === "piano") return 1;
  if (group === "keys") return 2;
  if (group === "pads") return 3;
  if (group === "guitars") return 4;
  if (group === "bass") return 5;
  if (["loops", "misc"].includes(group)) return 6;
  return 9;
}

async function chromaFromWavFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(1024 * 1024);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const info = parseWavHeader(header.subarray(0, headerRead.bytesRead));
    if (!info?.dataBytes || !info.blockAlign || !info.sampleRate) throw new Error("Unsupported WAV file.");
    const maxFrames = Math.min(
      Math.floor(info.dataBytes / info.blockAlign),
      Math.floor(info.sampleRate * KEY_ANALYSIS_MAX_SECONDS_PER_STEM)
    );
    if (maxFrames < 4096) throw new Error("WAV is too short for key analysis.");
    const bytesToRead = maxFrames * info.blockAlign;
    const buffer = Buffer.alloc(bytesToRead);
    const read = await handle.read(buffer, 0, bytesToRead, info.dataOffset);
    const frameCount = Math.floor(read.bytesRead / info.blockAlign);
    const mono = new Float32Array(frameCount);
    const bytesPerSample = info.bitsPerSample / 8;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const frameOffset = frame * info.blockAlign;
      let sum = 0;
      for (let channel = 0; channel < info.channels; channel += 1) {
        sum += readWavSample(buffer, frameOffset + channel * bytesPerSample, info);
      }
      mono[frame] = sum / Math.max(1, info.channels);
    }
    return { ok: true, chroma: chromaFromSamples(mono, info.sampleRate) };
  } finally {
    await handle.close();
  }
}

function chromaFromSamples(samples, sampleRate) {
  const chroma = new Array(12).fill(0);
  const windowSize = 4096;
  const maxWindows = 72;
  const usableFrames = samples.length - windowSize;
  if (usableFrames <= 0) return chroma;
  const step = Math.max(windowSize, Math.floor(usableFrames / maxWindows));
  const frequencies = [];
  for (let midi = 36; midi <= 83; midi += 1) {
    frequencies.push({
      midi,
      pitchClass: midi % 12,
      frequency: 440 * Math.pow(2, (midi - 69) / 12)
    });
  }
  for (let start = 0, windowIndex = 0; start + windowSize <= samples.length && windowIndex < maxWindows; start += step, windowIndex += 1) {
    const rms = windowRms(samples, start, windowSize);
    if (rms < 0.004) continue;
    for (const item of frequencies) {
      const magnitude = goertzelMagnitude(samples, start, windowSize, sampleRate, item.frequency);
      chroma[item.pitchClass] += magnitude * magnitude;
    }
  }
  const max = Math.max(...chroma);
  return max > 0 ? chroma.map((value) => value / max) : chroma;
}

function keyFromChroma(chroma) {
  const normalized = normalizeVector(chroma);
  const scores = [];
  for (let root = 0; root < 12; root += 1) {
    scores.push({
      key: pitchClassName(root),
      mode: "major",
      score: correlation(normalized, normalizeVector(rotateProfile(MAJOR_KEY_PROFILE, root)))
    });
    scores.push({
      key: `${pitchClassName(root)}m`,
      mode: "minor",
      score: correlation(normalized, normalizeVector(rotateProfile(MINOR_KEY_PROFILE, root)))
    });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0] || { key: "", mode: "", score: 0 };
  const second = scores[1] || { score: 0 };
  return {
    ...best,
    key: canonicalMajorKey(best.key) || best.key,
    confidence: Math.max(0, best.score - second.score)
  };
}

function rotateProfile(profile, root) {
  const rotated = new Array(12);
  for (let index = 0; index < 12; index += 1) {
    rotated[(index + root) % 12] = profile[index];
  }
  return rotated;
}

function normalizeVector(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const centered = values.map((value) => value - mean);
  const length = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0)) || 1;
  return centered.map((value) => value / length);
}

function correlation(a, b) {
  return a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0);
}

function pitchClassName(value) {
  return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][((value % 12) + 12) % 12];
}

function windowRms(samples, start, length) {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const value = samples[start + index] || 0;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, length));
}

function goertzelMagnitude(samples, start, length, sampleRate, frequency) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let index = 0; index < length; index += 1) {
    q0 = coeff * q1 - q2 + (samples[start + index] || 0);
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(Math.max(0, q1 * q1 + q2 * q2 - coeff * q1 * q2)) / length;
}

function stemGroupFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes("bass")) return "bass";
  if (lower.includes("drum")) return "drums";
  if (lower.includes("perc") || lower.includes("shaker") || lower.includes("clap")) return "percussion";
  if (lower.includes("piano")) return "piano";
  if (lower.includes("keys") || lower.includes("organ") || lower.includes("rhodes") || lower.includes("synth")) return "keys";
  if (lower.includes("guitar") || lower.includes("electric") || lower.includes("acoustic")) return "guitars";
  if (lower.includes("pad")) return "pads";
  if (lower.includes("loop")) return "loops";
  return "misc";
}

function buildGridAnalysis({ songId, bpm, timeSignature, durationSeconds, status }) {
  const parsed = parseTimeSignature(timeSignature);
  const rawGridBeatSeconds = bpm && parsed ? gridBeatSecondsForPlayback(bpm, parsed.numerator, parsed.denominator) : 0;
  const gridBeatSeconds = rawGridBeatSeconds ? round6(rawGridBeatSeconds) : 0;
  const measureSeconds = rawGridBeatSeconds ? round6(rawGridBeatSeconds * parsed.numerator) : 0;
  const beatGrid = [];
  const measureGrid = [];
  if (gridBeatSeconds && durationSeconds) {
    const totalBeats = Math.max(1, Math.ceil(durationSeconds / gridBeatSeconds) + parsed.numerator);
    for (let index = 0; index < totalBeats; index += 1) {
      beatGrid.push({
        globalBeat: index,
        measure: Math.floor(index / parsed.numerator) + 1,
        beat: (index % parsed.numerator) + 1,
        beatInMeasure: (index % parsed.numerator) + 1,
        timeSeconds: round6(index * rawGridBeatSeconds)
      });
    }
    const measureCount = Math.max(1, Math.ceil(durationSeconds / measureSeconds));
    for (let measure = 1; measure <= measureCount; measure += 1) {
      const start = round6((measure - 1) * measureSeconds);
      measureGrid.push({ measure, startTimeSeconds: start, endTimeSeconds: round6(start + measureSeconds) });
    }
  }
  return {
    schema: "worship-playback-grid-analysis",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    songId,
    status,
    authoritySource: "trusted-metadata",
    sourceProvider: "playback-app-internal-analyzer",
    confidence: status === "trusted" ? 1 : 0,
    gridConstructionPolicy: {
      bpmSource: "master-spreadsheet",
      timeSignatureSource: "master-spreadsheet",
      audioTempoDetectionUsed: false,
      clickTransientTimingUsed: false,
      tempoNormalizationUsed: false,
      measureOneBeatOneSeconds: 0
    },
    bpm,
    durationSeconds,
    gridTiming: {
      bpmInterpretation: parsed && parsed.denominator === 8 && [6, 9, 12].includes(parsed.numerator) ? "compound-eighth-subdivision-grid" : "simple-meter-grid",
      gridBeatSeconds,
      measureSeconds,
      clickBeats: clickBeatsForSignature(timeSignature),
      clickProfile: "app-owned-pattern-source"
    },
    tempo: { bpm, workingGridBpm: bpm, tempoNormalization: "none", confidence: bpm ? 1 : 0 },
    timeSignature: parsed ? {
      display: timeSignature,
      numerator: parsed.numerator,
      denominator: parsed.denominator,
      gridBeatsPerMeasure: parsed.numerator,
      confidence: 1
    } : null,
    measureOne: { timeSeconds: 0, globalBeat: 0, confidence: 1 },
    measureOneBeatOneSeconds: 0,
    beatGrid,
    beats: beatGrid,
    measureGrid,
    warnings: []
  };
}

async function buildCueIntelligence({ songId, status, songFolder, wavInventory, warnings, bpm, timeSignature, durationSeconds }) {
  const cueSource = wavInventory.find((file) => file.playbackRole === "cue-reference");
  const recognizerOutput = cueSource
    ? await runCueRecognizer(join(songFolder, cueSource.path))
    : { ok: false, error: "No cue source." };
  const speechCandidates = Array.isArray(recognizerOutput.segments) ? recognizerOutput.segments : [];
  const cueEvents = buildCueEvents(speechCandidates, recognizerOutput);
  const markers = [];
  const rejected = [];
  for (const cueEvent of cueEvents) {
    const normalized = normalizeCuePhrase(cueEvent.text);
    const confidence = positiveNumber(cueEvent.confidence) || 0;
    const detectedTime = nonNegativeNumber(cueEvent.start) || 0;
    if (!normalized || confidence < CUE_CONFIDENCE_THRESHOLD) {
      rejected.push({
        rawTranscript: stringValue(cueEvent.text),
        detectedTimeSeconds: round6(detectedTime),
        confidence: round6(confidence),
        reason: normalized ? "low-confidence" : "unrecognized-phrase"
      });
      continue;
    }
    const snapped = snapSecondsToGrid(detectedTime, bpm, timeSignature);
    const predicted = regionStartAfterCue(snapped, detectedTime, bpm, timeSignature);
    const cueLeadMeasures = normalized === "Repeat" ? 0 : regionLeadMeasuresAfterCue(timeSignature, bpm);
    const heardCountPattern = stringValue(cueEvent.countPatternHeard);
    const resolvedCountPattern = heardCountPattern || defaultCueCountPattern(timeSignature, bpm, cueLeadMeasures);
    const id = `cue_${String(markers.length + 1).padStart(4, "0")}`;
    markers.push({
      id,
      heardText: stringValue(cueEvent.rawText || cueEvent.text),
      rawTranscript: stringValue(cueEvent.rawText || cueEvent.text),
      label: normalized,
      target: normalized,
      normalizedText: normalized,
      countPatternHeard: heardCountPattern,
      cueCountPattern: resolvedCountPattern,
      cueCountSource: heardCountPattern ? stringValue(cueEvent.countPatternSource) : "grid-rule-fallback",
      cueCountConfidence: round6(heardCountPattern ? positiveNumber(cueEvent.countPatternConfidence) || 0 : 0.65),
      cueLeadMeasures,
      cueLeadSource: "grid-and-guide-stem",
      cueLeadConfidence: round6(confidence),
      status: "trusted",
      command: normalized === "Repeat" ? "repeat" : "normal",
      confidence: round6(confidence),
      labelConfidence: round6(confidence),
      heardTimeSeconds: round6(detectedTime),
      spokenAtSeconds: round6(detectedTime),
      sectionWordAtSeconds: round6(detectedTime),
      targetMeasure: snapped.measure,
      targetBeatInMeasure: snapped.beat,
      snappedMeasure: snapped.measure,
      snappedBeatInMeasure: snapped.beat,
      alignmentStatus: "trusted",
      predictedRegionStart: normalized === "Repeat" ? null : {
        measure: predicted.measure,
        beat: predicted.beat,
        timeSeconds: predicted.timeSeconds,
        confidence: round6(confidence)
      },
      phraseRecognition: {
        engine: "playback-app-internal-faster-whisper",
        command: normalized === "Repeat" ? "repeat" : "normal",
        countPatternHeard: stringValue(cueEvent.countPatternHeard),
        rejectionReasons: []
      }
    });
  }
  const inferredRegions = inferRegionsFromCueMarkers(markers, { bpm, timeSignature, durationSeconds });
  const cueWarnings = [...warnings];
  if (!cueSource) cueWarnings.push(reason("cue-reference-missing", "No cue or guide WAV was found."));
  if (cueSource && !recognizerOutput.ok) cueWarnings.push(reason("cue-recognition-failed", recognizerOutput.error || "Cue recognition failed."));
  return {
    schema: "worship-playback-cue-intelligence",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    songId,
    generatedAt: new Date().toISOString(),
    status: markers.length ? "trusted" : cueSource ? "review" : "missing",
    sourceFingerprint: createHash("sha1").update(`${songId}:${status}:${cueSource?.sha256 || ""}:${JSON.stringify(markers)}`).digest("hex"),
    cueSource: cueSource ? { path: cueSource.path, role: cueSource.playbackRole } : null,
    source: cueSource ? { absolutePath: join(songFolder, cueSource.path), relativePath: cueSource.path } : null,
    alignmentSource: "trusted-playback-grid",
    gridReference: {
      bpm,
      timeSignature,
      durationSeconds,
      cueLeadRule: "cue-marker-snaps-where-spoken-region-starts-next-measure"
    },
    summary: {
      speechCandidateCount: speechCandidates.length,
      cueBurstCount: Array.isArray(recognizerOutput.cueBursts) ? recognizerOutput.cueBursts.length : 0,
      cueEventCount: cueEvents.length,
      markerCount: markers.length,
      rejectedCount: rejected.length,
      regionCount: inferredRegions.regions.length
    },
    speechEngine: {
      cueRecognizer: "playback-app-internal-faster-whisper",
      cueProvider: "playback-app-internal-analyzer",
      voskStatus: "not-used",
      modelPath: recognizerOutput.modelPath || DEFAULT_CUE_WHISPER_MODEL
    },
    recognizer: { engine: "playback-app-internal-faster-whisper", countsIgnored: false },
    cues: markers,
    markers,
    candidates: markers,
    cueMarkers: markers,
    speechCandidates,
    rejectedPhrases: rejected,
    regionCandidates: inferredRegions.regions.map((region, index) => ({
      id: `region_candidate_${index + 1}`,
      sourceCueCandidateId: region.sourceCueId,
      sourceCueText: region.name,
      status: "verified",
      startMeasure: region.startMeasure,
      startBeat: region.startBeat,
      endMeasure: region.endMeasure,
      endBeat: region.endBeat,
      predictedRegionStart: {
        measure: region.startMeasure,
        beat: region.startBeat,
        timeSeconds: region.startTimeSeconds
      },
      countPatternHeard: region.countPatternHeard || "",
      cueLeadMeasures: region.cueLeadMeasures || null,
      confidence: region.confidence,
      reason: "internal-cue-next-measure-rule"
    })),
    inferredRegions,
    warnings: cueWarnings
  };
}

async function runCueRecognizer(cuePath) {
  const pythonPath = process.env.PLAYBACK_CUE_PYTHON || DEFAULT_CUE_PYTHON;
  const modelPath = process.env.PLAYBACK_CUE_WHISPER_MODEL || DEFAULT_CUE_WHISPER_MODEL;
  const scriptPath = resolve("D:\\PlaybackAppV2", "scripts", "internal-cue-recognizer.py");
  const result = await spawnJson(pythonPath, [scriptPath, cuePath, modelPath], { timeoutMs: 10 * 60 * 1000 });
  return result && typeof result === "object" ? { ...result, modelPath } : { ok: false, error: "Cue recognizer returned no JSON.", modelPath };
}

function spawnJson(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      resolvePromise({ ok: false, error: "Cue recognizer timed out.", stderr });
    }, options.timeoutMs || 120000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise({ ok: false, error: error.message, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
      try {
        const parsed = JSON.parse(line);
        resolvePromise({ ...parsed, exitCode: code, stderr });
      } catch {
        resolvePromise({ ok: false, error: "Cue recognizer output was not JSON.", stdout, stderr, exitCode: code });
      }
    });
  });
}

function buildCueEvents(speechCandidates, recognizerOutput) {
  const labelEvents = extractCueLabelEventsFromSegments(speechCandidates);
  const bursts = Array.isArray(recognizerOutput?.cueBursts) ? recognizerOutput.cueBursts : [];
  if (labelEvents.length && bursts.length) {
    return bursts.slice(0, labelEvents.length).map((burst, index) => ({
      text: labelEvents[index].label,
      rawText: labelEvents[index].rawText,
      countPatternHeard: labelEvents[index].countPatternHeard,
      countPatternSource: labelEvents[index].countPatternHeard ? "guide-stem" : "",
      countPatternConfidence: labelEvents[index].countPatternHeard ? Math.max(0.85, positiveNumber(burst.confidence) || 0) : 0,
      start: burst.start,
      end: burst.end,
      confidence: Math.max(0.85, positiveNumber(burst.confidence) || 0)
    }));
  }
  return speechCandidates.map((segment) => ({
    text: stringValue(segment.text),
    start: nonNegativeNumber(segment.start) || 0,
    end: nonNegativeNumber(segment.end) || nonNegativeNumber(segment.start) || 0,
    confidence: positiveNumber(segment.confidence) || 0
  }));
}

function extractCueLabelEventsFromSegments(speechCandidates) {
  const text = speechCandidates.map((segment) => stringValue(segment.text)).join(" ")
    .replace(/\bpre[-\s]*chorus\b/gi, "pre chorus")
    .replace(/\bprechorus\b/gi, "pre chorus")
    .replace(/\bprec(?:\s+(?:chorus|girlfriends))?\b/gi, "pre chorus")
    .replace(/\bprecorys\b/gi, "pre chorus")
    .replace(/\bbreak\s+down\b/gi, "breakdown")
    .replace(/\b(?:verre|varre)\b/gi, "verse");
  const matches = [];
  const pattern = /\b(bring\s+it\s+down|down\s*bridge|downbridge|down\s*chorus|downchorus|pre[-\s]*chorus|prechorus|precorys|prec(?:\s+(?:chorus|girlfriends))?|slowly\s+build|drums\s+in|all\s+in|instrumental|turn\s+around|turnaround|interlude|break\s+down|breakdown|refrain|chorus|bridge|verse|ver|verre|varre|intro|tag|vamp|solo|build|outro|ending|end|and|n|repeat)(?:\s*(?:-|to)?\s*(one|two|three|four|five|six|seven|eight|\d+))?\b/gi;
  for (const match of text.matchAll(pattern)) {
    matches.push(match);
  }
  return matches.map((match, index) => {
    const nextIndex = matches[index + 1]?.index ?? text.length;
    const windowText = text.slice(match.index, nextIndex);
    const countPatternHeard = countPatternFromCueWindow(windowText);
    const labelText = countPatternHeard ? match[1] : `${match[1]}${match[2] ? ` ${match[2]}` : ""}`;
    const label = normalizeCuePhrase(labelText);
    return label ? {
      label,
      rawText: windowText.trim(),
      countPatternHeard
    } : null;
  }).filter(Boolean);
}

function countPatternFromCueWindow(value) {
  const numbers = [];
  const pattern = /\b(one|two|three|four|five|six|seven|eight|\d)\b/gi;
  for (const match of stringValue(value).matchAll(pattern)) {
    const number = cueCountNumberValue(match[1]);
    if (number >= 1 && number <= 8) numbers.push(number);
  }
  if (numbers.length < 2) return "";
  const patternText = numbers.join("");
  return /^(234|2345|23456|456|1234|123456)$/.test(patternText) ? patternText : "";
}

function cueCountNumberValue(value) {
  const text = stringValue(value).toLowerCase();
  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8
  };
  return numberWords[text] || Number(text) || 0;
}

function normalizeCuePhrase(text) {
  let cleaned = stringValue(text).trim();
  if (!cleaned) return "";
  cleaned = cleaned
    .replace(/\s*\[unk\]\s*$/i, "")
    .replace(/\bpre\s*chorus\b/i, "pre chorus")
    .replace(/\bprechorus\b/i, "pre chorus")
    .replace(/\bprec(?:\s+\w+)?\b/i, "pre chorus")
    .replace(/\bprecorys\b/i, "pre chorus")
    .replace(/\bbring\s+it\s+down\b/i, "bring it down")
    .replace(/\bdown\s*bridge\b/i, "down bridge")
    .replace(/\bdownbridge\b/i, "down bridge")
    .replace(/\bdown\s*chorus\b/i, "down chorus")
    .replace(/\bdownchorus\b/i, "down chorus")
    .replace(/\bslowly\s+build\b/i, "slowly build")
    .replace(/\bdrums\s+in\b/i, "drums in")
    .replace(/\ball\s+in\b/i, "all in")
    .replace(/\bending\b/i, "end")
    .replace(/\bver\b/i, "verse")
    .replace(/\b(?:verre|varre)\b/i, "verse")
    .replace(/\bturn\s+around\b/i, "turnaround")
    .replace(/^\s*(?:and|n)\s*$/i, "end")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const numberWords = {
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8"
  };
  for (const [word, number] of Object.entries(numberWords)) {
    cleaned = cleaned.replace(new RegExp(`\\b${word}\\b`, "gi"), number);
  }
  const sections = [
    "Bring It Down", "Down Bridge", "Down Chorus", "Pre Chorus", "Slowly Build", "Drums In", "All In",
    "Instrumental", "Turnaround", "Interlude", "Breakdown", "Refrain", "Chorus", "Bridge", "Verse", "Intro", "Tag", "Vamp",
    "Solo", "Build", "Outro", "End"
  ];
  for (const section of sections) {
    const match = cleaned.match(new RegExp(`\\b${section.replace(/\s+/g, "\\s+")}(?:\\s+(\\d+))?\\b`, "i"));
    if (match) return `${section}${match[1] ? ` ${match[1]}` : ""}`;
  }
  return /\brepeat\b/i.test(cleaned) ? "Repeat" : "";
}

function snapSecondsToGrid(timeSeconds, bpm, timeSignature) {
  const parsed = parseTimeSignature(timeSignature);
  const beatSeconds = parsed && bpm ? gridBeatSecondsForPlayback(bpm, parsed.numerator, parsed.denominator) : 0;
  if (!beatSeconds || !parsed) return { measure: 1, beat: 1, timeSeconds: 0 };
  const index = Math.max(0, Math.round((Number(timeSeconds) || 0) / beatSeconds));
  return {
    measure: Math.floor(index / parsed.numerator) + 1,
    beat: (index % parsed.numerator) + 1,
    timeSeconds: round6(index * beatSeconds)
  };
}

function regionStartAfterCue(snappedCue, detectedTimeSeconds, bpm, timeSignature) {
  if (!snappedCue) return { measure: 1, beat: 1, timeSeconds: 0 };
  if (Number(snappedCue.measure) === 1 && Number(snappedCue.beat) === 1 && Math.abs(Number(detectedTimeSeconds || 0)) < 0.05) {
    return {
      measure: 1,
      beat: 1,
      timeSeconds: 0
    };
  }
  const leadMeasures = regionLeadMeasuresAfterCue(timeSignature, bpm);
  const targetMeasure = Number(snappedCue.measure || 1) + leadMeasures;
  return {
    measure: targetMeasure,
    beat: 1,
    timeSeconds: timeForGridPosition(targetMeasure, 1, bpm, timeSignature)
  };
}

function regionLeadMeasuresAfterCue(timeSignature, bpm) {
  const parsed = parseTimeSignature(timeSignature);
  if (parsed?.numerator === 6 && parsed.denominator === 8) return Number(bpm || 0) >= 100 ? 2 : 1;
  return 1;
}

function defaultCueCountPattern(timeSignature, bpm, cueLeadMeasures = 1) {
  const parsed = parseTimeSignature(timeSignature);
  if (parsed?.numerator === 6 && parsed.denominator === 8) {
    return Number(cueLeadMeasures || regionLeadMeasuresAfterCue(timeSignature, bpm)) >= 2 ? "23456" : "456";
  }
  return "234";
}

function timeForGridPosition(measure, beat, bpm, timeSignature) {
  const parsed = parseTimeSignature(timeSignature);
  const beatSeconds = parsed && bpm ? gridBeatSecondsForPlayback(bpm, parsed.numerator, parsed.denominator) : 0;
  if (!beatSeconds || !parsed) return 0;
  const globalBeat = Math.max(0, ((Number(measure || 1) - 1) * parsed.numerator) + (Number(beat || 1) - 1));
  return round6(globalBeat * beatSeconds);
}

function inferRegionsFromCueMarkers(markers, { bpm, timeSignature, durationSeconds }) {
  const usableWithDuplicates = markers
    .filter((marker) => marker.label && marker.label !== "Repeat" && marker.predictedRegionStart)
    .map((marker) => ({
      marker,
      start: marker.predictedRegionStart
    }))
    .sort((a, b) => (a.start.measure - b.start.measure) || (a.start.beat - b.start.beat));
  const usable = [];
  for (const item of usableWithDuplicates) {
    const previous = usable.at(-1);
    if (previous && previous.start.measure === item.start.measure && previous.start.beat === item.start.beat) {
      usable[usable.length - 1] = item;
    } else {
      usable.push(item);
    }
  }
  const regions = [];
  const occurrence = new Map();
  const firstStart = usable[0]?.start;
  if (!firstStart || firstStart.measure > 1 || firstStart.beat > 1) {
    regions.push({
      id: "region-0001",
      name: "Start",
      startMeasure: 1,
      startBeat: 1,
      startTimeSeconds: 0,
      sourceCueId: "",
      confidence: 0.5,
      status: "verified",
      source: "internal-initial-region"
    });
  }
  for (const item of usable) {
    const baseName = item.marker.label;
    if (baseName === "End") continue;
    const count = (occurrence.get(baseName) || 0) + 1;
    occurrence.set(baseName, count);
    regions.push({
      id: `region-${String(regions.length + 1).padStart(4, "0")}`,
      name: count === 1 ? baseName : `${baseName} ${count}`,
      startMeasure: item.start.measure,
      startBeat: item.start.beat,
      startTimeSeconds: item.start.timeSeconds,
      sourceCueId: item.marker.id,
      sourceCueName: item.marker.label,
      countPatternHeard: item.marker.countPatternHeard || "",
      cueCountPattern: item.marker.cueCountPattern || item.marker.countPatternHeard || "",
      cueCountSource: item.marker.cueCountSource || "",
      cueLeadMeasures: item.marker.cueLeadMeasures || null,
      confidence: item.marker.confidence,
      status: "verified",
      source: "internal-cue-next-measure-rule"
    });
  }
  const finalEnd = finalRegionEnd({ bpm, timeSignature, durationSeconds, markers });
  for (let index = 0; index < regions.length; index += 1) {
    const next = regions[index + 1];
    regions[index].endMeasure = next?.startMeasure || finalEnd.measure;
    regions[index].endBeat = next?.startBeat || finalEnd.beat;
    regions[index].endTimeSeconds = next?.startTimeSeconds ?? finalEnd.timeSeconds;
  }
  return {
    status: "approved",
    source: "playback-app-internal-cue-analyzer",
    approved: true,
    updatedAt: new Date().toISOString(),
    regions
  };
}

function finalRegionEnd({ bpm, timeSignature, durationSeconds, markers }) {
  const endMarker = markers.find((marker) => marker.label === "End");
  if (endMarker) {
    return {
      measure: endMarker.snappedMeasure || endMarker.targetMeasure || 1,
      beat: endMarker.snappedBeatInMeasure || endMarker.targetBeatInMeasure || 1,
      timeSeconds: endMarker.spokenAtSeconds || endMarker.heardTimeSeconds || 0
    };
  }
  return snapSecondsToGrid(durationSeconds || 0, bpm, timeSignature);
}

function cueIntelligenceHasMarkers(value) {
  return Boolean(value && (nonEmptyArray(value.markers) || nonEmptyArray(value.cues) || nonEmptyArray(value.candidates)));
}

function preserveExistingCueIntelligence(value, { songId, warnings }) {
  const markers = nonEmptyArray(value.markers)
    ? value.markers
    : nonEmptyArray(value.cues)
      ? value.cues.map((cue, index) => ({
        id: cue.id || `cue_${String(index + 1).padStart(4, "0")}`,
        heardText: cue.heardText || cue.rawTranscript || cue.label || "",
        label: cue.label || cue.normalizedText || "",
        status: cue.status || "trusted",
        confidence: cue.confidence || cue.labelConfidence || 0,
        targetMeasure: cue.marker?.measure || cue.measure || cue.targetMeasure,
        targetBeatInMeasure: cue.marker?.beat || cue.beat || cue.targetBeatInMeasure,
        snappedMeasure: cue.marker?.measure || cue.measure || cue.snappedMeasure,
        snappedBeatInMeasure: cue.marker?.beat || cue.beat || cue.snappedBeatInMeasure,
        spokenAtSeconds: cue.audioPhraseStartTimeSeconds || cue.timeSeconds || cue.spokenAtSeconds,
        alignmentStatus: cue.alignmentStatus || "trusted"
      }))
      : value.candidates;
  return {
    ...value,
    analyzerGenerated: true,
    schemaVersion: value.schemaVersion || SCHEMA_VERSION,
    version: value.version || ANALYZER_VERSION,
    songId,
    status: value.status || "trusted",
    markers,
    warnings: mergeReasonLists(value.warnings, warnings),
    preservedByInternalAnalyzer: true,
    preservedAt: new Date().toISOString()
  };
}

function regionsHasEntries(value) {
  return Boolean(value && nonEmptyArray(value.regions));
}

function preserveExistingRegions(value, { songId, warnings }) {
  return {
    ...value,
    analyzerGenerated: true,
    schemaVersion: value.schemaVersion || SCHEMA_VERSION,
    version: value.version || ANALYZER_VERSION,
    songId,
    warnings: mergeReasonLists(value.warnings, warnings),
    preservedByInternalAnalyzer: true,
    preservedAt: new Date().toISOString()
  };
}

function buildRegions({ songId, status, durationSeconds, cueIntelligence }) {
  const inferred = cueIntelligence?.inferredRegions;
  if (inferred && Array.isArray(inferred.regions) && inferred.regions.length) {
    return {
      schema: "worship-playback-regions",
      analyzerGenerated: true,
      schemaVersion: SCHEMA_VERSION,
      version: ANALYZER_VERSION,
      songId,
      status: "approved",
      source: "internal-cue-intelligence-inferred-regions",
      durationSeconds,
      regions: inferred.regions,
      warnings: []
    };
  }
  return {
    schema: "worship-playback-regions",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    songId,
    status: status === "ready" ? "draft" : "partial",
    source: "no-cue-speech-yet",
    regionRule: {
      cueMarkerIsLeadIn: true,
      regionStartsAfterOneMeasure: true,
      overwriteApprovedMaps: false
    },
    durationSeconds,
    regions: [],
    warnings: [reason("region-analysis-not-run", "Cue speech recognition is not integrated in this internal analyzer pass.")]
  };
}

function buildBaseline(input) {
  const wavFiles = input.wavInventory.map((file) => ({
    fileId: file.fileId,
    path: file.path,
    durationSeconds: file.durationSeconds,
    sampleRate: file.sampleRate,
    channels: file.channels,
    playbackRole: file.playbackRole,
    stemGroup: file.stemGroup,
    bus: file.bus,
    playLive: file.playLive,
    sha256: file.sha256
  }));
  return {
    schema: "worship-playback-baseline-analysis",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    songId: input.songId,
    status: input.status,
    createdAt: input.createdAt,
    sourceTruth: {
      title: input.title,
      artist: input.artist,
      vendor: input.vendor,
      bpm: input.bpm,
      timeSignature: input.timeSignature,
      key: input.key,
      sourceKey: input.sourceKey,
      source: "master-spreadsheet"
    },
    wavFiles,
    keyAnalysis: {
      status: input.keyAnalysis?.status || (input.key ? "trusted" : "missing"),
      key: input.key,
      sourceKey: input.sourceKey,
      padKey: input.key,
      confidence: input.keyAnalysis?.confidence || (input.key ? 1 : 0),
      sourceFileId: input.keyAnalysis?.sourceFileId || "",
      sourceFiles: input.keyAnalysis?.sourceFiles || [],
      sourcePolicy: input.keyAnalysis?.source || "pitched-stem-analysis"
    },
    fileRoleSummary: {
      musicStemCount: wavFiles.filter((file) => file.playbackRole === "music-stem").length,
      clickReferenceCount: wavFiles.filter((file) => file.playbackRole === "click-reference").length,
      cueReferenceCount: wavFiles.filter((file) => file.playbackRole === "cue-reference").length,
      padStemCount: wavFiles.filter((file) => file.playbackRole === "pad-stem").length,
      liveFileCount: wavFiles.filter((file) => file.playLive).length,
      referenceFileCount: wavFiles.filter((file) => !file.playLive && file.playbackRole !== "ignore").length
    },
    warnings: input.warnings,
    reviewReasons: input.reviewReasons
  };
}

async function readMasterWorkbook(workbookPath) {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    for (const raw of rawRows) {
      const normalized = normalizeMasterRow(raw, rows.length + 1);
      if (normalized.title) rows.push(normalized);
    }
  }
  return { rows };
}

function normalizeMasterRow(row, index) {
  const get = (...names) => {
    const entries = Object.entries(row);
    for (const name of names) {
      const found = entries.find(([key]) => normalizeHeader(key) === normalizeHeader(name));
      if (found) return stringValue(found[1]);
    }
    return "";
  };
  const title = get("title", "song", "song title", "name");
  const id = get("id", "song id", "catalog id", "multitracks id", "loop community id");
  return {
    catalogRowId: id ? `master_${id}` : `master_row_${index}`,
    title,
    artist: get("artist", "writer", "author"),
    vendor: get("vendor", "source", "library", "actual folder library"),
    key: get("key", "song key", "original key"),
    bpm: get("bpm", "tempo"),
    timeSignature: get("time signature", "time sig", "meter"),
    matchedFolder: get("matched folder", "folder", "local folder"),
    folderPath: get("folder path", "path")
  };
}

function matchMasterRow(songFolder, vendor, rows) {
  const folderTitle = cleanedFolderTitle(songFolder);
  const normalizedSongFolder = resolve(songFolder).toLowerCase();
  const exactPath = rows.find((row) => row.folderPath && resolve(row.folderPath).toLowerCase() === normalizedSongFolder);
  if (exactPath && !rowVendorMismatch(exactPath.vendor, vendor)) return { row: exactPath, confidence: 1 };
  const exactFolder = rows.find((row) => row.matchedFolder && row.matchedFolder.toLowerCase() === folderTitle.toLowerCase());
  if (exactFolder && !rowVendorMismatch(exactFolder.vendor, vendor)) return { row: exactFolder, confidence: 1 };
  const folderKey = normalizeTitle(folderTitle);
  const candidates = rows
    .map((row) => ({ row, confidence: titleSimilarity(folderKey, normalizeTitle(row.title)) }))
    .filter((entry) => !rowVendorMismatch(entry.row.vendor, vendor))
    .sort((a, b) => b.confidence - a.confidence || a.row.title.localeCompare(b.row.title));
  const best = candidates[0] || null;
  if (!best || best.confidence < 0.8) return { row: null, confidence: best?.confidence || 0 };
  const tied = candidates.filter((entry) => Math.abs(entry.confidence - best.confidence) < 0.02);
  if (tied.length > 1) return { row: best.row, confidence: Math.min(best.confidence, 0.89) };
  return best;
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function rowVendorMismatch(rowVendor, pathVendor) {
  if (!rowVendor || !pathVendor) return false;
  return normalizeTitle(rowVendor) && normalizeTitle(pathVendor) && !normalizeTitle(pathVendor).includes(normalizeTitle(rowVendor)) && !normalizeTitle(rowVendor).includes(normalizeTitle(pathVendor));
}

function cleanedFolderTitle(songFolder) {
  return basename(songFolder).replace(/\s+/g, " ").trim();
}

function stableSongId(vendor, songFolder, row) {
  const source = row?.catalogRowId || `${vendor}:${basename(songFolder)}`;
  return `song_${createHash("sha1").update(source.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function buildDynamicCueStatus() {
  return null;
}

function normalizeTitle(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(radio|version|original|acoustic|arr|arrangement|key|of|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeader(value) {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeTimeSignature(value) {
  const text = stringValue(value).replace(/\s+/g, "");
  const match = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return "";
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!numerator || !denominator) return "";
  return `${numerator}/${denominator}`;
}

function parseTimeSignature(value) {
  const normalized = normalizeTimeSignature(value);
  const match = normalized.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

function gridBeatSecondsForPlayback(bpm, numerator, denominator) {
  const quarterSeconds = 60 / bpm;
  if (denominator === 8 && [6, 9, 12].includes(numerator)) {
    return bpm < 100 ? quarterSeconds / 2 : quarterSeconds * (4 / denominator);
  }
  return quarterSeconds * (4 / denominator);
}

function clickBeatsForSignature(timeSignature) {
  const parsed = parseTimeSignature(timeSignature);
  if (!parsed) return [];
  if (parsed.denominator === 8 && parsed.numerator === 6) return [1, 3, 5];
  if (parsed.denominator === 8 && [6, 9, 12].includes(parsed.numerator)) {
    return Array.from({ length: parsed.numerator / 3 }, (_, index) => (index * 3) + 1);
  }
  return Array.from({ length: parsed.numerator }, (_, index) => index + 1);
}

function vendorFromPath(folderPath) {
  const parts = resolve(folderPath).split(/[\\/]+/);
  return [...parts].reverse().find((part) => VENDORS.includes(part)) || basename(dirname(folderPath)) || "Unknown";
}

function wavDurationSpread(files) {
  const durations = files.map((file) => file.durationSeconds).filter(Boolean);
  if (durations.length < 2) return 0;
  return Math.max(...durations) - Math.min(...durations);
}

async function readWavSummary(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(1024 * 1024);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const info = parseWavHeader(header.subarray(0, headerRead.bytesRead));
    if (!info?.dataBytes || !info.blockAlign || !info.sampleRate) throw new Error("Unsupported WAV file.");
    const totalFrames = Math.floor(info.dataBytes / info.blockAlign);
    return { durationSeconds: totalFrames / info.sampleRate, sampleRate: info.sampleRate, channels: info.channels };
  } finally {
    await handle.close();
  }
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

function readWavSample(buffer, offset, info) {
  const bits = Number(info.bitsPerSample);
  const format = Number(info.audioFormat);
  if (offset < 0 || offset + (bits / 8) > buffer.length) return 0;
  if (format === 3 && bits === 32) return clampSample(buffer.readFloatLE(offset));
  if (format === 3 && bits === 64) return clampSample(buffer.readDoubleLE(offset));
  if (format !== 1 && format !== 65534) return 0;
  if (bits === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bits === 16) return buffer.readInt16LE(offset) / 32768;
  if (bits === 24) return buffer.readIntLE(offset, 3) / 8388608;
  if (bits === 32) return buffer.readInt32LE(offset) / 2147483648;
  return 0;
}

function clampSample(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function atomicJsonWrite(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function canonicalMajorKey(value) {
  const normalized = stringValue(value).trim().replace(/♯/g, "#").replace(/♭/g, "b").replace(/\s+/g, "");
  if (!normalized) return "";
  const minor = /m$/i.test(normalized);
  const root = normalized.charAt(0).toUpperCase();
  const accidental = normalized.slice(1).replace(/m$/i, "");
  const candidate = `${root}${accidental}`;
  const aliases = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
  const canonical = aliases[candidate] || (KEY_OPTIONS.includes(candidate) ? candidate : "");
  return canonical ? `${canonical}${minor ? "m" : ""}` : "";
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round6(value) {
  return Number((Number(value) || 0).toFixed(6));
}

function formatDuration(seconds) {
  const whole = Math.floor(Number(seconds) || 0);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  const ms = Math.round(((Number(seconds) || 0) - whole) * 1000);
  return `${minutes}:${String(remainder).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function reason(code, message) {
  return { code, message };
}

function mergeReasonLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const normalized = typeof item === "string" ? reason(item, item) : item;
      const key = `${stringValue(normalized?.code)}:${stringValue(normalized?.message)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
  }
  return merged;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isHiddenName(name) {
  return stringValue(name).startsWith(".");
}

function isReaperName(name) {
  return /reaper/i.test(stringValue(name));
}

function ignoredTempName(name) {
  const lower = stringValue(name).toLowerCase();
  return IGNORED_NAMES.has(lower) || IGNORED_EXTENSIONS.has(extname(lower));
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

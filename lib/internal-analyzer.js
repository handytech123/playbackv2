import { createHash } from "node:crypto";
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
const IGNORED_EXTENSIONS = new Set([".rpp", ".rpp-bak", ".reapeaks", ".tmp", ".bak", ".asd", ".pkf", ".sfk"]);
const IGNORED_NAMES = new Set(["desktop.ini", "thumbs.db"]);

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
      masterRows: master.rows
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

async function analyzeSongFolder(songFolder, context) {
  const createdAt = new Date().toISOString();
  const vendor = context.vendor || vendorFromPath(songFolder);
  const wavInventory = await wavFilesForSong(songFolder);
  const titleMatch = matchMasterRow(songFolder, vendor, context.masterRows);
  const title = titleMatch.row?.title || cleanedFolderTitle(songFolder);
  const artist = titleMatch.row?.artist || "";
  const sourceKey = titleMatch.row?.key || "";
  const key = canonicalMajorKey(sourceKey);
  const bpm = positiveNumber(titleMatch.row?.bpm);
  const timeSignature = normalizeTimeSignature(titleMatch.row?.timeSignature);
  const durationSeconds = round6(Math.max(0, ...wavInventory
    .filter((file) => file.playbackRole !== "ignore")
    .map((file) => file.durationSeconds || 0)));
  const reviewReasons = [];
  const warnings = [];

  if (!titleMatch.row) reviewReasons.push(reason("title-match-review", "No confident master spreadsheet match; using folder title."));
  else if (titleMatch.confidence < 0.92) reviewReasons.push(reason("title-match-review", "Master spreadsheet title match is below strong confidence."));
  if (!KEY_OPTIONS.includes(key)) reviewReasons.push(reason("key-missing", "Trusted song key is missing or unsupported."));
  if (!bpm) reviewReasons.push(reason("bpm-missing", "Trusted BPM is missing."));
  if (!timeSignature) reviewReasons.push(reason("time-signature-missing", "Trusted time signature is missing."));
  if (!durationSeconds) reviewReasons.push(reason("duration-missing", "No readable WAV duration was found."));

  const playable = wavInventory.filter((file) => file.playLive === true && file.classificationConfidence >= PLAYABLE_CLASSIFICATION_CONFIDENCE);
  if (!playable.length) reviewReasons.push(reason("playable-stem-missing", "No playable music stem was found."));

  const durationSpread = wavDurationSpread(wavInventory.filter((file) => file.playbackRole !== "ignore"));
  if (durationSpread > 2) warnings.push(reason("wav-duration-mismatch", `Readable WAV durations differ by ${round6(durationSpread)} seconds.`));
  if (wavInventory.some((file) => file.playbackRole === "cue-reference")) {
    warnings.push(reason("cue-speech-not-run", "Internal analyzer has not run cue speech recognition yet."));
  } else {
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
    : buildCueIntelligence({ songId: songIdValue, status, songFolder, wavInventory, warnings });
  const regions = regionsHasEntries(existingRegions)
    ? preserveExistingRegions(existingRegions, { songId: songIdValue, warnings })
    : buildRegions({ songId: songIdValue, status, durationSeconds, grid });
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
      keyConfidence: key ? 1 : 0
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

  await atomicJsonWrite(join(songFolder, "song-metadata.json"), metadata);
  await atomicJsonWrite(join(songFolder, "analysis", "grid-analysis.json"), grid);
  await atomicJsonWrite(join(songFolder, "analysis", "cue-intelligence.json"), cueIntelligence);
  await atomicJsonWrite(join(songFolder, "analysis", "baseline-analysis.json"), baseline);
  await atomicJsonWrite(join(songFolder, "analysis", "regions.json"), regions);
  return { title, vendor, status, warnings, reviewReasons };
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

function buildCueIntelligence({ songId, status, songFolder, wavInventory, warnings }) {
  const cueSource = wavInventory.find((file) => file.playbackRole === "cue-reference");
  return {
    schema: "worship-playback-cue-intelligence",
    analyzerGenerated: true,
    schemaVersion: SCHEMA_VERSION,
    version: ANALYZER_VERSION,
    songId,
    status: cueSource ? "partial" : "missing",
    sourceFingerprint: createHash("sha1").update(`${songId}:${status}:${cueSource?.sha256 || ""}`).digest("hex"),
    cueSource: cueSource ? { path: cueSource.path, role: cueSource.playbackRole } : null,
    source: cueSource ? { absolutePath: join(songFolder, cueSource.path), relativePath: cueSource.path } : null,
    alignmentSource: "trusted-playback-grid",
    speechEngine: {
      cueRecognizer: "not-yet-integrated",
      cueProvider: "playback-app-internal-analyzer",
      voskStatus: "not-used"
    },
    recognizer: { engine: "not-yet-integrated", countsIgnored: true },
    cues: [],
    markers: [],
    candidates: [],
    cueMarkers: [],
    regionCandidates: [],
    inferredRegions: { status: "review", regions: [] },
    warnings
  };
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

function buildRegions({ songId, status, durationSeconds }) {
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
      status: input.key ? "trusted" : "missing",
      key: input.key,
      sourceKey: input.sourceKey,
      padKey: input.key,
      confidence: input.key ? 1 : 0,
      sourcePolicy: "master-spreadsheet"
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
    vendor: get("vendor", "source"),
    key: get("key", "song key", "original key"),
    bpm: get("bpm", "tempo"),
    timeSignature: get("time signature", "time sig", "meter")
  };
}

function matchMasterRow(songFolder, vendor, rows) {
  const folderTitle = cleanedFolderTitle(songFolder);
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
    return bpm < 100 ? quarterSeconds / 3 : quarterSeconds * (4 / denominator);
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

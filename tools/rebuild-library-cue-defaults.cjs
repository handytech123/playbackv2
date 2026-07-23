const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(APP_ROOT, "data");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const CURRENT_SETLIST_FILE = path.join(DATA_DIR, "current-setlist.json");
const SONG_METADATA_DIR = path.join(DATA_DIR, "song-metadata");
const SET_METADATA_DIR = path.join(DATA_DIR, "set-metadata", "current");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_DIR = path.join(DATA_DIR, "metadata-backups", `library-cue-rebuild-${STAMP}`);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const updateCurrentSet = !args.has("--no-current-set");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, value, backups) {
  if (dryRun) return;
  if (fs.existsSync(file)) {
    const backup = path.join(BACKUP_DIR, path.relative(DATA_DIR, file));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(file, backup);
    backups.push(backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function numberValue(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function cueName(cue, index) {
  return stringValue(cue.label || cue.target || cue.cueName || cue.normalizedText || cue.heardText || cue.rawTranscript || `Cue ${index + 1}`).trim() || `Cue ${index + 1}`;
}

function uniqueNames(items, key = "name") {
  const totals = new Map();
  for (const item of items) {
    const name = stringValue(item[key]).trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    totals.set(lower, (totals.get(lower) || 0) + 1);
  }
  const seen = new Map();
  return items.map((item) => {
    const base = stringValue(item[key]).trim();
    const lower = base.toLowerCase();
    if ((totals.get(lower) || 0) <= 1) return item;
    const count = (seen.get(lower) || 0) + 1;
    seen.set(lower, count);
    return { ...item, [key]: count === 1 ? base : `${base} ${count}` };
  });
}

function cueMarkerId(cue, index) {
  const id = stringValue(cue.id || cue.cueId || `cue-${index + 1}`).trim();
  if (!id) return `cue-${index + 1}`;
  return id.startsWith("cue-") ? id : `cue-${id}`;
}

function buildCueMarkers(cueIntel) {
  const source = Array.isArray(cueIntel.markers) && cueIntel.markers.length
    ? cueIntel.markers
    : Array.isArray(cueIntel.cues) ? cueIntel.cues : [];
  const rows = source
    .filter((cue) => ["trusted", "review", "verified"].includes(stringValue(cue.status).toLowerCase()))
    .map((cue, index) => ({
      id: cueMarkerId(cue, index),
      name: cueName(cue, index),
      bar: numberValue(cue.snappedMeasure ?? cue.targetMeasure ?? cue.cueMarker?.measure ?? cue.measure, 1),
      beat: numberValue(cue.snappedBeatInMeasure ?? cue.targetBeatInMeasure ?? cue.snappedBeat ?? cue.targetBeat ?? cue.cueMarker?.beat ?? cue.beat, 1),
      sourceCueId: stringValue(cue.id || cue.cueId),
      source: "analyzer-cue-intelligence",
      status: stringValue(cue.status || cueIntel.status || "trusted"),
      confidence: numberValue(cue.confidence?.overall ?? cue.labelConfidence ?? cue.confidence),
      heardText: cue.heardText || cue.rawTranscript || null,
      audioPhraseStartTimeSeconds: numberValue(cue.audioPhraseStartTimeSeconds),
      targetTimeSeconds: numberValue(cue.targetTimeSeconds ?? cue.snappedCueStartTimeSeconds)
    }))
    .filter((cue) => cue.name && cue.bar > 0 && cue.beat > 0)
    .sort((a, b) => (a.bar - b.bar) || (a.beat - b.beat));
  return uniqueNames(rows, "name");
}

function buildRegions(cueIntel) {
  let source = [];
  if (cueIntel.inferredRegions && Array.isArray(cueIntel.inferredRegions.regions) && cueIntel.inferredRegions.regions.length) {
    source = cueIntel.inferredRegions.regions;
  } else if (Array.isArray(cueIntel.cueToRegionCandidates)) {
    source = cueIntel.cueToRegionCandidates
      .filter((item) => ["verified", "review"].includes(item.status) && item.predictedRegion)
      .map((item) => ({
        id: `region-${item.cueId || item.cueMarkerId}`,
        name: item.cueName,
        sourceCueId: item.cueId || item.cueMarkerId,
        regionSource: "cue-to-region-verification",
        status: item.status === "verified" ? "draft" : "review",
        approved: false,
        startSeconds: item.predictedRegion.startSeconds,
        startMeasure: item.predictedRegion.startMeasure,
        startBeat: item.predictedRegion.startBeat,
        endSeconds: item.predictedRegion.endSeconds,
        endMeasure: item.predictedRegion.endMeasure,
        endBeat: item.predictedRegion.endBeat,
        lengthMeasures: numberValue(item.predictedRegion.endMeasure) && numberValue(item.predictedRegion.startMeasure)
          ? numberValue(item.predictedRegion.endMeasure) - numberValue(item.predictedRegion.startMeasure)
          : null
      }));
  }

  const rows = source
    .map((region, index) => ({
      id: stringValue(region.id || `region-${index + 1}`).replace(/^region_/, "region-"),
      name: stringValue(region.name || region.label || `Region ${index + 1}`).trim() || `Region ${index + 1}`,
      startBar: numberValue(region.startMeasure ?? region.startBar, 1),
      startBeat: numberValue(region.startBeat ?? region.startBeatInMeasure, 1),
      endBar: numberValue(region.endMeasure ?? region.endBar),
      endBeat: numberValue(region.endBeat ?? region.endBeatInMeasure, 1),
      sourceCueId: region.sourceCueId || null,
      source: region.regionSource || "cue-to-region-verification",
      status: region.status || "draft",
      approved: region.approved === true,
      startSeconds: numberValue(region.startSeconds),
      endSeconds: numberValue(region.endSeconds),
      lengthMeasures: numberValue(region.lengthMeasures)
    }))
    .filter((region) => region.name && region.startBar > 0 && region.endBar && (region.endBar > region.startBar || (region.endBar === region.startBar && region.endBeat > region.startBeat)))
    .sort((a, b) => (a.startBar - b.startBar) || (a.startBeat - b.startBeat));
  return uniqueNames(rows, "name");
}

function gridReference(grid) {
  const beatGrid = Array.isArray(grid.beatGrid) ? grid.beatGrid : Array.isArray(grid.beats) ? grid.beats : [];
  const measureCount = beatGrid.reduce((max, beat) => Math.max(max, numberValue(beat.measure, 0)), 0);
  return {
    status: stringValue(grid.status),
    bpm: numberValue(grid.bpm ?? grid.normalizedBpm ?? grid.tempoMap?.[0]?.bpm),
    timeSignature: grid.timeSignature || null,
    measureCount,
    beatCount: beatGrid.length,
    gridFile: "analysis/grid-analysis.json"
  };
}

function buildReport(song, cueIntel, grid, cueMarkers, regions) {
  return {
    generatedAt: new Date().toISOString(),
    slot: null,
    songId: song.id,
    analyzerSongId: cueIntel.songId || null,
    title: song.title,
    sourceFolder: song.folderPath,
    sourceReport: "analysis/cue-intelligence.json",
    recognizer: cueIntel.speechEngine?.cueRecognizer || cueIntel.speechEngine?.cueProvider || "vosk-closed-grammar",
    status: cueIntel.status || "unknown",
    summary: cueIntel.summary || { cueCandidateCount: cueMarkers.length, regionCandidateCount: regions.length },
    gridReference: gridReference(grid),
    source: cueIntel.source || cueIntel.cueSourceWavPath || null,
    candidates: cueMarkers.map((cue) => ({
      id: cue.id.replace(/^cue-/, ""),
      label: cue.name,
      normalizedPhrase: cue.heardText || cue.name,
      rawTranscript: cue.heardText || cue.name,
      status: cue.status,
      snappedMeasure: cue.bar,
      snappedBeat: cue.beat,
      targetMeasure: cue.bar,
      targetBeat: cue.beat,
      confidence: cue.confidence
    })),
    regionCandidates: regions.map((region) => ({
      id: region.id.replace(/^region-/, ""),
      status: "verified",
      sourceCueCandidateId: stringValue(region.sourceCueId).replace(/^cue-/, ""),
      sourceCueText: region.name,
      startMeasure: region.startBar,
      startBeat: region.startBeat,
      endMeasure: region.endBar,
      endBeat: region.endBeat,
      confidence: 0.9
    }))
  };
}

function buildDynamicCueMap(song, cueMarkers) {
  return {
    generatedAt: new Date().toISOString(),
    recognizer: "vosk-closed-grammar",
    sourceReport: "cue-recognition-report.json",
    slot: null,
    songId: song.id,
    title: song.title,
    dynamicCueFolder: "",
    availableCueCount: 0,
    entries: cueMarkers.map((cue) => ({
      candidateId: cue.id.replace(/^cue-/, ""),
      label: cue.name,
      phrase: cue.heardText || cue.name,
      command: "normal",
      status: "not-configured",
      triggerMeasure: cue.bar,
      triggerBeat: cue.beat,
      targetMeasure: cue.bar,
      targetBeat: cue.beat,
      parts: []
    }))
  };
}

function rebuildSong(song, slotsBySongId) {
  const cuePath = path.join(song.folderPath, "analysis", "cue-intelligence.json");
  const gridPath = path.join(song.folderPath, "analysis", "grid-analysis.json");
  const cueIntel = readJson(cuePath);
  const grid = readJson(gridPath);
  const cueMarkers = buildCueMarkers(cueIntel);
  const regions = buildRegions(cueIntel);
  const report = buildReport(song, cueIntel, grid, cueMarkers, regions);
  const defaultCues = {
    cueMarkers,
    dynamicCueMatching: "fuzzy-name",
    source: "analyzer-cue-intelligence",
    updatedAt: new Date().toISOString()
  };
  const defaultRegions = {
    regions,
    source: "analyzer-cue-intelligence-inferred-regions",
    regionSource: "inferred-from-cues",
    status: "review",
    updatedAt: new Date().toISOString()
  };
  const dynamicCueMap = buildDynamicCueMap(song, cueMarkers);
  const metadataDir = path.join(SONG_METADATA_DIR, song.id);
  const backups = [];
  writeJson(path.join(metadataDir, "cue-recognition-report.json"), report, backups);
  writeJson(path.join(metadataDir, "default-cue-markers.json"), defaultCues, backups);
  writeJson(path.join(metadataDir, "default-regions.json"), defaultRegions, backups);
  writeJson(path.join(metadataDir, "dynamic-cue-map.json"), dynamicCueMap, backups);

  if (updateCurrentSet) {
    for (const slot of slotsBySongId.get(song.id) || []) {
      const slotDir = path.join(SET_METADATA_DIR, `slot-${String(slot.slot).padStart(2, "0")}`);
      writeJson(path.join(slotDir, "cue-recognition-report.json"), { ...report, slot: slot.slot }, backups);
      writeJson(path.join(slotDir, "cue-markers.json"), defaultCues, backups);
      writeJson(path.join(slotDir, "regions.json"), defaultRegions, backups);
      writeJson(path.join(slotDir, "dynamic-cue-map.json"), { ...dynamicCueMap, slot: slot.slot }, backups);
    }
  }

  return {
    songId: song.id,
    title: song.title,
    status: report.status,
    cueCount: cueMarkers.length,
    regionCount: regions.length,
    currentSetSlots: (slotsBySongId.get(song.id) || []).map((slot) => slot.slot),
    backups: backups.length
  };
}

function main() {
  const library = readJson(LIBRARY_FILE);
  const setlist = readJson(CURRENT_SETLIST_FILE, { slots: [] });
  const slotsBySongId = new Map();
  for (const slot of setlist.slots || []) {
    if (!slot.songId) continue;
    if (!slotsBySongId.has(slot.songId)) slotsBySongId.set(slot.songId, []);
    slotsBySongId.get(slot.songId).push(slot);
  }

  const results = [];
  const failures = [];
  for (const song of library.songs || []) {
    try {
      results.push(rebuildSong(song, slotsBySongId));
      console.log(`[cue-defaults] ${results.length}/${library.songs.length} ${song.title}`);
    } catch (error) {
      failures.push({ songId: song.id, title: song.title, folderPath: song.folderPath, error: error.message });
      console.log(`[cue-defaults:failed] ${song.title}: ${error.message}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    dryRun,
    total: (library.songs || []).length,
    rebuilt: results.length,
    failures: failures.length,
    cueTotal: results.reduce((sum, row) => sum + row.cueCount, 0),
    regionTotal: results.reduce((sum, row) => sum + row.regionCount, 0),
    updatedCurrentSlots: results.reduce((sum, row) => sum + row.currentSetSlots.length, 0),
    backupDir: dryRun ? null : BACKUP_DIR,
    results,
    failureDetails: failures
  };
  if (!dryRun) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, `library-cue-rebuild-${STAMP}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failures.length ? 2 : 0;
}

main();

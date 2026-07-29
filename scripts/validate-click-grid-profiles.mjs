import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const failures = [];

function includes(pattern, message) {
  if (!server.includes(pattern)) failures.push(message);
}

function excludes(pattern, message) {
  if (server.includes(pattern)) failures.push(message);
}

includes("const fileName = clickPatternFileForTempoMap(timeSignature, tempoMap);", "Dynamic click must choose pattern files through the profile-aware selector.");
includes("function clickPatternFileForTempoMap(timeSignature, tempoMap = {})", "Playback must keep an explicit click-pattern selector.");
includes("return \"6-8-six-clicks.wav\";", "Playback must support the 6/8 six-click pattern file.");
includes("return CLICK_PATTERN_FILES[timeSignature];", "Playback must keep the regular time-signature pattern fallback.");
includes("positiveNumber(sourceTempoMap.gridBeatSeconds)", "Playback grid must honor analyzer gridBeatSeconds when present.");
includes("gridBeatSeconds: positiveNumber(grid.gridTiming?.gridBeatSeconds)", "Imported analyzer grid timing must carry gridBeatSeconds into the tempo map.");
includes("measureSeconds: positiveNumber(grid.gridTiming?.measureSeconds)", "Imported analyzer grid timing must carry measureSeconds into the tempo map.");
includes("clickBeats: Array.isArray(grid.gridTiming?.clickBeats) ? grid.gridTiming.clickBeats : []", "Imported analyzer grid timing must carry clickBeats into the tempo map.");
includes("clickProfile: grid.gridTiming?.clickProfile || null", "Imported analyzer grid timing must carry clickProfile into the tempo map.");
includes("return bpm < 100 ? quarterSeconds / 3 : quarterSeconds * (4 / denominator);", "Compound 6/8, 9/8, and 12/8 grid timing must choose low-BPM dotted-quarter style or high-BPM eighth-note style.");
includes("if (displayTimeSignature(timeSignature) === \"6/8\" && clickBeats.length === 6)", "Only a six-beat analyzer signal should select 6-8-six-clicks.wav.");
includes("if (hits.length >= 6)", "6/8 six-click templates must map all six hits to all six grid beats.");
includes("if (/6-8-six-clicks\\.wav$/i.test(stringValue(filePath))) return 6;", "6-8-six-clicks.wav must extract six pattern hits, not the default three compound-pulse hits.");
includes("const inferredRegionsApproved = inferredRegions", "Playback must explicitly gate analyzer inferred regions before using them.");
includes("Analyzer inferred regions were not approved for playback.", "Playback must leave a diagnostic when analyzer inferred regions are only review/draft data.");
includes("\"derived-from-cue-lead-rule\"", "Playback cleanup must remove legacy cue-lead-rule defaults when source metadata changes.");
includes("gridSpacingMatchesExpected(sourceGridBeatSeconds, expectedGridBeatSeconds)", "Playback must reject source beat grids whose spacing disagrees with trusted BPM/time signature.");
includes("source-grid-spacing-mismatch-rebuilt-from-bpm-time-signature", "Playback must report when it rebuilds a mismatched source grid from trusted BPM/time signature.");
excludes("const fileName = CLICK_PATTERN_FILES[timeSignature];", "Dynamic click must not choose 6/8 files only from time signature.");
excludes("source: predictedRegionStartFromCandidate(entry.candidate) ? \"derived-from-analyzer-predicted-region-start\" : \"derived-from-cue-lead-rule\"", "Playback must not infer region starts from cue markers when analyzer regions are not verified.");
excludes("source: regions.length ? \"derived-from-cue-lead-rule\" : \"empty-default\"", "Playback must not create default region maps from cue lead rules.");
excludes("[\"trusted\", \"verified\", \"draft\"].includes(stringValue(region.status))", "Playback must not promote draft analyzer regions to verified regions.");

if (failures.length) {
  console.error("Click/grid profile validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Click/grid profile validation passed.");

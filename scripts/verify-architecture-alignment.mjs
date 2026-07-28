import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dataDir = process.env.PLAYBACK_DATA_DIR || join(root, "data");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

async function readText(path) {
  return readFile(join(root, path), "utf8");
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function includes(text, pattern, message) {
  if (!text.includes(pattern)) fail(message);
}

function excludes(text, pattern, message) {
  if (text.includes(pattern)) fail(message);
}

function beatKey(measure, beat) {
  return `${Number(measure)}.${Number(beat)}`;
}

function timeForGrid(beatGrid, measure, beat) {
  const exact = beatGrid.find((item) => Number(item.measure) === Number(measure) && Number(item.beat || item.beatInMeasure) === Number(beat));
  return Number.isFinite(Number(exact?.timeSeconds)) ? Number(exact.timeSeconds) : null;
}

function routeChannels(route) {
  return Array.isArray(route?.outputChannels) ? route.outputChannels.map(Number).filter((channel) => Number.isFinite(channel) && channel > 0) : [];
}

function assertPresetRoute(route, label) {
  const channels = routeChannels(route);
  if (!channels.length) fail(`${label}: route has no output channels.`);
  if (route?.source !== "routing-preset") fail(`${label}: route is not owned by the selected routing preset.`);
}

const [server, app, remote, juce] = await Promise.all([
  readText("server.js"),
  readText("public/app.js"),
  readText("public/remote.js"),
  readText("native/juce-audio-engine/src/Main.cpp")
]);

includes(server, "triggerTimeSeconds: timeForCueMarker(cue, tempoMap)", "Dynamic cue manifest must compute trigger time from final bar/beat grid.");
excludes(server, "nonNegativeNumber(cue.triggerTimeSeconds) ?? timeForCueMarker", "Dynamic cue manifest must not trust stale cue.triggerTimeSeconds.");
excludes(server, "sectionCueLeadInTime", "Section cue phrases must not use an artificial lead-in offset.");
excludes(server, "beatDurationNearCue", "Cue phrase timing must not use BPM-derived lead-in offsets.");
excludes(server, "triggerTimeSeconds: Math.max(0, Number(block.arrangedStartSeconds", "Arrangement cues must not preserve raw-time trigger offsets.");

includes(server, "queuePanicReleaseFromState", "Backend must own Panic release queue creation.");
includes(server, "state.panic?.active === true && (action === \"panic\" || (action === \"exitPanic\"", "Backend must intercept second Panic/Exit Panic as queue requests.");
includes(server, "state.panic?.active === true && action === \"jumpRegion\"", "Backend must intercept Panic-time region recovery requests.");
includes(server, "const recoveryMode = stringValue(payload.recoveryMode) === \"now\" ? \"now\" : \"boundary\";", "Panic recovery must support explicit Now/Boundary recovery modes.");
includes(server, "const executeTarget = requested && recoveryMode === \"boundary\"", "Panic recovery Boundary mode must wait for a musical boundary before re-entry.");
includes(server, "executeSeconds: executeTarget.seconds", "Panic recovery must execute at the selected mode's target boundary.");
includes(server, "targetSeconds: target.seconds", "Panic recovery must preserve the selected recovery region target.");
includes(remote, "recoveryMode: remote.recoveryMode", "Remote Panic recovery must send the selected Now/Boundary mode to the backend.");
excludes(server, "executeSeconds: execute?.seconds ?? target.seconds", "Panic recovery must not use the old implicit next-region fallback.");
excludes(server, ": await triggerPanicRecoveryCue(liveSong, payload);", "Exit Panic must not fire a late recovery cue; the supervisor must fire it at the regular cue marker.");
includes(server, "Array.isArray(liveSong.cueMarkers)", "Panic recovery must find regular cue markers from manifest cueMarkers.");
includes(server, "Panic recovery cue is not scheduled.", "Panic recovery cue must be rejected when no regular cue marker is scheduled.");
includes(server, "Cue point already passed.", "Panic recovery must skip late cues instead of firing them after the regular cue marker.");
includes(server, "allowScheduledDynamicCuePrefix", "Panic recovery must allow the target regular scheduled cue through JUCE suppression.");
includes(juce, "allowScheduledDynamicCuePrefix", "JUCE must support allowing a target scheduled cue during Panic suppression.");
includes(juce, "cue.id.startsWith(allowedScheduledCuePrefix)", "JUCE must allow target cue count entries by cue-id prefix.");
excludes(server, "await fadeRecoverLiveMusicAndPad(liveSong, PANIC_RECOVERY_FADE_MS);", "Exit Panic must update state at the recovery boundary while the fade continues.");
excludes(app, "queuePanicRecoveryToRegion(slot, region);", "Main app must not locally queue Panic region recovery.");
excludes(remote, "queuePanicRecoveryToRegion(entry);", "Remote must not locally queue Panic region recovery.");
excludes(remote, "function queuePanicExitRecovery()", "Remote must not own Panic release queue timing.");
excludes(app, "function servicePanicRecovery(", "Main app must not own Panic release timing.");
excludes(remote, "function servicePanicRecovery(", "Remote must not own Panic release timing.");
includes(app, "playback.panic?.recoveryTarget?.pending", "Main app must consume backend Panic recoveryTarget.");
includes(remote, "playback.panic?.recoveryTarget?.pending", "Remote must display backend Panic recoveryTarget.");
includes(server, "triggerPanicRecoveryCue", "Backend live supervisor must trigger Panic recovery cues.");
includes(remote, "remote.commandInFlight", "Remote must guard against duplicate live command taps.");

includes(server, "liveRepeatCuePlanForCommand", "Backend must own live repeat cue timing plan creation.");
includes(server, "repeatCuePlan: mode ? normalizeRepeatCuePlan", "Live repeat state must carry backend repeat cue timing plan.");
excludes(app, "function serviceRegionRepeat(", "Main app must not own live repeat execution.");
excludes(app, "function serviceRepeatCueTrigger(", "Main app must not own live repeat cue timing.");
excludes(app, "repeatCueLeadGridBeats", "Main app must not calculate repeat cue lead timing locally.");

includes(server, "beatGrid: normalizeBeatGrid(value.beatGrid)", "Backend tempo map must normalize analyzer beatGrid.");
includes(server, "extendTempoMapForSongPositions", "Backend must extend tail grids when song regions/cues require trailing beats.");
excludes(juce, "readSongClickGrid", "JUCE must not generate dynamic click from manifest click grid.");
excludes(juce, "readDynamicClickPath", "JUCE must not load old click/accent dynamic click samples.");
excludes(juce, "setDynamicClick", "JUCE must not own dynamic click sample triggering.");
includes(juce, "cue.triggerTimeSeconds", "JUCE dynamic cues must consume manifest triggerTimeSeconds.");
excludes(juce, "samplesSinceClick", "JUCE must not run BPM fallback dynamic click generation.");

includes(server, "waveform-v2-music-only:5", "Waveform fingerprint must identify music-only waveform generation.");
includes(server, "positiveNumber(existing.tracksUsed) > 0", "Waveform cache must not reuse blank summaries with no scanned audio.");
includes(server, "existing.peaks.some((peak) => Number(peak) > 0)", "Waveform cache must not reuse all-zero peak summaries.");
includes(server, "if ([\"click\", \"cues\", \"dynamicCue\"].includes(bus)) return false;", "Waveform generation must exclude click/cue/dynamic cue buses.");
includes(server, "applyWavShiftIfNeeded", "Audio alignment shifts must be applied in backend cache pipeline.");
includes(app, "ensureSetlistWaveforms", "Main app must warm waveform summaries for every loaded setlist song, not only the selected song.");
includes(app, "ensureSlotWaveform(Number(slot.slot))", "Setlist waveform warm-up must request each populated slot.");

includes(server, "refreshEngineManifestForMixer", "Mixer changes must refresh confirmed engine manifest.");
includes(server, "updateDynamicMixer", "Live mixer updates must flow to JUCE dynamic mixer.");
includes(server, "routeForStem", "Routing must be backend-derived from routing preset.");
includes(server, "sampleRate: settings.audioEngine?.sampleRate || 48000", "Server must pass the selected audio sample rate to JUCE probe/playback.");
includes(juce, "requestedSampleRate", "JUCE must accept the requested audio sample rate from the server.");
includes(juce, "setup.sampleRate = requestedSampleRate", "JUCE playback setup must apply the requested sample rate.");
includes(server, "startLiveSupervisor", "Server must own the live supervisor loop for critical timed actions.");
includes(server, "serviceLiveRepeatBackend", "Server must supervise live repeat execution.");
includes(server, "servicePanicRecoveryBackend", "Server must supervise Panic recovery execution.");
includes(server, "serviceSongEndBackend", "Server must supervise song-end transitions/stops.");
excludes(app, "function serviceSongEndLifecycle(", "Main app must not own song-end stop/transition timing.");
excludes(app, "function serviceSetlistTransition(", "Main app must not own setlist transition timing.");
includes(server, "liveSupervisor: {", "System check must expose live supervisor status.");
includes(server, "await playbackCommandQueue;", "Live supervisor must wait behind queued playback commands before reading state.");
includes(server, "engine-lost-stop", "Live supervisor must stop stale playing state when the native engine is gone.");
excludes(server, "function markLiveRepeatActionInFlight", "Live supervisor must not bypass command queue with direct repeat in-flight state writes.");
includes(server, "liveCommandCueReadiness", "System check must validate live repeat/Panic cue assets.");
includes(server, "Repeat.wav is missing", "System check must block missing Repeat.wav for live repeat.");
includes(server, "Panic recovery", "System check must validate Panic recovery cue readiness.");
includes(server, "padFolderReadiness", "System check must validate dynamic pad folder readiness.");
includes(server, "Songs in those keys will not have dynamic pad", "System check must warn when the app pad folder is missing keys.");
includes(app, "await runSystemCheck();", "Host reload/refresh flows must surface backend health warnings immediately.");

const manifest = await readJson(join(dataDir, "playback-engine-manifest.json"), { songs: [] });
const songs = Array.isArray(manifest.songs) ? manifest.songs : [];
if (!songs.length) {
  note("No manifest songs found; runtime alignment checks skipped.");
} else {
  for (const song of songs) {
    const beatGrid = Array.isArray(song.tempoMap?.beatGrid) ? song.tempoMap.beatGrid : [];
    if (!beatGrid.length) {
      fail(`Slot ${song.slot} ${song.title}: manifest has no beatGrid.`);
      continue;
    }
    const beatTimes = new Map();
    for (const beat of beatGrid) beatTimes.set(beatKey(beat.measure, beat.beat || beat.beatInMeasure), Number(beat.timeSeconds));

    for (const cue of Array.isArray(song.dynamicCues) ? song.dynamicCues : []) {
      const gridTime = timeForGrid(beatGrid, cue.bar, cue.beat);
      if (gridTime === null) {
        fail(`Slot ${song.slot} ${song.title}: dynamic cue ${cue.cueName} points to missing grid ${cue.bar}.${cue.beat}.`);
        continue;
      }
      const diff = Math.abs(Number(cue.triggerTimeSeconds) - gridTime);
      if (diff > 0.002) {
        fail(`Slot ${song.slot} ${song.title}: dynamic cue ${cue.cueName} at ${cue.bar}.${cue.beat} differs from grid by ${diff.toFixed(6)}s.`);
      }
    }

    for (const event of Array.isArray(song.dynamicClick?.clickEvents) ? song.dynamicClick.clickEvents : []) {
      if (!Number.isFinite(Number(event.timeSeconds))) fail(`Slot ${song.slot} ${song.title}: dynamic click event missing timeSeconds.`);
      if (event.source === "click-pattern-template-beat-grid") {
        const gridTime = timeForGrid(beatGrid, event.measure, event.beat);
        if (gridTime === null) {
          fail(`Slot ${song.slot} ${song.title}: dynamic click event points to missing grid ${event.measure}.${event.beat}.`);
          continue;
        }
        const diff = Math.abs(Number(event.timeSeconds) - gridTime);
        if (diff > 0.002) {
          fail(`Slot ${song.slot} ${song.title}: dynamic click event at ${event.measure}.${event.beat} differs from grid by ${diff.toFixed(6)}s.`);
        }
      }
      if (event.source === "click-pattern-template-measure-subdivision") {
        const measureStart = timeForGrid(beatGrid, event.measure, 1);
        const nextMeasureStart = timeForGrid(beatGrid, Number(event.measure) + 1, 1);
        const numerator = Number(String(song.tempoMap?.timeSignature || "").split("/")[0]) || 0;
        if (measureStart === null || nextMeasureStart === null || !numerator) {
          fail(`Slot ${song.slot} ${song.title}: dynamic click subdivision event cannot resolve measure ${event.measure}.`);
          continue;
        }
        const expectedTime = measureStart + (((nextMeasureStart - measureStart) / numerator) * (Number(event.beat) - 1));
        const diff = Math.abs(Number(event.timeSeconds) - expectedTime);
        if (diff > 0.002) {
          fail(`Slot ${song.slot} ${song.title}: dynamic click subdivision at ${event.measure}.${event.beat} differs from grid subdivision by ${diff.toFixed(6)}s.`);
        }
      }
    }

    for (const region of Array.isArray(song.regions) ? song.regions : []) {
      if (timeForGrid(beatGrid, region.startBar, region.startBeat) === null) {
        fail(`Slot ${song.slot} ${song.title}: region ${region.name} start ${region.startBar}.${region.startBeat} is missing from beatGrid.`);
      }
    }

    for (const stem of Array.isArray(song.stems) ? song.stems : []) {
      assertPresetRoute(stem.routing, `Slot ${song.slot} ${song.title}: stem ${stem.name || stem.id}`);
      if (stem.iemRouting) {
        if (stem.role !== "tracks" && stem.playbackRole !== "music-stem") {
          fail(`Slot ${song.slot} ${song.title}: non-music stem ${stem.name || stem.id} is routed to IEM.`);
        }
        assertPresetRoute(stem.iemRouting, `Slot ${song.slot} ${song.title}: IEM send ${stem.name || stem.id}`);
      }
    }

    const renderedClickStem = (Array.isArray(song.stems) ? song.stems : []).find((stem) => stem.id === "dynamic-click" && stem.playbackRole === "dynamic-click-render");
    if (!renderedClickStem) {
      fail(`Slot ${song.slot} ${song.title}: rendered dynamic-click stem is missing.`);
    } else if (!renderedClickStem.cachePath) {
      fail(`Slot ${song.slot} ${song.title}: rendered dynamic-click stem has no cachePath.`);
    }

    assertPresetRoute(song.dynamicClick?.routing, `Slot ${song.slot} ${song.title}: dynamic click`);
    assertPresetRoute(song.dynamicCue?.routing, `Slot ${song.slot} ${song.title}: dynamic cue`);
    assertPresetRoute(song.dynamicPad?.routing, `Slot ${song.slot} ${song.title}: dynamic pad`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures, notes }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checkedSongs: songs.length,
  checks: 65,
  notes
}, null, 2));

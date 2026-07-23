# JUCE Audio Engine Protocol

The Node app controls `juce-audio-engine` through local HTTP/JSON. The native helper must bind to `127.0.0.1` only.

## Control Shape

- Node owns the UI API, library scan, setlist, Confirm Set, cache rebuild, set metadata, and engine manifest.
- JUCE owns audio devices, low-latency playback, routing, meters, dynamic click, dynamic cue playback, and transport execution.
- The simulator is API-only. It should not expose product UI controls.
- Confirm Set may complete when the saved audio device is missing, but Performance remains blocked until readiness passes.

## Node Endpoints

- `GET /api/engine/status`: returns current engine state, selected device, manifest path, and heartbeat state.
- `POST /api/engine/heartbeat`: records a real JUCE heartbeat. Performance requires a fresh heartbeat.
- `GET /api/engine/manifest`: returns the confirmed engine snapshot summary for troubleshooting.
- `PUT /api/engine/simulate`: development-only state control for API smoke tests.

## Helper Responsibilities

- Expose ASIO, WASAPI, CoreAudio, ALSA/JACK, Dante Virtual Soundcard, USB, Thunderbolt, and other JUCE-visible devices where supported by the platform.
- Open the saved default device only. If it is missing, report device missing and wait.
- Load `data/playback-engine-manifest.json` after Confirm Set.
- Verify every cache path before arming Performance.
- Send heartbeat updates at least once per second while ready.
- Reject Performance if cache, device, routing, or sample-rate preparation is invalid.

## Manifest Requirements

The manifest must include:

- confirmed set fingerprint and timestamp
- selected sample rate, either 44.1 kHz or 48 kHz
- active routing preset
- dynamic cue folder and dynamic click folder
- each filled setlist slot
- each cached stem with source-relative path, cache path, detected role, and routing

Default stem routing is stem 1 to output 1, stem 2 to output 2, and so on, unless the active routing preset overrides it. Click, cue/guide, and pad stems may be detected by filename for routing.

## Required Commands

These commands are sent through the Node control API and then executed by JUCE:

- `play`, `pause`, `stop`, `fadeOut`, `panic`, `restart`
- `nextSong`, `previousSong`, `seek`
- `jumpRegion`, `skipRegion`, `repeatRegion`, `loopRegion`
- `setStemControl`: volume and solo only
- `setRoutingPreset`: apply global routing preset
- `setDynamicCueFolder`: set the global cue WAV folder
- `setDynamicClickSound`: set the preferred click sound

## Required Events

- `transport`: stopped, playing, paused, fading, panic
- `position`: current song, seconds, bar, beat
- `meters`: per-stem, click, dynamic cue, master
- `deviceMissing`: saved device cannot be opened; app must warn and wait
- `cacheInvalid`: confirmed cache cannot be used
- `heartbeatLost`: no heartbeat inside the 3-second grace period
- `commandRejected`: command was understood but cannot run in the current state

## Audio Rules

- Performance mode reads only the confirmed snapshot and local cache.
- The engine must support 44.1 kHz and 48 kHz operation.
- Any mismatched source WAV must be rendered or converted into the cache before Performance.
- Dynamic click is generated live from the confirmed tempo map and region actions.
- Dynamic cue markers trigger WAVs from the global dynamic cue folder and route only to the dynamic cue output.
- Panic stops stems, dynamic click, dynamic cue, and pads immediately.
- Panic recovery is operator-triggered and fades stems back in over 4 seconds.

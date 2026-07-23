# Playback App V2 Engine Contract

This app is JUCE-first for real audio playback. The Node server owns the library, setlist, cache, metadata files, and UI API. The native helper owns low-latency audio, device selection, routing, meters, transport execution, dynamic click, and dynamic cue playback.

## V2 Rules

- The engine helper name is `juce-audio-engine`.
- Node controls the helper through local HTTP/JSON on `127.0.0.1`.
- The app never uses Dropbox during Edit or Performance playback.
- Library refresh reads analyzer-produced `song-metadata.json`; it does not load audio or infer missing song facts from alternate sources.
- `song-metadata.json` is the authority for key, BPM, time signature, duration, stem role, stem bus, sample rate, channel count, SHA-256, and live-play eligibility.
- The WAV Song Analyzer remains a separate offline prep/import tool. V2 playback consumes its exported metadata instead of embedding the analyzer.
- Adding a song to the setlist does not load audio.
- Confirm Set creates the immutable Performance snapshot and rebuilds the local cache.
- Performance mode must use the confirmed snapshot and local cache only.
- Missing selected audio device allows Confirm Set, but blocks Performance with warn-and-wait readiness.
- The engine heartbeat is required before Performance and has a 3-second grace period.
- Supported project sample rates are 44.1 kHz and 48 kHz.
- Any stem sample-rate mismatch must be converted before Performance.
- Original song WAVs are never edited.
- Set-specific regions, cue markers, tempo maps, and mixer settings live under `data/set-metadata/current`.
- The engine manifest includes full per-stem cache paths and routing.
- Default stem routing is stem 1 to output 1, stem 2 to output 2, and so on, unless a routing preset overrides it.
- Live playback stems come from metadata entries marked `playLive: true`. Reference click/cue files are not shown in the normal mixer.
- A collapsed Engine Snapshot readout can remain in Settings for troubleshooting.
- Settings follow the Playback-style shape: Library, Audio, Routing, Playback, and Advanced.
- Audio settings expose the saved default device until real JUCE discovery is connected.
- Playback settings expose a cache report for each filled setlist slot.
- Routing settings expose editable bus output assignments on the active preset.
- The bottom operator layer uses Tracks, Buses, and Pads views.
- Track mixer volume and solo are set-specific metadata, saved with the current set.
- Mixer volume, solo, and bus assignment can be saved through a mixer-only path during Performance.
- Playback commands that require audio are rejected until Confirm Set and readiness checks pass.
- Stop and Panic remain available as safety commands.
- The transport tracks a current playback slot separately from the selected editing slot.
- Confirm Set manifest includes set tempo map, regions, cue markers, dynamic cue matches, dynamic click settings, and mixer volume/solo/bus.
- Advanced settings include a single error check for library, app data, setlist metadata, cache, and manifest consistency.

## V1 Mismatch Fixes

- No v1 library data fallback is allowed.
- No stale setlist folder path fallback is allowed during cache preparation.
- No browser-audio playback should be treated as the production engine.
- No automatic alternate audio-device selection when the saved device is missing.
- No live playback should stream from Dropbox.
- No cue or click routing should share the normal stem mixer unless explicitly routed by the JUCE engine contract.
- No visible simulator controls in the product UI; simulator control is API-only.

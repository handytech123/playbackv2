# JUCE Audio Engine Helper

This folder is the V2 native audio target. It is intentionally small right now: the web app can keep moving while the real-time engine is built behind a clear contract.

## Responsibilities

- Open professional audio devices through JUCE.
- Support ASIO, WASAPI, CoreAudio, ALSA/JACK, Dante Virtual Soundcard, USB, and Thunderbolt devices where the platform exposes them.
- Load only confirmed set snapshots and local cache files.
- Execute transport and live region commands with low latency.
- Generate dynamic click live.
- Trigger dynamic cue WAVs through the dynamic cue output.
- Report real-time meters.

## Build

This scaffold uses CMake and JUCE FetchContent. A production build should pin JUCE to a known commit before release.

```powershell
cmake -S native\juce-audio-engine -B native\juce-audio-engine\build
cmake --build native\juce-audio-engine\build --config Release
```

The built executable should be started by Node as `juce-audio-engine`.


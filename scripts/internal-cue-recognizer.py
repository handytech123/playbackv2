from __future__ import annotations

import json
import sys
import wave
from pathlib import Path


def detect_cue_bursts(cue_path: Path) -> list[dict]:
    import numpy as np

    with wave.open(str(cue_path), "rb") as wav:
        sample_rate = wav.getframerate()
        channel_count = wav.getnchannels()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    dtype_by_width = {1: np.uint8, 2: np.int16, 4: np.int32}
    dtype = dtype_by_width.get(sample_width)
    if dtype is None:
        return []

    audio = np.frombuffer(raw, dtype=dtype).astype(np.float32)
    if sample_width == 1:
        audio = (audio - 128.0) / 128.0
    else:
        audio = audio / float(2 ** ((8 * sample_width) - 1))
    if channel_count > 1:
        audio = audio.reshape(-1, channel_count).mean(axis=1)

    frame_size = max(1, int(sample_rate * 0.05))
    hop_size = max(1, int(sample_rate * 0.025))
    rms = []
    times = []
    for index in range(0, max(0, len(audio) - frame_size), hop_size):
        frame = audio[index:index + frame_size]
        rms.append(float(np.sqrt(np.mean(frame * frame))))
        times.append(index / sample_rate)

    if not rms:
        return []

    rms_values = np.asarray(rms)
    floor = float(np.percentile(rms_values, 35))
    peak = float(np.percentile(rms_values, 98))
    threshold = max(floor * 6.0, peak * 0.12, 0.005)
    active = rms_values > threshold

    groups = []
    start = None
    end = None
    for time_value, is_active in zip(times, active):
        if is_active and start is None:
            start = time_value
        if is_active:
            end = time_value
        if not is_active and start is not None:
            if end - start > 0.12:
                groups.append((start, end))
            start = None
            end = None
    if start is not None and end is not None and end - start > 0.12:
        groups.append((start, end))

    merged = []
    for start_time, end_time in groups:
        if merged and start_time - merged[-1][1] < 1.2:
            merged[-1] = (merged[-1][0], end_time)
        else:
            merged.append((start_time, end_time))

    return [
        {
            "start": round(float(start_time), 6),
            "end": round(float(end_time), 6),
            "confidence": 0.9,
        }
        for start_time, end_time in merged
    ]


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: internal-cue-recognizer.py <cue-wav> <model-path>"}))
        return 2

    cue_path = Path(sys.argv[1])
    model_path = Path(sys.argv[2])
    if not cue_path.exists():
        print(json.dumps({"ok": False, "error": f"cue wav not found: {cue_path}"}))
        return 1
    if not model_path.exists():
        print(json.dumps({"ok": False, "error": f"whisper model not found: {model_path}"}))
        return 1

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(str(model_path), device="cpu", compute_type="int8", local_files_only=True)
        segments, info = model.transcribe(str(cue_path), language="en", vad_filter=True)
        payload = {
            "ok": True,
            "engine": "faster-whisper",
            "language": getattr(info, "language", "en"),
            "duration": getattr(info, "duration", None),
            "sourcePath": str(cue_path),
            "modelPath": str(model_path),
            "cueBursts": detect_cue_bursts(cue_path),
            "segments": [],
        }
        for segment in segments:
            no_speech = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
            payload["segments"].append({
                "start": round(float(segment.start), 6),
                "end": round(float(segment.end), 6),
                "text": str(segment.text or "").strip(),
                "noSpeechProbability": round(no_speech, 6),
                "confidence": round(max(0.0, min(1.0, 1.0 - no_speech)), 6),
            })
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "sourcePath": str(cue_path)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

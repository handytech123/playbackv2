const remote = {
  playback: null,
  setlist: null,
  metadata: null,
  stateStream: null,
  refreshTimer: null,
  commandPendingUntil: 0,
  waveRenderKey: ""
};

const els = {
  songTitle: document.querySelector("#songTitle"),
  songMeta: document.querySelector("#songMeta"),
  connectionStatus: document.querySelector("#connectionStatus"),
  panicPanel: document.querySelector("#panicPanel"),
  transportState: document.querySelector("#transportState"),
  transportTime: document.querySelector("#transportTime"),
  currentRegion: document.querySelector("#currentRegion"),
  nextRegion: document.querySelector("#nextRegion"),
  waveCanvas: document.querySelector("#waveCanvas"),
  wavePlayhead: document.querySelector("#wavePlayhead"),
  waveRegionLabel: document.querySelector("#waveRegionLabel"),
  playPause: document.querySelector("#playPauseButton"),
  exitPanic: document.querySelector("#exitPanicButton"),
  regionButtons: document.querySelector("#regionButtons"),
  modeStatus: document.querySelector("#modeStatus"),
  lastMessage: document.querySelector("#lastMessage")
};

wireRemote();
bootRemote();

function wireRemote() {
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => sendCommand(button.dataset.command));
  });
  document.querySelectorAll("[data-region-command]").forEach((button) => {
    button.addEventListener("click", () => sendRegionCommand(button.dataset.regionCommand));
  });
}

async function bootRemote() {
  await refreshStaticData();
  openStateStream();
  remote.refreshTimer = window.setInterval(refreshStaticData, 3000);
  window.setInterval(renderRemote, 100);
}

async function refreshStaticData() {
  try {
    const [setlist, metadata] = await Promise.all([
      api("/api/setlist/current"),
      api("/api/set-metadata/current")
    ]);
    remote.setlist = setlist;
    remote.metadata = metadata;
    renderRemote();
  } catch (error) {
    setConnection("offline", "Offline");
    els.lastMessage.textContent = error.message;
  }
}

function openStateStream() {
  if (remote.stateStream) remote.stateStream.close();
  remote.stateStream = new EventSource("/api/playback/state-stream");
  remote.stateStream.addEventListener("state", (event) => {
    remote.playback = JSON.parse(event.data);
    setConnection(Date.now() < remote.commandPendingUntil ? "pending" : "online", Date.now() < remote.commandPendingUntil ? "Sent" : "Online");
    renderRemote();
  });
  remote.stateStream.onerror = () => {
    setConnection("offline", "Offline");
  };
}

async function sendCommand(command, extra = {}) {
  const payload = { command, source: "stage-remote", ...extra };
  if (command === "play") {
    payload.slot = remote.playback?.currentSlot || firstFilledSlot()?.slot;
  }
  remote.commandPendingUntil = Date.now() + 750;
  setConnection("pending", "Sent");
  try {
    const result = await api("/api/playback/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    remote.playback = result.state;
    els.lastMessage.textContent = result.accepted ? commandLabel(command) : result.reason || "Command rejected";
    renderRemote();
  } catch (error) {
    els.lastMessage.textContent = error.message;
    setConnection("offline", "Offline");
  }
}

function sendRegionCommand(command) {
  const region = currentRegionEntry() || firstRegionEntry();
  if (!region && command !== "goOnRegion") {
    els.lastMessage.textContent = "No region available.";
    return;
  }
  sendCommand(command, region ? {
    regionId: region.region.id,
    regionName: region.region.name || `Region ${region.index + 1}`
  } : {});
}

function renderRemote() {
  const playback = remote.playback || {};
  const slot = currentSlotMetadata();
  const song = currentSetlistSong();
  const region = currentRegionEntry();
  const next = nextRegionEntry(region);
  const playing = playback.transport === "playing";
  const panicActive = playback.panic?.active === true;

  els.songTitle.textContent = song?.title || slot?.title || "No song selected";
  els.songMeta.textContent = slot
    ? `${slot.tempoMap?.key || song?.key || "--"} | ${slot.tempoMap?.bpm || song?.bpm || "--"} BPM | ${slot.tempoMap?.timeSignature || song?.timeSignature || "--"}`
    : "Waiting for confirmed set";
  els.transportState.textContent = panicActive ? "Panic" : titleCase(playback.transport || "stopped");
  els.transportTime.textContent = formatSeconds(currentTransportSeconds());
  els.currentRegion.textContent = region?.region?.name || "--";
  els.nextRegion.textContent = next?.region?.name || "--";
  els.modeStatus.textContent = `${titleCase(playback.mode || "edit")} mode`;
  els.lastMessage.textContent = playback.lastMessage || els.lastMessage.textContent || "Ready";
  els.panicPanel.classList.toggle("hidden", !panicActive);
  els.playPause.textContent = playing ? "Pause" : "Play";
  els.playPause.dataset.command = playing ? "pause" : "play";
  els.exitPanic.disabled = !panicActive;
  renderWaveform(slot, region);
  renderRegionButtons(region);
}

function renderWaveform(slot, current) {
  const canvas = els.waveCanvas;
  if (!canvas) return;
  const duration = slotDurationSeconds(slot);
  const peaks = arrangedWaveformPeaks(slot);
  const regionKey = regionEntries().map((entry) => `${entry.region.id}:${entry.startTime}:${entry.endTime}`).join("|");
  const renderKey = `${slot?.slot || ""}:${duration}:${peaks.length}:${regionKey}:${canvas.clientWidth}:${canvas.clientHeight}`;
  if (renderKey !== remote.waveRenderKey) {
    remote.waveRenderKey = renderKey;
    drawWaveCanvas(canvas, slot, peaks, duration);
  }
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const x = duration > 0 ? Math.max(0, Math.min(width, (currentTransportSeconds() / duration) * width)) : 0;
  els.wavePlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
  els.waveRegionLabel.textContent = current?.region?.name || slot?.title || "--";
}

function drawWaveCanvas(canvas, slot, peaks, duration) {
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(canvas.clientWidth || 1200));
  const height = Math.max(120, Math.floor(canvas.clientHeight || 178));
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#5d696b";
  ctx.fillRect(0, 0, width, height);
  drawRemoteGrid(ctx, slot, width, height, duration);
  drawRemoteRegions(ctx, width, height, duration);
  drawRemotePeaks(ctx, peaks, width, height);
}

function drawRemoteGrid(ctx, slot, width, height, duration) {
  const beats = Array.isArray(slot?.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
  ctx.lineWidth = 1;
  for (const beat of beats) {
    const time = Number(beat.timeSeconds || 0);
    if (duration <= 0 || time < 0 || time > duration) continue;
    const x = (time / duration) * width;
    const isMeasure = Number(beat.beat || beat.beatInMeasure || 1) === 1;
    ctx.strokeStyle = isMeasure ? "rgba(220, 232, 232, 0.28)" : "rgba(20, 25, 26, 0.25)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawRemoteRegions(ctx, width, height, duration) {
  if (duration <= 0) return;
  const entries = regionEntries();
  for (const entry of entries) {
    const x = (entry.startTime / duration) * width;
    const w = Math.max(2, ((entry.endTime - entry.startTime) / duration) * width);
    ctx.fillStyle = "rgba(28, 124, 169, 0.2)";
    ctx.fillRect(x, height * 0.58, w, height * 0.34);
    ctx.strokeStyle = "rgba(66, 183, 255, 0.88)";
    ctx.strokeRect(x + 0.5, height * 0.58 + 0.5, Math.max(1, w - 1), height * 0.34 - 1);
  }
}

function drawRemotePeaks(ctx, peaks, width, height) {
  const mid = height * 0.45;
  const maxHalfHeight = height * 0.3;
  ctx.strokeStyle = "#0b1011";
  ctx.lineWidth = Math.max(1, width / Math.max(1, peaks.length));
  if (!peaks.length) {
    ctx.strokeStyle = "rgba(11, 16, 17, 0.55)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  peaks.forEach((peak, index) => {
    const x = (index / Math.max(1, peaks.length - 1)) * width;
    const level = Math.max(0, Math.min(1, Number(peak) || 0));
    const top = mid - (level * maxHalfHeight);
    const bottom = mid + (level * maxHalfHeight);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  });
  ctx.stroke();
}

function arrangedWaveformPeaks(slot) {
  if (slot?.arrangementCache?.waveform?.peaks?.length) return slot.arrangementCache.waveform.peaks;
  const peaks = Array.isArray(slot?.waveform?.peaks) ? slot.waveform.peaks : [];
  const blocks = arrangedBlocks(slot);
  if (!arrangementEnabled(slot) || !peaks.length || !blocks.length) return peaks;
  const duration = Number(slot.waveform?.durationSeconds || 0);
  if (!duration) return peaks;
  const arranged = [];
  const buckets = peaks.length;
  blocks.forEach((block) => {
    const start = Number(block.rawStartSeconds || timeForBarBeat(slot, block.rawStartBar, block.rawStartBeat || 1));
    const end = Number(block.rawEndSeconds || timeForBarBeat(slot, block.rawEndBar, block.rawEndBeat || 1));
    const startIndex = clamp(Math.floor((start / duration) * buckets), 0, buckets - 1);
    const endIndex = clamp(Math.ceil((end / duration) * buckets), startIndex + 1, buckets);
    arranged.push(...peaks.slice(startIndex, endIndex));
  });
  return arranged.length ? arranged : peaks;
}

function arrangedBlocks(slot) {
  return Array.isArray(slot?.arrangementCache?.blocks) && slot.arrangementCache.ready
    ? slot.arrangementCache.blocks
    : Array.isArray(slot?.arrangement?.blocks)
      ? slot.arrangement.blocks
      : [];
}

function arrangementEnabled(slot) {
  return slot?.arrangement?.enabled !== false;
}

function slotDurationSeconds(slot) {
  const arrangementDuration = Number(slot?.arrangementCache?.durationSeconds || slot?.arrangementCache?.waveform?.durationSeconds || 0);
  if (arrangementDuration > 0) return arrangementDuration;
  const waveformDuration = Number(slot?.waveform?.durationSeconds || 0);
  if (waveformDuration > 0) return waveformDuration;
  const beatGrid = Array.isArray(slot?.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
  return Number(beatGrid.at(-1)?.timeSeconds || 0);
}

function renderRegionButtons(current) {
  const regions = regionEntries();
  els.regionButtons.replaceChildren();
  if (!regions.length) {
    const empty = document.createElement("div");
    empty.className = "region-button";
    empty.textContent = "No regions loaded";
    els.regionButtons.append(empty);
    return;
  }
  for (const entry of regions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "region-button";
    button.classList.toggle("current", current?.region?.id === entry.region.id);
    button.textContent = entry.region.name || `Region ${entry.index + 1}`;
    button.addEventListener("click", () => sendCommand("jumpRegion", {
      regionId: entry.region.id,
      regionName: entry.region.name || `Region ${entry.index + 1}`
    }));
    els.regionButtons.append(button);
  }
}

function currentSetlistSong() {
  const slotNumber = Number(remote.playback?.currentSlot || firstFilledSlot()?.slot || 0);
  return (remote.setlist?.slots || []).find((slot) => Number(slot.slot) === slotNumber) || null;
}

function currentSlotMetadata() {
  const slotNumber = Number(remote.playback?.currentSlot || currentSetlistSong()?.slot || 0);
  return (remote.metadata?.slots || []).find((slot) => Number(slot.slot) === slotNumber) || null;
}

function firstFilledSlot() {
  return (remote.setlist?.slots || []).find((slot) => slot.songId) || null;
}

function regionEntries() {
  const slot = currentSlotMetadata();
  return (slot?.regions?.regions || [])
    .map((region, index) => ({
      region,
      index,
      startTime: timeForBarBeat(slot, Number(region.startBar || 1), Number(region.startBeat || 1)),
      endTime: timeForBarBeat(slot, Number(region.endBar || region.startBar || 1), Number(region.endBeat || 1))
    }))
    .filter((entry) => entry.endTime > entry.startTime)
    .sort((a, b) => a.startTime - b.startTime);
}

function currentRegionEntry() {
  const time = currentTransportSeconds();
  return regionEntries().find((entry) => time >= entry.startTime && time < Math.max(entry.startTime + 0.1, entry.endTime)) || null;
}

function firstRegionEntry() {
  return regionEntries()[0] || null;
}

function nextRegionEntry(current) {
  const entries = regionEntries();
  if (!entries.length) return null;
  if (!current) {
    const time = currentTransportSeconds();
    return entries.find((entry) => entry.startTime > time) || null;
  }
  return entries[entries.findIndex((entry) => entry.region.id === current.region.id) + 1] || null;
}

function currentTransportSeconds() {
  const playback = remote.playback || {};
  const anchor = Number(playback.transportAnchorSeconds ?? playback.currentTimeSeconds ?? 0) || 0;
  if (playback.transport !== "playing" || !playback.transportStartedAt) return anchor;
  const startedAt = Date.parse(playback.transportStartedAt);
  if (!Number.isFinite(startedAt)) return anchor;
  return anchor + Math.max(0, (Date.now() - startedAt) / 1000);
}

function timeForBarBeat(slot, bar, beat) {
  const beatGrid = Array.isArray(slot?.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
  if (!beatGrid.length) return 0;
  const exact = beatGrid.find((item) => Number(item.measure) === Number(bar) && Number(item.beat || item.beatInMeasure) === Number(beat));
  if (exact) return Number(exact.timeSeconds || 0);
  const measureStart = beatGrid.find((item) => Number(item.measure) === Number(bar));
  if (measureStart) return Number(measureStart.timeSeconds || 0);
  return Number(beatGrid.at(-1)?.timeSeconds || 0);
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setConnection(className, label) {
  els.connectionStatus.className = `status-pill ${className}`;
  els.connectionStatus.textContent = label;
}

function commandLabel(command) {
  const labels = {
    play: "Play sent",
    pause: "Pause sent",
    stop: "Stop sent",
    panic: "Panic sent",
    exitPanic: "Exit panic sent",
    repeatRegion: "Repeat sent",
    loopRegion: "Loop sent",
    goOnRegion: "Go On sent",
    nextSong: "Next song sent",
    jumpRegion: "Jump sent"
  };
  return labels[command] || `${command} sent`;
}

function titleCase(value) {
  return String(value || "").replace(/(^|[-_\s])([a-z])/g, (_, prefix, letter) => `${prefix === "-" || prefix === "_" ? " " : prefix}${letter.toUpperCase()}`);
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const centiseconds = Math.floor((total - Math.floor(total)) * 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const remote = {
  playback: null,
  setlist: null,
  metadata: null,
  stateStream: null,
  refreshTimer: null,
  commandPendingUntil: 0
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
  renderRegionButtons(region);
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

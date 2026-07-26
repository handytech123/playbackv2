const remote = {
  playback: null,
  setlist: null,
  metadata: null,
  meters: null,
  stateStream: null,
  meterStream: null,
  refreshTimer: null,
  setlistFingerprint: "",
  commandPendingUntil: 0,
  commandInFlight: false,
  commandInFlightSince: 0,
  waveRenderKey: ""
};

const els = {
  songTitle: document.querySelector("#songTitle"),
  songMeta: document.querySelector("#songMeta"),
  connectionStatus: document.querySelector("#connectionStatus"),
  panicPanel: document.querySelector("#panicPanel"),
  panicRecoveryTarget: document.querySelector("#panicRecoveryTarget"),
  waveRecoveryBar: document.querySelector("#waveRecoveryBar"),
  sectionHint: document.querySelector("#sectionHint"),
  tempoReadout: document.querySelector("#tempoReadout"),
  timeSigReadout: document.querySelector("#timeSigReadout"),
  durationReadout: document.querySelector("#durationReadout"),
  setlistCards: document.querySelector("#setlistCards"),
  transitionNext: document.querySelector("#transitionNext"),
  transitionMode: document.querySelector("#transitionMode"),
  transitionPad: document.querySelector("#transitionPad"),
  transportState: document.querySelector("#transportState"),
  transportTime: document.querySelector("#transportTime"),
  currentRegion: document.querySelector("#currentRegion"),
  nextRegion: document.querySelector("#nextRegion"),
  waveCanvas: document.querySelector("#waveCanvas"),
  wavePanel: document.querySelector("#wavePanel"),
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
  els.waveCanvas?.addEventListener("click", jumpToRegionFromWave);
}

async function bootRemote() {
  await refreshStaticData();
  openStateStream();
  openMeterStream();
  remote.refreshTimer = window.setInterval(refreshStaticData, 3000);
  window.setInterval(refreshPlaybackFallback, 1000);
  window.setInterval(renderRemote, 100);
}

async function refreshStaticData() {
  try {
    const [setlist, metadata, playback] = await Promise.all([
      api("/api/setlist/current"),
      api("/api/set-metadata/current"),
      api("/api/playback/state")
    ]);
    remote.setlist = setlist;
    remote.metadata = metadata;
    remote.playback = playback;
    remote.setlistFingerprint = playback?.currentFingerprint || remote.setlistFingerprint;
    renderRemote();
  } catch (error) {
    setConnection("offline", "Offline");
    els.lastMessage.textContent = error.message;
  }
}

async function refreshPlaybackFallback() {
  try {
    const [playback, meters] = await Promise.all([
      api("/api/playback/state"),
      api("/api/playback/meters")
    ]);
    await reconcileStaticDataForPlayback(playback);
    remote.playback = playback;
    remote.meters = meters;
    setConnection(Date.now() < remote.commandPendingUntil ? "pending" : "online", Date.now() < remote.commandPendingUntil ? "Sent" : "Online");
  } catch {
    setConnection("offline", "Offline");
  }
}

function openStateStream() {
  if (remote.stateStream) remote.stateStream.close();
  remote.stateStream = new EventSource("/api/playback/state-stream");
  remote.stateStream.addEventListener("state", async (event) => {
    try {
      const playback = JSON.parse(event.data);
      await reconcileStaticDataForPlayback(playback);
      remote.playback = playback;
      setConnection(Date.now() < remote.commandPendingUntil ? "pending" : "online", Date.now() < remote.commandPendingUntil ? "Sent" : "Online");
      renderRemote();
    } catch (error) {
      els.lastMessage.textContent = error.message;
    }
  });
  remote.stateStream.onerror = () => {
    setConnection("offline", "Offline");
  };
}

async function reconcileStaticDataForPlayback(playback) {
  const fingerprint = playback?.currentFingerprint || "";
  const slotNumber = Number(playback?.currentSlot || 0);
  const missingCurrentSong = slotNumber > 0 && !(remote.setlist?.slots || []).some((slot) => Number(slot.slot) === slotNumber && slot.songId);
  if (!fingerprint || (fingerprint === remote.setlistFingerprint && !missingCurrentSong)) return;
  const [setlist, metadata] = await Promise.all([
    api("/api/setlist/current"),
    api("/api/set-metadata/current")
  ]);
  remote.setlist = setlist;
  remote.metadata = metadata;
  remote.setlistFingerprint = fingerprint;
  remote.waveRenderKey = "";
}

function openMeterStream() {
  if (remote.meterStream) remote.meterStream.close();
  remote.meterStream = new EventSource("/api/playback/meter-stream");
  remote.meterStream.addEventListener("meters", (event) => {
    try {
      remote.meters = JSON.parse(event.data);
    } catch {
      // Ignore malformed meter packets.
    }
  });
  remote.meterStream.onerror = () => {
    if (remote.meterStream?.readyState === EventSource.CLOSED) {
      remote.meterStream = null;
    }
  };
}

async function sendCommand(command, extra = {}) {
  if (remote.commandInFlight && Date.now() - Number(remote.commandInFlightSince || 0) < 2000) return;
  if (remote.commandInFlight) {
    remote.commandInFlight = false;
  }
  const action = remoteOperatorCommand(command, extra);
  const payload = { command: action, source: "stage-remote", ...extra };
  if (action === "songTransition" && payload.fromSlot === undefined) {
    payload.fromSlot = transitionCommandFromSlot(extra);
  }
  if (action === "play") {
    payload.slot = remote.playback?.currentSlot || firstFilledSlot()?.slot;
  }
  if (action === "seek" && payload.seconds === undefined) {
    payload.seconds = 0;
    payload.slot = remote.playback?.currentSlot || firstFilledSlot()?.slot;
  }
  remote.commandInFlight = true;
  remote.commandInFlightSince = Date.now();
  remote.commandPendingUntil = Date.now() + 750;
  setConnection("pending", "Sent");
  try {
    const result = await api("/api/playback/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    remote.playback = result.state;
    els.lastMessage.textContent = result.accepted ? commandLabel(action) : result.reason || "Command rejected";
    renderRemote();
  } catch (error) {
    els.lastMessage.textContent = error.message;
    setConnection("offline", "Offline");
  } finally {
    remote.commandInFlight = false;
    remote.commandInFlightSince = 0;
  }
}

function remoteOperatorCommand(command, extra = {}) {
  if (command !== "nextSong") return command;
  return transitionForOperatorNext(extra) ? "songTransition" : command;
}

function transitionCommandFromSlot(extra = {}) {
  return positiveRemoteNumber(extra.fromSlot)
    || positiveRemoteNumber(extra.slot)
    || positiveRemoteNumber(remote.playback?.currentSlot)
    || positiveRemoteNumber(firstFilledSlot()?.slot);
}

function transitionForOperatorNext(extra = {}) {
  const fromSlot = transitionCommandFromSlot(extra);
  return fromSlot ? transitionAfterSlot(fromSlot) : null;
}

function positiveRemoteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sendRegionCommand(command) {
  const region = currentRegionEntry() || firstRegionEntry();
  if (!region && command !== "goOnRegion") {
    els.lastMessage.textContent = "No region available.";
    return;
  }
  if ((remote.playback || {}).panic?.active === true && command === "jumpRegion" && region) {
    sendCommand("jumpRegion", {
      slot: currentSlotMetadata()?.slot || remote.playback?.currentSlot,
      regionId: region.region.id,
      regionName: region.region.name || `Region ${region.index + 1}`
    });
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
  els.tempoReadout.textContent = slot?.tempoMap?.bpm || song?.bpm || "--";
  els.timeSigReadout.textContent = slot?.tempoMap?.timeSignature || song?.timeSignature || "--";
  els.songMeta.textContent = slot
    ? `${slot.tempoMap?.key || song?.key || "--"} | ${slot.tempoMap?.bpm || song?.bpm || "--"} BPM | ${slot.tempoMap?.timeSignature || song?.timeSignature || "--"}`
    : "Waiting for confirmed set";
  els.transportState.textContent = panicActive ? "Panic" : titleCase(playback.transport || "stopped");
  els.transportTime.textContent = formatSeconds(currentTransportSeconds());
  els.currentRegion.textContent = region?.region?.name || "--";
  els.nextRegion.textContent = next?.region?.name || "--";
  els.modeStatus.textContent = `${titleCase(playback.mode || "edit")} mode`;
  els.durationReadout.textContent = `${formatSeconds(currentTransportSeconds())} / ${formatSeconds(slotDurationSeconds(slot))}`;
  els.lastMessage.textContent = playback.lastMessage || els.lastMessage.textContent || "Ready";
  const backendRecovery = playback.panic?.recoveryTarget?.pending ? playback.panic.recoveryTarget : null;
  if (backendRecovery) {
    els.lastMessage.textContent = backendRecovery.message || `Panic recovery queued${backendRecovery.regionName ? ` to ${backendRecovery.regionName}` : " at next region"}`;
  }
  els.panicPanel.classList.toggle("hidden", !panicActive);
  els.waveRecoveryBar?.classList.toggle("hidden", !panicActive);
  if (els.panicRecoveryTarget) {
    els.panicRecoveryTarget.textContent = backendRecovery?.regionName
      ? `Queued: ${backendRecovery.regionName}`
      : panicActive
        ? "Choose recovery target below"
        : "No recovery queued";
  }
  if (els.sectionHint) {
    els.sectionHint.textContent = panicActive ? "tap to recover there" : "tap to queue jump";
  }
  document.querySelector("#padButton")?.classList.toggle("active", playback.pad?.active === true);
  els.wavePanel?.classList.toggle("region-playing", Boolean(region?.region?.id && playing));
  els.playPause.textContent = playing ? "Pause" : "Play";
  els.playPause.dataset.command = playing ? "pause" : "play";
  els.exitPanic.disabled = !panicActive;
  renderSetlistCards();
  renderTransitionReadout();
  renderWaveform(slot, region);
  renderRegionButtons(region);
}

function renderTransitionReadout() {
  const current = currentSetlistSong();
  const transition = transitionAfterSlot(current?.slot);
  const next = transition ? (remote.setlist?.slots || []).find((slot) => Number(slot.slot) === Number(transition.toSlot)) : null;
  if (els.transitionNext) els.transitionNext.textContent = `Next: ${next?.title || "--"}`;
  if (els.transitionMode) {
    const duration = ["crossfade", "overlap"].includes(transition?.mode) ? ` / ${Number(transition.durationSeconds || 5)}s` : "";
    els.transitionMode.textContent = `Transition: ${transitionModeLabel(transition?.mode)}${duration}`;
  }
  if (els.transitionPad) els.transitionPad.textContent = `Pad: ${transitionPadSummary(transition)}`;
}

function transitionAfterSlot(fromSlot) {
  if (!fromSlot) return null;
  return (remote.setlist?.transitions || []).find((transition) => Number(transition.fromSlot) === Number(fromSlot)) || null;
}

function transitionModeLabel(mode) {
  return {
    "cue-next": "Cue Next",
    stay: "Stay",
    autolink: "AutoLink",
    crossfade: "Crossfade",
    overlap: "Overlap"
  }[mode] || "--";
}

function transitionPadSummary(transition) {
  if (!transition) return "--";
  if (transition.continuePad === false || transition.padBehavior === "off") return "Off";
  return {
    "hold-current-key": "Hold Current",
    "next-song-key": "Next Key",
    "crossfade-to-next-key": "Crossfade Key"
  }[transition.padBehavior] || "Next Key";
}

function renderSetlistCards() {
  const slots = (remote.setlist?.slots || []).filter((slot) => slot.songId);
  els.setlistCards.replaceChildren();
  if (!slots.length) {
    const empty = document.createElement("div");
    empty.className = "song-card";
    empty.innerHTML = "<div class=\"song-card-title\">No confirmed set</div><div class=\"song-card-meta\">Load songs on playback PC</div>";
    els.setlistCards.append(empty);
    return;
  }
  const currentSlot = Number(remote.playback?.currentSlot || firstFilledSlot()?.slot || 0);
  for (const slot of slots) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "song-card";
    card.classList.toggle("current", Number(slot.slot) === currentSlot);
    card.innerHTML = `
      <div class="song-card-title">${escapeHtml(slot.title || `Slot ${slot.slot}`)}</div>
      <div class="song-card-meta">${escapeHtml(slot.key || "--")} | ${escapeHtml(slot.bpm || "--")} BPM</div>
    `;
    card.addEventListener("click", () => {
      if (Number(slot.slot) === currentSlot) return;
      if (remote.playback?.transport === "stopped") {
        sendCommand("play", { slot: slot.slot });
        return;
      }
      els.lastMessage.textContent = "Use Next Song during playback.";
    });
    els.setlistCards.append(card);
  }
  const currentCard = els.setlistCards.querySelector(".song-card.current");
  currentCard?.scrollIntoView({ inline: "center", block: "nearest" });
}

function renderWaveform(slot, current) {
  const canvas = els.waveCanvas;
  if (!canvas) return;
  const duration = slotDurationSeconds(slot);
  const peaks = arrangedWaveformPeaks(slot);
  const regionKey = regionEntries().map((entry) => `${entry.region.id}:${entry.startTime}:${entry.endTime}`).join("|");
  const cueKey = cueEntries().map((entry) => `${entry.cue.id || entry.index}:${entry.time}:${entry.cue.name}`).join("|");
  const renderKey = `${slot?.slot || ""}:${duration}:${peaks.length}:${regionKey}:${cueKey}:${canvas.clientWidth}:${canvas.clientHeight}:${current?.region?.id || ""}`;
  if (renderKey !== remote.waveRenderKey) {
    remote.waveRenderKey = renderKey;
    drawWaveCanvas(canvas, slot, peaks, duration, current);
  }
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const x = duration > 0 ? Math.max(0, Math.min(width, (currentTransportSeconds() / duration) * width)) : 0;
  els.wavePlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
  els.waveRegionLabel.textContent = current?.region?.name || slot?.title || "--";
}

function drawWaveCanvas(canvas, slot, peaks, duration, current) {
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(canvas.clientWidth || 1200));
  const height = Math.max(120, Math.floor(canvas.clientHeight || 178));
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#14191c";
  ctx.fillRect(0, 0, width, height);
  drawRemoteGrid(ctx, slot, width, height, duration);
  drawRemoteRegions(ctx, width, height, duration, current);
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
    ctx.strokeStyle = isMeasure ? "rgba(220, 232, 232, 0.16)" : "rgba(220, 232, 232, 0.07)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawRemoteRegions(ctx, width, height, duration, current) {
  if (duration <= 0) return;
  const entries = regionEntries();
  for (const entry of entries) {
    const isCurrent = current?.region?.id === entry.region.id;
    const x = (entry.startTime / duration) * width;
    const w = Math.max(2, ((entry.endTime - entry.startTime) / duration) * width);
    const y = height * 0.18;
    const h = height * 0.72;
    ctx.fillStyle = isCurrent ? "rgba(66, 183, 255, 0.16)" : "rgba(18, 39, 44, 0.46)";
    ctx.strokeStyle = isCurrent ? "rgba(66, 183, 255, 0.7)" : "rgba(39, 212, 125, 0.28)";
    ctx.lineWidth = isCurrent ? 4 : 1;
    roundRect(ctx, x + 1, y, Math.max(1, w - 2), h, 8);
    ctx.fill();
    ctx.stroke();
    const label = abbreviatedCueLabel(entry.region.name, entry.index);
    const radius = 13;
    const centerX = Math.max(radius + 2, Math.min(width - radius - 2, x + 20));
    const centerY = y + 18;
    ctx.fillStyle = isCurrent ? "rgba(18, 82, 112, 0.92)" : "rgba(4, 42, 30, 0.88)";
    ctx.strokeStyle = isCurrent ? "rgba(255, 255, 255, 0.95)" : "rgba(39, 212, 125, 0.8)";
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f4f0e8";
    ctx.font = "900 10px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, centerX, centerY + 0.5);
    ctx.textAlign = "left";
  }
}

function drawRemotePeaks(ctx, peaks, width, height) {
  const mid = height * 0.54;
  const maxHalfHeight = height * 0.2;
  ctx.strokeStyle = "rgba(235, 240, 235, 0.82)";
  ctx.lineWidth = Math.max(1, Math.min(2, width / Math.max(1, peaks.length)));
  if (!peaks.length) {
    ctx.strokeStyle = "rgba(235, 240, 235, 0.42)";
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

function abbreviatedCueLabel(value, index) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return `C${index + 1}`;
  const text = words
    .filter((word) => !/^(the|to|of|and)$/i.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  return (text || words[0][0] || "C").slice(0, 2).toUpperCase();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function jumpToRegionFromWave(event) {
  const slot = currentSlotMetadata();
  if (!slot) return;
  const duration = slotDurationSeconds(slot);
  if (duration <= 0) return;
  const rect = els.waveCanvas.getBoundingClientRect();
  const seconds = ((event.clientX - rect.left) / Math.max(1, rect.width)) * duration;
  const entry = regionEntries().find((item) => seconds >= item.startTime && seconds < item.endTime);
  if (!entry) return;
  sendCommand("jumpRegion", {
    regionId: entry.region.id,
    regionName: entry.region.name || `Region ${entry.index + 1}`
  });
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
    const panicActive = (remote.playback || {}).panic?.active === true;
    const pending = remote.playback?.panic?.recoveryTarget || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = "region-button";
    button.classList.toggle("current", current?.region?.id === entry.region.id);
    button.classList.toggle("panic-select", panicActive);
    button.classList.toggle("recovery-target", panicActive && pending.regionId === entry.region.id);
    const name = entry.region.name || `Region ${entry.index + 1}`;
    button.textContent = panicActive ? `Recover: ${name}` : name;
    button.addEventListener("click", () => {
      if (panicActive) {
        sendCommand("jumpRegion", {
          slot: currentSlotMetadata()?.slot || remote.playback?.currentSlot,
          regionId: entry.region.id,
          regionName: name
        });
        return;
      }
      sendCommand("jumpRegion", {
        regionId: entry.region.id,
        regionName: name
      });
    });
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

function cueEntries() {
  const slot = currentSlotMetadata();
  return (slot?.cues?.cueMarkers || [])
    .map((cue, index) => ({
      cue,
      index,
      time: timeForBarBeat(slot, Number(cue.bar || 1), Number(cue.beat || 1))
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
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

function nextRegionBoundarySeconds(slot, currentSeconds) {
  return nextRegionBoundary(slot, currentSeconds).seconds;
}

function nextRegionBoundary(slot, currentSeconds) {
  const current = Number(currentSeconds || 0);
  const next = regionEntries()
    .map((entry) => ({
      region: entry.region,
      seconds: Number(entry.startTime || 0)
    }))
    .filter((entry) => Number.isFinite(entry.seconds) && entry.seconds > current + 0.25)
    .sort((a, b) => a.seconds - b.seconds)[0];
  return next || {
    region: null,
    seconds: nextMeasureBoundarySeconds(slot, current)
  };
}

function nextMeasureBoundarySeconds(slot, currentSeconds) {
  const beatGrid = Array.isArray(slot?.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
  const current = Number(currentSeconds || 0);
  const next = beatGrid.find((beat) => {
    const beatNumber = Number(beat.beat || beat.beatNumber || beat.beatInMeasure || 1);
    const time = Number(beat.timeSeconds || 0);
    return beatNumber === 1 && time > current + 0.25;
  });
  return Number(next?.timeSeconds ?? current);
}

function currentTransportSeconds() {
  const playback = remote.playback || {};
  const meterTime = activeMeterTransportSeconds(playback.currentSlot);
  if (meterTime !== null) return meterTime;
  const anchor = Number(playback.transportAnchorSeconds ?? playback.currentTimeSeconds ?? 0) || 0;
  if (playback.transport !== "playing" || !playback.transportStartedAt) return anchor;
  const startedAt = Date.parse(playback.transportStartedAt);
  if (!Number.isFinite(startedAt)) return anchor;
  return anchor + Math.max(0, (Date.now() - startedAt) / 1000);
}

function activeMeterTransportSeconds(slotNumber) {
  const meters = remote.meters || {};
  if (remote.playback?.transport !== "playing" || !meters.active) return null;
  if (Number(meters.slot) !== Number(slotNumber)) return null;
  const time = Number(meters.currentTimeSeconds);
  return Number.isFinite(time) && time >= 0 ? time : null;
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
    togglePad: "Pad toggled",
    panic: "Panic sent",
    exitPanic: "Exit panic sent",
    repeatRegion: "Repeat sent",
    loopRegion: "Loop sent",
    goOnRegion: "Go On sent",
    nextSong: "Next song sent",
    songTransition: "Cue Next sent",
    jumpRegion: "Jump sent"
  };
  return labels[command] || `${command} sent`;
}

function titleCase(value) {
  return String(value || "").replace(/(^|[-_\s])([a-z])/g, (_, prefix, letter) => `${prefix === "-" || prefix === "_" ? " " : prefix}${letter.toUpperCase()}`);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
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

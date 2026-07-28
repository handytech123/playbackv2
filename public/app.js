const state = {
  library: null,
  activeVendor: "All",
  search: "",
  loadedSong: null,
  setlist: Array(6).fill(null),
  setlistTransitions: [],
  setlistFingerprint: "",
  playbackSetFingerprint: "",
  selectedSetlistIndex: null,
  addSongTargetIndex: null,
  addSongInFlight: false,
  saveTimer: null,
  transitionSaveTimer: null,
  transitionSaveInFlight: false,
  transitionSavePending: false,
  setlistSaveInFlight: false,
  setlistSavePending: false,
  metadataSaveTimer: null,
  mixerSaveTimer: null,
  timelineZoom: 1,
  timelineZoomSlot: null,
  timelineSnap: "measure",
  selectedRegionIndex: null,
  selectedArrangedRegionRange: null,
  selectedCueIndex: null,
  cueMoveUndoStack: [],
  editorUndoStack: [],
  arrangementUndoStack: [],
  mixerCollapsed: false,
  playbackState: null,
  transportFrame: null,
  settings: null,
  systemInfo: null,
  audioDevices: null,
  padOptions: [],
  cacheReport: null,
  setMetadata: null,
  selectedMetadataSlot: null,
  movingTransportSlot: null,
  regionSketch: null,
  renderedLiveRegionId: "",
  arrangementSkipInFlight: false,
  arrangementPlayback: null,
  editorLoopTest: null,
  editorLoopActionInFlight: false,
  liveRepeatStateKey: "",
  openTransitionFromSlot: null,
  mixerMeters: null,
  playbackCommandPending: false,
  playbackCommandPendingSince: 0,
  lastPanicButtonPressAt: 0,
  liveMixerInFlight: false,
  liveMixerPending: false,
  playbackStateStream: null,
  mixerMeterStream: null,
  scrubBySlot: {},
  waveformLoadInFlight: new Set(),
  audioAlignMarkersBySlot: {},
  userTimelineScrollActiveUntil: 0,
  timelineAutoScrolling: false,
  mixerPanelHeight: null,
  mixerPanelHeightMode: "",
  playbackKeyInteractionUntil: 0,
  uiInteractionHoldUntil: 0,
  midiAccess: null,
  midiOutputs: [],
  midiCueTracker: null
};

window.playbackAppState = state;

const DANTE_ROUTING_ROWS = [
  { key: "tracks", label: "Tracks", hint: "Music stems" },
  { key: "click", label: "Dynamic Click", hint: "Generated click" },
  { key: "dynamicCue", label: "Dynamic Cue", hint: "Generated cue phrases" },
  { key: "pads", label: "Dynamic Pad / Pads", hint: "Pad cover and pad stems" },
  { key: "cues", label: "Guide Cue", hint: "Original guide/cue stems" },
  { key: "iem", label: "IEM", hint: "Instrument send only" }
];

const els = {
  appModeStatus: document.querySelector("#appModeStatus"),
  navButtons: [...document.querySelectorAll(".nav-button[data-view]")],
  reloadData: document.querySelector("#reloadDataButton"),
  views: [...document.querySelectorAll(".view")],
  status: document.querySelector("#libraryStatus"),
  engineStatus: document.querySelector("#engineStatus"),
  refresh: document.querySelector("#refreshButton"),
  tabs: [...document.querySelectorAll(".tab")],
  search: document.querySelector("#songSearch"),
  select: document.querySelector("#songSelect"),
  skippedSummary: document.querySelector("#skippedSummary"),
  skippedFolders: document.querySelector("#skippedFolders"),
  setlistSlots: document.querySelector("#setlistSlots"),
  transitionEditorDock: document.querySelector("#transitionEditorDock"),
  setlistCount: document.querySelector("#setlistCount"),
  clearSetlist: document.querySelector("#clearSetlistButton"),
  songTitle: document.querySelector("#songTitle"),
  songMeta: document.querySelector("#songMeta"),
  songDetails: document.querySelector("#songDetails"),
  alert: document.querySelector("#alertBox"),
  playbackModeTitle: document.querySelector("#playbackModeTitle"),
  playbackStatus: document.querySelector("#playbackStatus"),
  playbackKey: document.querySelector("#playbackKeyReadout"),
  playbackTempo: document.querySelector("#playbackTempoReadout"),
  playbackTime: document.querySelector("#playbackTimeReadout"),
  transportState: document.querySelector("#transportStateLabel"),
  transportSong: document.querySelector("#transportSongTitle"),
  confirmSet: document.querySelector("#confirmSetButton"),
  quickConfirmSet: document.querySelector("#quickConfirmSetButton"),
  modeToggle: document.querySelector("#modeToggleButton"),
  commandButtons: [...document.querySelectorAll("[data-command]")],
  panicCommand: document.querySelector(".panic-command"),
  exitPanic: document.querySelector("#exitPanicButton"),
  panicRecoveryPanel: document.querySelector("#panicRecoveryPanel"),
  panicRecoveryStatus: document.querySelector("#panicRecoveryStatus"),
  metadataSlot: document.querySelector("#metadataSlotSelect"),
  timelineStatus: document.querySelector("#timelineStatus"),
  regionLane: document.querySelector("#regionLane"),
  regionSketchSelection: document.querySelector("#regionSketchSelection"),
  regionMenu: document.querySelector("#regionMenu"),
  regionNameSelect: document.querySelector("#regionNameSelect"),
  regionRename: document.querySelector("#regionRenameButton"),
  regionTrim: document.querySelector("#regionTrimButton"),
  regionSplit: document.querySelector("#regionSplitButton"),
  regionRemoveGap: document.querySelector("#regionRemoveGapButton"),
  regionDelete: document.querySelector("#regionDeleteButton"),
  cueLane: document.querySelector("#cueLane"),
  sectionLane: document.querySelector("#sectionLane"),
  timelineSurface: document.querySelector("#timelineSurface"),
  timelineRuler: document.querySelector("#timelineRuler"),
  timelineGrid: document.querySelector(".timeline-grid"),
  fakeWaveform: document.querySelector("#fakeWaveform"),
  waveformPlayhead: document.querySelector("#waveformPlayhead"),
  waveformCurrentSection: document.querySelector("#waveformCurrentSection"),
  waveformSelectedSection: document.querySelector("#waveformSelectedSection"),
  waveformNextSection: document.querySelector("#waveformNextSection"),
  zoomOut: document.querySelector("#zoomOutButton"),
  zoomIn: document.querySelector("#zoomInButton"),
  zoomReadout: document.querySelector("#zoomReadout"),
  editorTransport: document.querySelector("#editorTransport"),
  editorJumpStart: document.querySelector("#editorJumpStartButton"),
  editorPlay: document.querySelector("#editorPlayButton"),
  editorRepeat: document.querySelector("#editorRepeatButton"),
  editorLoop: document.querySelector("#editorLoopButton"),
  editorStop: document.querySelector("#editorStopButton"),
  editorPause: document.querySelector("#editorPauseButton"),
  editorTransportStatus: document.querySelector("#editorTransportStatus"),
  playbackKeySelect: document.querySelector("#playbackKeySelect"),
  playbackPadSelect: document.querySelector("#playbackPadSelect"),
  playbackKeyStatus: document.querySelector("#playbackKeyStatus"),
  playbackKeyOriginal: document.querySelector("#playbackKeyOriginal"),
  playbackKeyTranspose: document.querySelector("#playbackKeyTranspose"),
  playbackPadStatus: document.querySelector("#playbackPadStatus"),
  createRegionFromSelection: document.querySelector("#createRegionFromSelectionButton"),
  undoCueMove: document.querySelector("#undoCueMoveButton"),
  timelineSnap: document.querySelector("#timelineSnapSelect"),
  tempoKey: document.querySelector("#tempoKeyInput"),
  tempoBpm: document.querySelector("#tempoBpmInput"),
  tempoTimeSignature: document.querySelector("#tempoTimeSignatureInput"),
  setAudioAlignSource: document.querySelector("#setAudioAlignSourceButton"),
  setAudioAlignTarget: document.querySelector("#setAudioAlignTargetButton"),
  alignAudioStart: document.querySelector("#alignAudioStartButton"),
  resetAudioAlignment: document.querySelector("#resetAudioAlignmentButton"),
  audioAlignmentStatus: document.querySelector("#audioAlignmentStatus"),
  saveMetadata: document.querySelector("#saveMetadataButton"),
  approveMetadata: document.querySelector("#approveMetadataButton"),
  addRegion: document.querySelector("#addRegionButton"),
  removeRegion: document.querySelector("#removeRegionButton"),
  reorderRegions: document.querySelector("#reorderRegionsButton"),
  arrangementEnabled: document.querySelector("#arrangementEnabledToggle"),
  arrangementEnabledLabel: document.querySelector("#arrangementEnabledLabel"),
  undoArrangement: document.querySelector("#undoArrangementButton"),
  trimSongStart: document.querySelector("#trimSongStartButton"),
  trimSongEnd: document.querySelector("#trimSongEndButton"),
  saveArrangement: document.querySelector("#saveArrangementButton"),
  clearArrangement: document.querySelector("#clearArrangementButton"),
  addCue: document.querySelector("#addCueButton"),
  reorderCues: document.querySelector("#reorderCuesButton"),
  selectedRegionName: document.querySelector("#selectedRegionNameInput"),
  selectedCueName: document.querySelector("#selectedCueNameInput"),
  regionEditorList: document.querySelector("#regionEditorList"),
  cueEditorList: document.querySelector("#cueEditorList"),
  timelinePanel: document.querySelector("#timelinePanel"),
  editorPanel: document.querySelector("#editorPanel"),
  mixerLowerPanel: document.querySelector("#mixerLowerPanel"),
  mixerResizeHandle: document.querySelector("#mixerResizeHandle"),
  mixerStrip: document.querySelector("#mixerStrip"),
  mixerCollapse: document.querySelector("#mixerCollapseButton"),
  operatorTabs: [...document.querySelectorAll(".operator-tab")],
  operatorPanels: [...document.querySelectorAll(".operator-panel")],
  busLayer: document.querySelector("#busLayer"),
  padLayer: document.querySelector("#padLayer"),
  settingsStatus: document.querySelector("#settingsStatus"),
  saveSettings: document.querySelector("#saveSettingsButton"),
  settingsTabs: [...document.querySelectorAll(".settings-tab")],
  settingsSections: [...document.querySelectorAll(".settings-section")],
  selectedDeviceName: document.querySelector("#selectedDeviceNameInput"),
  audioDeviceSelect: document.querySelector("#audioDeviceSelect"),
  refreshAudioDevices: document.querySelector("#refreshAudioDevicesButton"),
  audioDiagnostics: document.querySelector("#audioDiagnosticsButton"),
  audioDiagnosticsReport: document.querySelector("#audioDiagnosticsReport"),
  libraryRootPath: document.querySelector("#libraryRootPath"),
  libraryRootInput: document.querySelector("#libraryRootInput"),
  libraryVendorFolders: document.querySelector("#libraryVendorFolders"),
  appDataPath: document.querySelector("#appDataPath"),
  audioReadiness: document.querySelector("#audioReadiness"),
  readinessSummary: document.querySelector("#readinessSummary"),
  deviceListPreview: document.querySelector("#deviceListPreview"),
  sampleRate: document.querySelector("#sampleRateSelect"),
  routingPreset: document.querySelector("#routingPresetSelect"),
  routingStructure: document.querySelector("#routingStructure"),
  remoteStatus: document.querySelector("#remoteStatusReadout"),
  remotePrimaryUrl: document.querySelector("#remotePrimaryUrl"),
  remoteLinkCards: document.querySelector("#remoteLinkCards"),
  remoteUrlList: document.querySelector("#remoteUrlList"),
  openRemote: document.querySelector("#openRemoteButton"),
  copyRemoteUrl: document.querySelector("#copyRemoteUrlButton"),
  allowRemoteFirewall: document.querySelector("#allowRemoteFirewallButton"),
  remoteFirewallStatus: document.querySelector("#remoteFirewallStatus"),
  cacheReport: document.querySelector("#cacheReport"),
  cueAnalyzerStatus: document.querySelector("#cueAnalyzerStatus"),
  cueRecognitionReport: document.querySelector("#cueRecognitionReport"),
  dynamicCueFolder: document.querySelector("#dynamicCueFolderInput"),
  padsFolder: document.querySelector("#padsFolderInput"),
  padsDefaultEnabled: document.querySelector("#padsDefaultEnabledInput"),
  padsStartWithSong: document.querySelector("#padsStartWithSongInput"),
  padsContinueBetweenSongs: document.querySelector("#padsContinueBetweenSongsInput"),
  padsDefaultVolume: document.querySelector("#padsDefaultVolumeInput"),
  padsFadeIn: document.querySelector("#padsFadeInInput"),
  padsFadeOut: document.querySelector("#padsFadeOutInput"),
  dynamicClickPatternFolder: document.querySelector("#dynamicClickPatternFolderInput"),
  proPresenterMidiEnabled: document.querySelector("#proPresenterMidiEnabledInput"),
  proPresenterMidiOutput: document.querySelector("#proPresenterMidiOutputSelect"),
  proPresenterMidiChannel: document.querySelector("#proPresenterMidiChannelInput"),
  proPresenterMidiNote: document.querySelector("#proPresenterMidiNoteInput"),
  proPresenterMidiVelocity: document.querySelector("#proPresenterMidiVelocityInput"),
  proPresenterMidiLength: document.querySelector("#proPresenterMidiLengthInput"),
  refreshMidiDevices: document.querySelector("#refreshMidiDevicesButton"),
  testMidiSlide: document.querySelector("#testMidiSlideButton"),
  proPresenterMidiStatus: document.querySelector("#proPresenterMidiStatus"),
  wavPathButtons: [...document.querySelectorAll("[data-wav-picker]")],
  folderPathButtons: [...document.querySelectorAll("[data-folder-picker]")],
  engineManifestPreview: document.querySelector("#engineManifestPreview"),
  runSystemCheck: document.querySelector("#runSystemCheckButton"),
  auditMetadata: document.querySelector("#auditMetadataButton"),
  rehydrateMetadata: document.querySelector("#rehydrateMetadataButton"),
  metadataAuditReport: document.querySelector("#metadataAuditReport"),
  systemCheckResult: document.querySelector("#systemCheckResult"),
  settingsMenu: document.querySelector("#settingsMenuButton"),
  closeSettings: document.querySelector("#closeSettingsButton"),
  settingsBackdrop: document.querySelector("[data-close-settings]"),
  addSongModal: document.querySelector("#addSongModal"),
  closeAddSong: document.querySelector("#closeAddSongButton"),
  addSelectedSong: document.querySelector("#addSelectedSongButton"),
  modalBackdrop: document.querySelector("[data-close-add-song]")
};

init().catch((error) => {
  console.error("App startup failed", error);
  els.status.textContent = "Startup failed.";
  setAlert(`Startup failed: ${error.message}`);
});

async function init() {
  loadSavedMixerHeight();
  populatePlaybackKeySelect();
  wireEvents();
  await loadSystemInfo();
  await loadCurrentSetlist();
  await loadSettings();
  await loadPadOptions();
  await loadAudioDevices();
  await loadCueAnalyzerStatus();
  await loadCacheReport();
  await loadEngineManifestPreview();
  await loadPlaybackState();
  window.setInterval(refreshPlaybackReadiness, 1000);
  openPlaybackStateStream();
  startMixerMeterStream();
  loadSetMetadata().catch((error) => {
    setAlert(`Set metadata load failed: ${error.message}`);
  });
  loadLibrary().catch((error) => {
    els.status.textContent = "Library unavailable.";
    setAlert(`Library load failed: ${error.message}`);
  });
}

async function refreshPlaybackReadiness() {
  try {
    const playback = await api("/api/playback/state");
    await reconcileSetlistForPlayback(playback);
    state.playbackState = playback;
    renderPlaybackState();
  } catch {
    // Readiness polling should not interrupt the operator during live use.
  }
}

function openPlaybackStateStream() {
  if (typeof EventSource === "undefined") return;
  if (state.playbackStateStream) state.playbackStateStream.close();
  state.playbackStateStream = new EventSource("/api/playback/state-stream");
  state.playbackStateStream.addEventListener("state", async (event) => {
    try {
      const playback = JSON.parse(event.data);
      await reconcileSetlistForPlayback(playback);
      state.playbackState = playback;
      renderPlaybackState();
    } catch {
      // Polling remains the fallback.
    }
  });
  state.playbackStateStream.onerror = () => {
    if (state.playbackStateStream?.readyState === EventSource.CLOSED) {
      state.playbackStateStream = null;
    }
  };
}

async function reconcileSetlistForPlayback(playback) {
  const fingerprint = playback?.currentFingerprint || "";
  const slotNumber = Number(playback?.currentSlot || 0);
  const missingCurrentSong = slotNumber > 0 && !state.setlist[slotNumber - 1];
  if (isUserEditingUi()) return;
  if (state.saveTimer || state.setlistSaveInFlight || state.setlistSavePending) return;
  if (!fingerprint || (fingerprint === state.playbackSetFingerprint && !missingCurrentSong)) return;
  await loadCurrentSetlist({ render: false });
  await loadSetMetadata();
  state.playbackSetFingerprint = fingerprint;
}

function wireEvents() {
  for (const button of els.navButtons) {
    button.addEventListener("click", () => showView(button.dataset.view));
  }
  els.refresh.addEventListener("click", refreshLibrary);
  els.reloadData.addEventListener("click", reloadAppData);
  window.playbackShell?.onMenuCommand?.(handleShellMenuCommand);
  els.openRemote?.addEventListener("click", openRemoteWindow);
  els.copyRemoteUrl?.addEventListener("click", copyRemoteUrl);
  els.allowRemoteFirewall?.addEventListener("click", configureRemoteFirewall);
  els.clearSetlist.addEventListener("click", clearSetlist);
  els.confirmSet.addEventListener("click", confirmSet);
  els.quickConfirmSet?.addEventListener("click", confirmSet);
  els.modeToggle.addEventListener("click", togglePlaybackMode);
  els.settingsMenu.addEventListener("click", openSettingsDrawer);
  els.closeSettings.addEventListener("click", closeSettingsDrawer);
  els.settingsBackdrop.addEventListener("click", closeSettingsDrawer);
  els.saveSettings.addEventListener("click", saveSettings);
  for (const button of els.wavPathButtons) {
    button.addEventListener("click", () => selectWavPath(button));
  }
  for (const button of els.folderPathButtons) {
    button.addEventListener("click", () => selectFolderPath(button));
  }
  els.audioDeviceSelect.addEventListener("change", () => {
    if (els.audioDeviceSelect.value) {
      els.selectedDeviceName.value = els.audioDeviceSelect.value;
      applyRoutingPresetForSelectedDevice();
    }
  });
  els.refreshAudioDevices.addEventListener("click", refreshAudioDevices);
  els.audioDiagnostics?.addEventListener("click", runAudioDiagnostics);
  els.refreshMidiDevices?.addEventListener("click", () => refreshMidiDevices({ silent: false }));
  els.testMidiSlide?.addEventListener("click", testProPresenterMidiSlide);
  els.routingPreset.addEventListener("change", () => {
    if (!state.settings) return;
    state.settings.routing.activePresetId = els.routingPreset.value;
    renderRoutingStructure();
    renderBusLayer();
  });
  els.zoomOut.addEventListener("click", () => setTimelineZoom(state.timelineZoom - timelineZoomStep(-1)));
  els.zoomIn.addEventListener("click", () => setTimelineZoom(state.timelineZoom + timelineZoomStep(1)));
  els.timelineSnap.addEventListener("change", () => {
    state.timelineSnap = currentTimelineSnap();
  });
  els.playbackKeySelect?.addEventListener("change", () => {
    if (state.selectedSetlistIndex === null) return;
    holdPlaybackKeyEditor();
    updateSetlistSongKey(state.selectedSetlistIndex, els.playbackKeySelect.value);
  });
  els.playbackKeySelect?.addEventListener("pointerdown", holdPlaybackKeyEditor);
  els.playbackKeySelect?.addEventListener("focus", holdPlaybackKeyEditor);
  els.playbackKeySelect?.addEventListener("blur", () => {
    state.playbackKeyInteractionUntil = 0;
  });
  els.playbackPadSelect?.addEventListener("change", () => {
    if (state.selectedSetlistIndex === null) return;
    updateSetlistSongPad(state.selectedSetlistIndex, els.playbackPadSelect.value);
  });
  els.playbackPadSelect?.addEventListener("pointerdown", holdPlaybackKeyEditor);
  els.playbackPadSelect?.addEventListener("focus", holdPlaybackKeyEditor);
  els.playbackPadSelect?.addEventListener("blur", () => {
    state.playbackKeyInteractionUntil = 0;
  });
  els.tempoBpm?.addEventListener("keydown", stepTempoBpmWithArrowKeys);
  els.tempoBpm?.addEventListener("change", normalizeTempoBpmInput);
  els.tempoBpm?.addEventListener("blur", normalizeTempoBpmInput);
  els.timelineRuler?.addEventListener("pointerdown", beginRulerGesture);
  els.timelineSurface.addEventListener("pointerdown", beginTimelineScrub);
  els.timelineSurface.addEventListener("contextmenu", openTimelineRegionContextMenu);
  els.timelineSurface.addEventListener("scroll", markManualTimelineScroll, { passive: true });
  els.regionLane.addEventListener("pointerdown", beginRegionSketch);
  els.createRegionFromSelection.addEventListener("click", createRegionFromSketchSelection);
  els.undoCueMove?.addEventListener("click", undoLastCueMove);
  els.selectedRegionName?.addEventListener("input", updateSelectedRegionNameFromEditor);
  els.selectedRegionName?.addEventListener("keydown", commitNameEditorOnEnter);
  els.selectedCueName?.addEventListener("input", updateSelectedCueNameFromEditor);
  els.selectedCueName?.addEventListener("keydown", commitNameEditorOnEnter);
  els.editorPlay?.addEventListener("click", playEditorFromTransport);
  els.editorRepeat?.addEventListener("click", repeatEditorSelectionOnce);
  els.editorLoop?.addEventListener("click", toggleEditorSelectionLoop);
  els.editorStop?.addEventListener("click", stopEditorPlayback);
  els.editorPause?.addEventListener("click", pauseEditorPlayback);
  els.mixerCollapse.addEventListener("click", toggleMixerCollapse);
  els.mixerResizeHandle?.addEventListener("pointerdown", beginMixerResize);
  window.addEventListener("resize", applyMixerPanelHeight);
  els.runSystemCheck.addEventListener("click", runSystemCheck);
  els.regionNameSelect.addEventListener("change", updateSelectedRegionName);
  els.regionNameSelect.addEventListener("input", updateSelectedRegionName);
  els.regionNameSelect.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    updateSelectedRegionName();
    els.regionNameSelect.blur();
  });
  els.regionRename?.addEventListener("click", () => {
    updateSelectedRegionName();
    els.regionNameSelect.focus();
    els.regionNameSelect.select();
  });
  els.regionTrim.addEventListener("click", trimSelectedRegion);
  els.regionSplit?.addEventListener("click", splitSelectedRegionAtPlayhead);
  els.regionRemoveGap?.addEventListener("click", removeSelectedRegionAndCloseGap);
  els.regionDelete.addEventListener("click", deleteSelectedRegion);
  els.saveMetadata.addEventListener("click", saveSelectedMetadata);
  els.approveMetadata?.addEventListener("click", approveSelectedMetadata);
  els.setAudioAlignSource?.addEventListener("click", setAudioAlignmentSourceMarker);
  els.setAudioAlignTarget?.addEventListener("click", setAudioAlignmentTargetMarker);
  els.alignAudioStart?.addEventListener("click", alignAudioStartToPlayhead);
  els.resetAudioAlignment?.addEventListener("click", resetAudioAlignment);
  els.addRegion.addEventListener("click", addRegionDraft);
  els.removeRegion?.addEventListener("click", removeSelectedRegionAndCloseGap);
  els.reorderRegions?.addEventListener("click", reorderRegionsByTimeline);
  els.arrangementEnabled?.addEventListener("change", toggleArrangementEnabled);
  els.undoArrangement?.addEventListener("click", undoArrangementEdit);
  els.trimSongStart?.addEventListener("click", trimSongStartToPlayhead);
  els.trimSongEnd?.addEventListener("click", trimSongEndToPlayhead);
  els.saveArrangement?.addEventListener("click", saveArrangementNow);
  els.clearArrangement?.addEventListener("click", clearArrangement);
  els.reorderCues?.addEventListener("click", reorderCuesByTimeline);
  els.addCue.addEventListener("click", addCueDraft);
  els.closeAddSong.addEventListener("click", closeAddSongModal);
  els.modalBackdrop.addEventListener("click", closeAddSongModal);
  els.addSelectedSong.addEventListener("click", addSelectedSongToSet);
  els.metadataSlot.addEventListener("change", () => {
    const slotNumber = Number(els.metadataSlot.value);
    state.selectedMetadataSlot = slotNumber;
    state.selectedSetlistIndex = slotNumber ? slotNumber - 1 : null;
    state.selectedRegionIndex = null;
  state.selectedCueIndex = null;
  state.regionSketch = null;
  state.arrangementUndoStack = [];
  syncSelectedSlotToPlayback(slotNumber);
  renderSelectedMetadata();
  renderSetlist();
});
  for (const button of els.commandButtons) {
    if (button.dataset.command === "panic") {
      button.addEventListener("pointerup", async (event) => {
        event.preventDefault();
        await handlePanicCommandClick(button);
      });
    }
    button.addEventListener("click", async () => {
      if (button.dataset.command === "panic") {
        await handlePanicCommandClick(button);
        return;
      }
      sendPlaybackCommand(button.dataset.command);
    });
  }
  els.exitPanic?.addEventListener("click", () => sendPlaybackCommand("exitPanic"));
  for (const tab of els.operatorTabs) {
    tab.addEventListener("click", () => showOperatorPanel(tab.dataset.operatorPanel));
  }
  for (const tab of els.settingsTabs) {
    tab.addEventListener("click", () => showSettingsSection(tab.dataset.settingsTab));
  }
  els.auditMetadata?.addEventListener("click", auditMetadataCache);
  els.rehydrateMetadata?.addEventListener("click", rehydrateMetadataCache);
  els.search.addEventListener("input", () => {
    state.search = els.search.value;
    renderSongs();
  });
  els.select.addEventListener("change", () => {
    if (els.select.value) loadSong(els.select.value);
  });
  els.select.addEventListener("dblclick", addSelectedSongToSet);
  document.addEventListener("focusin", markUiInteractionActive, true);
  document.addEventListener("input", markUiInteractionActive, true);
  document.addEventListener("pointerdown", markUiInteractionActive, true);
  document.addEventListener("keydown", handleKeyboardShortcuts);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".transition-tile") && !event.target.closest("#transitionEditorDock")) {
      state.openTransitionFromSlot = null;
      renderTransitionEditorDock({ force: true });
      document.querySelectorAll(".transition-tile.editing").forEach((item) => item.classList.remove("editing"));
    }
    if (!event.target.closest("#regionMenu") && !event.target.closest(".timeline-region")) {
      hideRegionMenu();
    }
  });

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => {
      state.activeVendor = tab.dataset.vendor;
      els.tabs.forEach((item) => item.classList.toggle("active", item === tab));
      renderSongs();
    });
  }

  renderSetlist();
}

function showView(viewId) {
  els.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === viewId));
  els.views.forEach((view) => view.classList.toggle("active", view.id === viewId));
}

async function selectWavPath(button) {
  const input = document.querySelector(`#${button.dataset.wavPicker}`);
  if (!input || !window.playbackShell?.selectWavFile) return;
  const filePath = await window.playbackShell.selectWavFile();
  if (!filePath) return;
  input.value = filePath;
  els.settingsStatus.textContent = "WAV selected. Save Settings to keep it.";
}

async function selectFolderPath(button) {
  const input = document.querySelector(`#${button.dataset.folderPicker}`);
  if (!input || !window.playbackShell?.selectFolder) return;
  const folderPath = await window.playbackShell.selectFolder();
  if (!folderPath) return;
  input.value = folderPath;
  els.settingsStatus.textContent = "Folder selected. Save Settings to keep it.";
}

async function loadLibrary() {
  setBusy("Loading library...");
  const library = await api("/api/library");
  state.library = library;
  renderLibraryStatus();
  renderSongs();
}

async function refreshLibrary() {
  setBusy("Scanning library metadata...");
  const library = await api("/api/library/refresh", { method: "POST" });
  state.library = library;
  renderLibraryStatus();
  renderSongs();
  await loadCurrentSetlist();
  await loadCacheReport();
  await loadPlaybackState();
  await loadSetMetadata();
  await runSystemCheck();
  closeSettingsDrawer();
}

async function reloadAppData() {
  const previousStatus = els.status.textContent;
  setBusy("Reloading saved app data...");
  if (els.reloadData) {
    els.reloadData.disabled = true;
    els.reloadData.textContent = "Reloading...";
  }
  try {
    await flushPendingAppSaves();
    await loadLibrary();
    await loadSystemInfo();
    await loadCurrentSetlist();
    await loadSettings();
    await loadPadOptions();
    await loadAudioDevices();
    await loadCueAnalyzerStatus();
    await loadCacheReport();
    await loadEngineManifestPreview();
    await loadPlaybackState();
    await loadSetMetadata();
    await redrawInvalidSetWaveforms();
    renderSelectedMetadata();
    await runSystemCheck();
    els.playbackStatus.textContent = "Saved metadata reloaded.";
  } catch (error) {
    els.status.textContent = previousStatus;
    setAlert(`Reload failed: ${error.message}`);
  } finally {
    if (els.reloadData) {
      els.reloadData.disabled = false;
      els.reloadData.textContent = "Reload";
    }
  }
}

async function flushPendingAppSaves() {
  const hadSetlistSave = Boolean(state.saveTimer);
  const hadMetadataSave = Boolean(state.metadataSaveTimer);
  const hadMixerSave = Boolean(state.mixerSaveTimer);
  clearTimeout(state.saveTimer);
  clearTimeout(state.metadataSaveTimer);
  clearTimeout(state.mixerSaveTimer);
  state.saveTimer = null;
  state.metadataSaveTimer = null;
  state.mixerSaveTimer = null;
  if (state.playbackState?.mode === "performance") return;
  if (hadSetlistSave) await saveCurrentSetlist();
  if (hadMetadataSave) await saveSelectedMetadata();
  if (hadMixerSave) await saveSelectedMixer();
}

async function loadCurrentSetlist(options = {}) {
  const setlist = await api("/api/setlist/current");
  state.setlist = setlist.slots.map((slot) => slot.songId ? setlistSongFromSlot(slot) : null);
  state.setlistTransitions = normalizeClientTransitions(setlist.transitions || []);
  state.setlistFingerprint = setFingerprintClient(setlist);
  if (options.render !== false) renderSetlist();
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  renderSettings();
}

async function loadPadOptions() {
  const result = await api("/api/pads/options");
  state.padOptions = Array.isArray(result.pads) ? result.pads : [];
  populatePlaybackPadSelect();
  renderSelectedMetadata();
}

async function loadSystemInfo() {
  state.systemInfo = await api("/api/system/info");
  renderSettings();
}

async function loadAudioDevices() {
  state.audioDevices = await api("/api/audio/devices");
  renderAudioDevices();
}

async function refreshAudioDevices() {
  if (!els.refreshAudioDevices) return;
  els.refreshAudioDevices.disabled = true;
  els.refreshAudioDevices.textContent = "Refreshing...";
  els.settingsStatus.textContent = "Looking for audio device changes...";
  try {
    await loadAudioDevices();
    await loadSettings();
    await loadPlaybackState();
    const count = state.audioDevices?.devices?.length || 0;
    const selected = state.audioDevices?.selectedDeviceName || state.settings?.audioEngine?.selectedDeviceName || "";
    els.settingsStatus.textContent = state.audioDevices?.selectedMissing
      ? `Saved audio device is missing on this PC. ${count} device${count === 1 ? "" : "s"} found; choose the playback PC device.`
      : selected
      ? `Audio devices refreshed. Saved default: ${selected}.`
      : `Audio devices refreshed. ${count} device${count === 1 ? "" : "s"} found.`;
  } catch (error) {
    els.settingsStatus.textContent = `Audio device refresh failed: ${error.message}`;
  } finally {
    els.refreshAudioDevices.disabled = false;
    els.refreshAudioDevices.textContent = "Refresh Audio Devices";
  }
}

async function runAudioDiagnostics() {
  if (!els.audioDiagnostics || !els.audioDiagnosticsReport) return;
  els.audioDiagnostics.disabled = true;
  els.audioDiagnostics.textContent = "Checking...";
  els.audioDiagnosticsReport.classList.remove("hidden");
  els.audioDiagnosticsReport.textContent = "Checking audio devices...";
  try {
    const report = await api("/api/audio/diagnostics");
    els.audioDiagnosticsReport.textContent = formatAudioDiagnosticReport(report);
    els.settingsStatus.textContent = report.conclusion || "Audio diagnostic complete.";
  } catch (error) {
    els.audioDiagnosticsReport.textContent = `Audio diagnostic failed: ${error.message}`;
    els.settingsStatus.textContent = `Audio diagnostic failed: ${error.message}`;
  } finally {
    els.audioDiagnostics.disabled = false;
    els.audioDiagnostics.textContent = "Device Diagnostic Report";
  }
}

function formatAudioDiagnosticReport(report) {
  const lines = [];
  lines.push(`Generated: ${report.generatedAt || "--"}`);
  lines.push(`Saved device: ${report.selectedDeviceName || "(none)"}`);
  lines.push(`Conclusion: ${report.conclusion || "--"}`);
  lines.push("");
  lines.push(`Merged app devices (${report.mergedDeviceCount || 0})`);
  for (const device of report.mergedDevices || []) {
    lines.push(`- ${device.name || device.id || "--"} [${device.driver || "--"}]${device.source ? ` ${device.source}` : ""}`);
  }
  lines.push("");
  lines.push(`JUCE raw devices (${report.helper?.rawDeviceCount || 0})`);
  lines.push(`JUCE helper: ${report.helper?.ok ? "ok" : "failed"} ${report.helper?.error || ""}`);
  lines.push(`JUCE helper path: ${report.helper?.helperPath || "--"}`);
  lines.push(`JUCE exit code: ${report.helper?.exitCode ?? "--"}${report.helper?.signal ? ` signal=${report.helper.signal}` : ""}`);
  if (report.helper?.stderr) lines.push(`JUCE stderr: ${report.helper.stderr}`);
  if (report.helper?.stdout && !report.helper?.rawDeviceCount) lines.push(`JUCE stdout: ${report.helper.stdout}`);
  for (const device of report.helper?.rawDevices || []) {
    lines.push(`- ${device.name || device.id || "--"} [${device.type || "--"}]`);
  }
  lines.push("");
  lines.push(`ASIO registry (${report.asioRegistryCount || 0})`);
  for (const device of report.asioRegistry || []) {
    lines.push(`- ${device.name || device.registryName || "--"} CLSID=${device.clsid || "--"}`);
  }
  lines.push("");
  lines.push(`Windows sound devices (${report.windowsSoundDeviceCount || 0})`);
  for (const device of report.windowsSoundDevices || []) {
    lines.push(`- ${device.name || "--"} [${device.status || "--"}] ${device.manufacturer || ""}`);
  }
  lines.push("");
  lines.push(`Live JUCE output signals: ${report.outputSignals?.active ? "active" : "stopped"}`);
  lines.push(`Measurement: ${report.outputSignals?.measurementPoint || "--"}`);
  for (const output of report.outputSignals?.outputs || []) {
    const sources = (output.sources || [])
      .map((source) => `${source.name}=${Number(source.level || 0).toFixed(4)}`)
      .join(", ");
    lines.push(`- Output ${output.channel}: peak=${Number(output.peak || 0).toFixed(4)} | ${sources || "no routed sources"}`);
  }
  lines.push("");
  lines.push(`Dante matches (${report.danteMatches?.length || 0})`);
  for (const device of report.danteMatches || []) {
    lines.push(`- ${device.name || device.id || "--"} [${device.driver || device.type || "--"}]`);
  }
  return lines.join("\n");
}

async function loadCacheReport() {
  state.cacheReport = await api("/api/playback/cache-report");
  renderCacheReport();
}

async function loadCueAnalyzerStatus() {
  if (!els.cueAnalyzerStatus) return;
  try {
    state.cueAnalyzerStatus = await api("/api/analyzer/cue-status");
  } catch (error) {
    state.cueAnalyzerStatus = {
      ok: false,
      cueRecognizer: "vosk-closed-grammar",
      voskStatus: "error",
      message: error.message
    };
  }
  renderCueAnalyzerStatus();
}

async function analyzeDynamicCuesForSelectedSlot() {
  const selected = selectedMetadata();
  if (!selected) {
    setAlert("Select a setlist song before analyzing dynamic cues.");
    return;
  }
  els.analyzeDynamicCues.disabled = true;
  els.analyzeDynamicCues.textContent = "Analyzing...";
  try {
    const result = await api("/api/analyzer/dynamic-cues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: selected.slot })
    });
    await loadSetMetadata();
    renderCueRecognitionReport(selectedMetadata());
    els.settingsStatus.textContent = result.ok ? "Dynamic cue analysis complete." : result.report?.error || "Dynamic cue analysis failed.";
  } catch (error) {
    setAlert(error.message);
    els.settingsStatus.textContent = error.message;
  } finally {
    els.analyzeDynamicCues.disabled = false;
    els.analyzeDynamicCues.textContent = "Analyze Dynamic Cues";
  }
}

async function saveSettings() {
  const preset = (state.settings?.routing?.presets || []).find((item) => item.id === els.routingPreset.value);
  const presets = updateRoutingPresetFromInputs(state.settings?.routing?.presets || [], els.routingPreset.value);
  state.settings = await api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioEngine: {
        selectedDeviceId: els.selectedDeviceName.value,
        selectedDeviceName: els.selectedDeviceName.value,
        sampleRate: Number(els.sampleRate.value)
      },
      library: {
        rootPath: els.libraryRootInput.value
      },
      routing: {
        activePresetId: els.routingPreset.value,
        presets
      },
      dynamicCue: {
        folderPath: els.dynamicCueFolder.value
      },
      pads: {
        folderPath: els.padsFolder.value,
        defaultEnabled: els.padsDefaultEnabled?.checked,
        startWithSong: els.padsStartWithSong?.checked,
        continueBetweenSongs: els.padsContinueBetweenSongs?.checked,
        defaultVolume: Math.max(0, Math.min(1, Number(els.padsDefaultVolume?.value || 65) / 100)),
        fadeInMs: Number(els.padsFadeIn?.value || 1500),
        fadeOutMs: Number(els.padsFadeOut?.value || 2500)
      },
      dynamicClick: {},
      proPresenterMidi: {
        enabled: Boolean(els.proPresenterMidiEnabled?.checked),
        outputId: els.proPresenterMidiOutput?.value || "",
        outputName: selectedMidiOutputName(),
        channel: Number(els.proPresenterMidiChannel?.value || 1),
        nextSlideNote: Number(els.proPresenterMidiNote?.value || 60),
        velocity: Number(els.proPresenterMidiVelocity?.value || 100),
        noteLengthMs: Number(els.proPresenterMidiLength?.value || 80)
      }
    })
  });
  els.settingsStatus.textContent = `Settings saved. Active routing: ${preset?.name || els.routingPreset.value}.`;
  await loadPadOptions();
  await loadAudioDevices();
  await loadEngineManifestPreview();
  renderSettings();
}

function updateRoutingPresetFromInputs(presets, presetId) {
  const routeRows = [...document.querySelectorAll("[data-route-row]")];
  const routeInputs = [...document.querySelectorAll("[data-route-key]")];
  if (!routeRows.length && !routeInputs.length) return presets;
  return presets.map((preset) => {
    if (preset.id !== presetId) return preset;
    const routes = { ...(preset.routes || {}) };
    for (const row of routeRows) {
      const key = row.dataset.routeRow;
      routes[key] = [...row.querySelectorAll("[data-route-channel].active")]
        .map((cell) => Number(cell.dataset.routeChannel))
        .filter((number) => Number.isFinite(number) && number > 0)
        .sort((a, b) => a - b);
    }
    for (const input of routeInputs) {
      routes[input.dataset.routeKey] = input.value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((number) => Number.isFinite(number) && number > 0);
    }
    return { ...preset, routes };
  });
}

async function loadEngineManifestPreview() {
  if (!els.engineManifestPreview) return;
  try {
    const result = await api("/api/engine/manifest");
    if (!result.exists) {
      els.engineManifestPreview.textContent = "Confirm Set to create the engine snapshot.";
      return;
    }
    els.engineManifestPreview.textContent = JSON.stringify({
      path: result.path,
      confirmedAt: result.manifest?.confirmedAt,
      sampleRate: result.manifest?.sampleRate,
      routingPresetId: result.manifest?.routingPresetId,
      songs: (result.manifest?.songs || []).map((song) => ({
        slot: song.slot,
        title: song.title,
        stems: song.stems?.length || 0
      }))
    }, null, 2);
  } catch (error) {
    els.engineManifestPreview.textContent = error.message;
  }
}

async function runSystemCheck() {
  if (!els.systemCheckResult) return;
  els.systemCheckResult.querySelector("strong").textContent = "Checking...";
  try {
    const result = await api("/api/system/check");
    const errors = result.errors || [];
    const warnings = result.warnings || [];
    els.systemCheckResult.classList.toggle("failed", errors.length > 0);
    els.systemCheckResult.classList.toggle("warning", !errors.length && warnings.length > 0);
    els.systemCheckResult.querySelector("strong").textContent = errors.length
      ? `Errors: ${errors.join(" | ")}`
      : warnings.length
        ? `Warnings: ${warnings.join(" | ")}`
        : "No errors";
  } catch (error) {
    els.systemCheckResult.classList.add("failed");
    els.systemCheckResult.querySelector("strong").textContent = error.message;
  }
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  els.libraryRootPath.textContent = settings.library?.rootPath || state.library?.root || "--";
  els.libraryRootInput.value = settings.library?.rootPath || state.library?.root || "";
  els.libraryVendorFolders.textContent = (state.library?.vendors || []).join(", ") || "--";
  els.appDataPath.textContent = state.systemInfo?.dataDir || "--";
  els.audioReadiness.textContent = settings.audioEngine?.selectedDeviceName
    ? `Waiting for ${settings.audioEngine.selectedDeviceName}`
    : "JUCE offline";
  els.selectedDeviceName.value = settings.audioEngine.selectedDeviceName || "";
  els.sampleRate.value = String(settings.audioEngine.sampleRate || 48000);
  els.dynamicCueFolder.value = settings.dynamicCue.folderPath || "";
  els.padsFolder.value = settings.pads?.folderPath || "";
  if (els.padsDefaultEnabled) els.padsDefaultEnabled.checked = settings.pads?.defaultEnabled !== false;
  if (els.padsStartWithSong) els.padsStartWithSong.checked = settings.pads?.startWithSong !== false;
  if (els.padsContinueBetweenSongs) els.padsContinueBetweenSongs.checked = settings.pads?.continueBetweenSongs !== false;
  if (els.padsDefaultVolume) els.padsDefaultVolume.value = String(Math.round(Number(settings.pads?.defaultVolume ?? 0.65) * 100));
  if (els.padsFadeIn) els.padsFadeIn.value = String(settings.pads?.fadeInMs ?? 1500);
  if (els.padsFadeOut) els.padsFadeOut.value = String(settings.pads?.fadeOutMs ?? 2500);
  if (els.dynamicClickPatternFolder) {
    els.dynamicClickPatternFolder.value = settings.dynamicClick?.soundFolderPath || "D:\\PlaybackAppV2\\click-patterns";
  }
  renderMidiSettings();
  els.routingPreset.replaceChildren();
  for (const preset of settings.routing.presets || []) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    option.selected = preset.id === settings.routing.activePresetId;
    els.routingPreset.append(option);
  }
  els.deviceListPreview.textContent = settings.audioEngine?.selectedDeviceName
    ? `Saved default: ${settings.audioEngine.selectedDeviceName}`
    : "No default device saved";
  renderAudioDevices();
  renderRoutingStructure();
  renderRemoteSettings();
  renderFoundationPanels();
}

function renderMidiSettings() {
  const settings = state.settings?.proPresenterMidi || {};
  if (els.proPresenterMidiEnabled) els.proPresenterMidiEnabled.checked = Boolean(settings.enabled);
  if (els.proPresenterMidiChannel) els.proPresenterMidiChannel.value = String(settings.channel || 1);
  if (els.proPresenterMidiNote) els.proPresenterMidiNote.value = String(settings.nextSlideNote ?? 60);
  if (els.proPresenterMidiVelocity) els.proPresenterMidiVelocity.value = String(settings.velocity || 100);
  if (els.proPresenterMidiLength) els.proPresenterMidiLength.value = String(settings.noteLengthMs || 80);
  if (!els.proPresenterMidiOutput) return;
  const selectedId = settings.outputId || "";
  els.proPresenterMidiOutput.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.midiOutputs.length ? "Choose MIDI output" : "No MIDI outputs scanned";
  els.proPresenterMidiOutput.append(placeholder);
  for (const output of state.midiOutputs) {
    const option = document.createElement("option");
    option.value = output.id;
    option.textContent = output.manufacturer ? `${output.name} (${output.manufacturer})` : output.name;
    option.selected = output.id === selectedId;
    els.proPresenterMidiOutput.append(option);
  }
  if (selectedId && !state.midiOutputs.some((output) => output.id === selectedId)) {
    const missing = document.createElement("option");
    missing.value = selectedId;
    missing.textContent = settings.outputName ? `${settings.outputName} (missing)` : "Saved device missing";
    missing.selected = true;
    els.proPresenterMidiOutput.append(missing);
  }
  setMidiStatus(settings.enabled
    ? (selectedId ? "Ready when output is available" : "Choose an output")
    : "Disabled");
}

async function refreshMidiDevices(options = {}) {
  if (!("requestMIDIAccess" in navigator)) {
    setMidiStatus("Web MIDI is not available in this Electron build.");
    return [];
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    state.midiOutputs = [...state.midiAccess.outputs.values()].map((output) => ({
      id: output.id,
      name: output.name || "MIDI Output",
      manufacturer: output.manufacturer || ""
    })).sort((left, right) => left.name.localeCompare(right.name));
    state.midiAccess.onstatechange = () => {
      state.midiOutputs = [...state.midiAccess.outputs.values()].map((output) => ({
        id: output.id,
        name: output.name || "MIDI Output",
        manufacturer: output.manufacturer || ""
      })).sort((left, right) => left.name.localeCompare(right.name));
      renderMidiSettings();
    };
    renderMidiSettings();
    if (!options.silent) setMidiStatus(`${state.midiOutputs.length} MIDI output(s) found.`);
    return state.midiOutputs;
  } catch (error) {
    setMidiStatus(`MIDI scan failed: ${error.message}`);
    return [];
  }
}

function selectedMidiOutputName() {
  const outputId = els.proPresenterMidiOutput?.value || "";
  return state.midiOutputs.find((output) => output.id === outputId)?.name || state.settings?.proPresenterMidi?.outputName || "";
}

function setMidiStatus(message) {
  const target = els.proPresenterMidiStatus?.querySelector("strong");
  if (target) target.textContent = message;
}

async function ensureMidiOutput() {
  const settings = state.settings?.proPresenterMidi || {};
  if (!settings.enabled) return null;
  if (!state.midiAccess) await refreshMidiDevices({ silent: true });
  const outputId = settings.outputId || els.proPresenterMidiOutput?.value || "";
  const output = outputId ? state.midiAccess?.outputs?.get(outputId) : null;
  if (!output) {
    setMidiStatus(settings.outputName ? `${settings.outputName} is not available.` : "Choose a MIDI output.");
    return null;
  }
  return output;
}

async function sendProPresenterNextSlide() {
  const output = await ensureMidiOutput();
  if (!output) return false;
  const settings = state.settings?.proPresenterMidi || {};
  const channel = Math.max(1, Math.min(16, Math.round(Number(settings.channel || 1)))) - 1;
  const note = Math.max(0, Math.min(127, Math.round(Number(settings.nextSlideNote ?? 60))));
  const velocity = Math.max(1, Math.min(127, Math.round(Number(settings.velocity || 100))));
  const lengthMs = Math.max(20, Math.min(1000, Math.round(Number(settings.noteLengthMs || 80))));
  output.send([0x90 + channel, note, velocity]);
  window.setTimeout(() => output.send([0x80 + channel, note, 0]), lengthMs);
  setMidiStatus(`Sent next slide note ${note} on channel ${channel + 1}.`);
  return true;
}

async function testProPresenterMidiSlide() {
  await saveSettings();
  await sendProPresenterNextSlide();
}

function serviceProPresenterMidiCues(slot) {
  const settings = state.settings?.proPresenterMidi || {};
  const playback = state.playbackState || {};
  if (!settings.enabled || !slot || playback.transport !== "playing") {
    state.midiCueTracker = null;
    return;
  }
  if (playback.panic?.active === true && settings.fireInPanic !== true) return;
  if (Number(playback.currentSlot) !== Number(slot.slot)) return;
  const point = currentScrubPoint(slot);
  if (!point) return;
  const currentTime = Number(point.timeSeconds || 0);
  const tracker = state.midiCueTracker;
  const slotChanged = Number(tracker?.slot) !== Number(slot.slot);
  const seekedBackward = tracker && currentTime < Number(tracker.lastTimeSeconds || 0) - 0.25;
  if (!tracker || slotChanged || seekedBackward) {
    state.midiCueTracker = {
      slot: slot.slot,
      lastTimeSeconds: Math.max(0, currentTime - 0.05),
      fired: new Set()
    };
    return;
  }
  const cues = (slot.cues?.cueMarkers || [])
    .map((cue, index) => ({
      key: cue.id || `${cue.name || "cue"}-${cue.bar || 1}-${cue.beat || 1}-${index}`,
      timeSeconds: timeForBarBeat(slot, cue.bar || 1, cue.beat || 1)
    }))
    .filter((cue) => Number.isFinite(cue.timeSeconds))
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  const previousTime = Number(tracker.lastTimeSeconds || 0);
  tracker.lastTimeSeconds = currentTime;
  for (const cue of cues) {
    if (tracker.fired.has(cue.key)) continue;
    if (cue.timeSeconds <= previousTime + 0.001 || cue.timeSeconds > currentTime + 0.001) continue;
    tracker.fired.add(cue.key);
    sendProPresenterNextSlide().catch((error) => setMidiStatus(`MIDI send failed: ${error.message}`));
  }
}

function renderRemoteSettings() {
  if (!els.remotePrimaryUrl) return;
  const links = remoteLinks();
  const urls = links.performance;
  const primary = primaryRemoteUrl();
  els.remotePrimaryUrl.textContent = primary;
  if (els.remoteStatus) {
    els.remoteStatus.textContent = state.playbackState?.mode === "performance"
      ? "Performance remote active"
      : "Available in Edit and Performance";
  }
  renderRemoteLinkCards(links);
  if (!els.remoteUrlList) return;
  els.remoteUrlList.replaceChildren();
  for (const url of [...links.performance, ...links.rehearsal]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "remote-url-item";
    item.textContent = url;
    item.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(url);
      els.settingsStatus.textContent = "Remote URL copied.";
    });
    els.remoteUrlList.append(item);
  }
}

function renderRemoteLinkCards(links) {
  if (!els.remoteLinkCards) return;
  els.remoteLinkCards.replaceChildren();
  const cards = [
    {
      title: "Performance Remote",
      note: "Operator-safe show controls",
      url: primaryRemoteUrl("performance")
    },
    {
      title: "Rehearsal Remote",
      note: "MD section start tools",
      url: primaryRemoteUrl("rehearsal")
    }
  ];
  for (const card of cards) {
    const item = document.createElement("article");
    item.className = "remote-link-card";
    item.innerHTML = `
      <div class="remote-link-copy">
        <span>${escapeHtml(card.note)}</span>
        <strong>${escapeHtml(card.title)}</strong>
        <button type="button" class="remote-card-url">${escapeHtml(card.url)}</button>
        <div class="remote-card-actions">
          <button type="button" data-remote-open="${escapeHtml(card.url)}">Open</button>
          <button type="button" data-remote-copy="${escapeHtml(card.url)}">Copy</button>
        </div>
      </div>
      <img class="remote-qr" alt="${escapeHtml(card.title)} QR code" src="${remoteQrUrl(card.url)}">
    `;
    item.querySelector("[data-remote-open]")?.addEventListener("click", () => window.open(card.url, "_blank", "noopener"));
    item.querySelector("[data-remote-copy]")?.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(card.url);
      els.settingsStatus.textContent = `${card.title} URL copied.`;
    });
    item.querySelector(".remote-card-url")?.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(card.url);
      els.settingsStatus.textContent = `${card.title} URL copied.`;
    });
    els.remoteLinkCards.append(item);
  }
}

function remoteUrls() {
  return remoteLinks().performance;
}

function remoteLinks() {
  const links = state.systemInfo?.remoteLinks || {};
  const performance = Array.isArray(links.performance) && links.performance.length
    ? links.performance
    : Array.isArray(state.systemInfo?.remoteUrls) && state.systemInfo.remoteUrls.length
      ? state.systemInfo.remoteUrls
      : [`${window.location.origin}/remote`];
  const rehearsal = Array.isArray(links.rehearsal) && links.rehearsal.length
    ? links.rehearsal
    : performance.map((url) => url.replace(/\/remote$/, "/rehearsal"));
  return { performance, rehearsal };
}

function primaryRemoteUrl(type = "performance") {
  const urls = remoteLinks()[type] || remoteUrls();
  return urls.find((url) => !url.includes("127.0.0.1")) || urls[0] || `${window.location.origin}/remote`;
}

function remoteQrUrl(url) {
  return `/api/remote/qr?url=${encodeURIComponent(url)}`;
}

function openRemoteWindow() {
  window.open(primaryRemoteUrl(), "_blank", "noopener");
}

async function copyRemoteUrl() {
  await navigator.clipboard?.writeText(primaryRemoteUrl());
  els.settingsStatus.textContent = "Remote URL copied.";
}

async function configureRemoteFirewall() {
  if (!window.playbackShell?.configureRemoteAccess) {
    if (els.remoteFirewallStatus) els.remoteFirewallStatus.textContent = "Firewall setup is available in the installed Electron app.";
    return;
  }
  els.allowRemoteFirewall.disabled = true;
  if (els.remoteFirewallStatus) els.remoteFirewallStatus.textContent = "Approve the Windows administrator prompt to allow phone and tablet access.";
  try {
    const result = await window.playbackShell.configureRemoteAccess();
    if (!result?.ok) throw new Error(result?.error || "Windows did not add the remote-access rule.");
    if (els.remoteFirewallStatus) {
      els.remoteFirewallStatus.textContent = `Remote access allowed on local networks through TCP port ${result.port}.`;
    }
    els.settingsStatus.textContent = "Phone and tablet remote access enabled.";
  } catch (error) {
    if (els.remoteFirewallStatus) els.remoteFirewallStatus.textContent = error.message;
    els.settingsStatus.textContent = "Remote firewall setup was not completed.";
  } finally {
    els.allowRemoteFirewall.disabled = false;
  }
}

function renderAudioDevices() {
  if (!els.audioDeviceSelect) return;
  const devices = state.audioDevices?.devices || [];
  els.audioDeviceSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = devices.length ? "Choose saved device" : "No saved device";
  els.audioDeviceSelect.append(placeholder);
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id || device.name;
    option.textContent = `${device.name} (${device.driver}${device.channels ? `, ${device.channels}ch` : ""})${device.available ? "" : " - offline"}`;
    option.selected = device.selected;
    els.audioDeviceSelect.append(option);
  }
  const selected = state.audioDevices?.selectedDeviceName || state.settings?.audioEngine?.selectedDeviceName || "";
  els.deviceListPreview.textContent = state.audioDevices?.selectedMissing
    ? `Saved default not found on this PC: ${selected}`
    : selected
    ? `Saved default: ${selected}`
    : "No default device saved";
}

function renderFoundationPanels() {
  renderReadinessSummary();
  renderCacheReport();
  renderCueAnalyzerStatus();
  renderCueRecognitionReport(selectedMetadata());
  renderBusLayer();
  renderPadLayer();
}

function renderReadinessSummary() {
  if (!els.readinessSummary) return;
  const playback = state.playbackState || {};
  const readiness = playback.readiness || {};
  const engine = readiness.engine || {};
  const items = [
    ["Readiness", titleCase(readiness.state || "blocked"), readiness.state === "ready" ? "ready" : readiness.state === "warning" ? "warning" : "failed"],
    ["Cache", readiness.cacheReady ? "Ready" : "Needs Confirm Set", readiness.cacheReady ? "ready" : "warning"],
    ["Device", readiness.audioDevice?.state === "ready" ? readiness.audioDevice.selectedDeviceName || "Ready" : "Missing", readiness.audioDevice?.state === "ready" ? "ready" : "failed"],
    ["Engine", engineStatusLabel(engine.state || "offline"), engine.state === "ready" ? "ready" : "warning"],
    ["Heartbeat", engine.heartbeatRequired ? (engine.heartbeatFresh ? "Fresh" : "Waiting") : "Standby", engine.heartbeatRequired && !engine.heartbeatFresh ? "warning" : "ready"],
    ["Set", playback.confirmed ? "Confirmed" : "Unconfirmed", playback.confirmed ? "ready" : "warning"]
  ];
  els.readinessSummary.replaceChildren(...items.map(([label, value, status]) => statusPill(label, value, status)));
}

function renderCacheReport() {
  if (!els.cacheReport) return;
  const rows = state.cacheReport?.rows?.length
    ? state.cacheReport.rows
    : state.setlist
      .map((song, index) => song ? {
        slot: index + 1,
        title: song.title,
        state: song.readinessState || song.cacheStatus || "not-cached",
        expectedTrackCount: song.trackCount || 0,
        cachedTrackCount: song.cachedTrackCount || 0,
        cacheFolder: song.cacheFolder || ""
      } : null)
      .filter(Boolean);
  els.cacheReport.replaceChildren();
  const header = document.createElement("div");
  header.className = "section-header-line";
  header.innerHTML = `<strong>Cache Report</strong><span>${escapeHtml(titleCase(state.cacheReport?.state || "blocked"))} | ${rows.length} filled slot${rows.length === 1 ? "" : "s"}</span>`;
  els.cacheReport.append(header);
  if (!rows.length) {
    els.cacheReport.append(emptyState("No songs in the current set."));
    return;
  }
  for (const rowData of rows) {
    const row = document.createElement("div");
    const pseudoSong = { readinessState: rowData.state, cacheStatus: rowData.state };
    const status = readinessLabel(pseudoSong);
    row.className = `cache-row ${readinessClass(pseudoSong)}`;
    row.innerHTML = `
      <strong>${escapeHtml(rowData.slot)}. ${escapeHtml(rowData.title)}</strong>
      <span>${escapeHtml(status)}</span>
      <span>${escapeHtml(rowData.cachedTrackCount || 0)} / ${escapeHtml(rowData.expectedTrackCount || 0)} WAVs</span>
      <span>${escapeHtml(rowData.cacheFolder || rowData.message || "Confirm Set builds cache")}</span>
    `;
    els.cacheReport.append(row);
  }
}

function renderCueAnalyzerStatus() {
  if (!els.cueAnalyzerStatus) return;
  const status = state.cueAnalyzerStatus || {};
  els.cueAnalyzerStatus.classList.toggle("failed", status.ok === false);
  els.cueAnalyzerStatus.classList.toggle("warning", status.ok !== false && status.voskStatus !== "ready");
  const recognizer = status.cueRecognizer || "vosk-closed-grammar";
  const vosk = status.voskStatus || "unknown";
  els.cueAnalyzerStatus.querySelector("strong").textContent = `${recognizer} | Vosk ${vosk}`;
}

function renderCueRecognitionReport(slot) {
  if (!els.cueRecognitionReport) return;
  els.cueRecognitionReport.replaceChildren();
  const report = slot && slot.cueRecognition?.songId === slot.songId ? slot.cueRecognition : null;
  const map = slot && slot.dynamicCueMap?.songId === slot.songId ? slot.dynamicCueMap : null;
  const header = document.createElement("div");
  header.className = "section-header-line";
  const selectedLabel = slot ? `Slot ${slot.slot}: ${slot.title}` : "No song selected";
  header.innerHTML = `<strong>Dynamic Cue Analysis</strong><span>${escapeHtml(selectedLabel)} | ${escapeHtml(report?.status || "Not run")}</span>`;
  els.cueRecognitionReport.append(header);
  if (!report) {
    els.cueRecognitionReport.append(emptyState("Run analysis for the selected setlist song."));
    return;
  }
  const summary = report.summary || {};
  const summaryRow = document.createElement("div");
  summaryRow.className = "cue-candidate-row";
  summaryRow.innerHTML = `
    <strong>${escapeHtml(report.title || "Selected song")}</strong>
    <span>${escapeHtml(summary.trustedCount || 0)} trusted | ${escapeHtml(summary.reviewCount || 0)} review | ${escapeHtml(summary.rejectedCount || 0)} rejected</span>
  `;
  els.cueRecognitionReport.append(summaryRow);
  const entriesById = new Map((map?.entries || []).map((entry) => [entry.candidateId, entry]));
  for (const candidate of (report.candidates || []).slice(0, 24)) {
    const mapped = entriesById.get(candidate.id);
    const parts = (mapped?.parts || []).map((part) => part.fileName || `Missing: ${part.phrase}`).join(" + ") || "--";
    const row = document.createElement("div");
    row.className = `cue-candidate-row ${candidate.status || ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(formatSeconds(candidate.spokenAtSeconds || 0))} ${escapeHtml(candidate.rawTranscript || candidate.normalizedPhrase || "--")}</strong>
      <span>${escapeHtml(candidate.label || "No label")} | ${escapeHtml(candidate.command || "--")} | ${Math.round(Number(candidate.confidence || 0) * 100)}%</span>
      <span>${escapeHtml(candidate.gridStatus || "--")} | ${escapeHtml(parts)}</span>
    `;
    els.cueRecognitionReport.append(row);
  }
}

function renderRoutingStructure() {
  if (!els.routingStructure || !state.settings) return;
  const preset = activeRoutingPreset();
  const outputCount = routingMatrixOutputCount();
  const selectedDevice = selectedAudioDevice();
  els.routingStructure.replaceChildren();
  const header = document.createElement("div");
  header.className = "section-header-line";
  header.innerHTML = `<strong>Dante / ASIO Matrix</strong><span>${escapeHtml(selectedDevice?.name || state.settings.audioEngine?.selectedDeviceName || "No device")} | ${escapeHtml(preset?.name || "No preset")} | ${outputCount} outputs</span>`;
  els.routingStructure.append(header);
  const matrix = document.createElement("div");
  matrix.className = "dante-matrix";
  const headers = Array.from({ length: outputCount }, (_, index) => `<div class="dante-matrix-header">${index + 1}</div>`).join("");
  const rows = DANTE_ROUTING_ROWS.map((row) => {
    const selected = new Set((Array.isArray(preset?.routes?.[row.key]) ? preset.routes[row.key].map(Number) : [])
      .filter((channel) => channel <= outputCount));
    const cells = Array.from({ length: outputCount }, (_, index) => {
      const channel = index + 1;
      const active = selected.has(channel);
      return `<button class="dante-matrix-cell${active ? " active" : ""}${channel % 8 === 0 ? " channel-boundary" : ""}" type="button" data-route-channel="${channel}" aria-label="${escapeAttr(row.label)} output ${channel}" aria-pressed="${active ? "true" : "false"}"></button>`;
    }).join("");
    return `
      <div class="dante-matrix-row" data-route-row="${escapeAttr(row.key)}">
        <div class="dante-matrix-label"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.hint)}</span></div>
        ${cells}
        <div class="dante-matrix-summary" data-route-summary>${escapeHtml(routingChannelsLabel([...selected]))}</div>
      </div>
    `;
  }).join("");
  matrix.innerHTML = `
    <div class="dante-matrix-scroll">
      <div class="dante-matrix-grid">
        <div class="dante-matrix-corner">Bus</div>
        ${headers}
        <div class="dante-matrix-summary-header">Out</div>
        ${rows}
      </div>
    </div>
  `;
  const grid = matrix.querySelector(".dante-matrix-grid");
  if (grid) grid.style.gridTemplateColumns = `minmax(180px, 230px) repeat(${outputCount}, 30px) minmax(64px, 82px)`;
  matrix.querySelectorAll("[data-route-channel]").forEach((cell) => {
    cell.addEventListener("click", () => toggleDanteMatrixCell(cell));
  });
  els.routingStructure.append(matrix);
}

function applyRoutingPresetForSelectedDevice() {
  if (!state.settings || !els.routingPreset) return;
  const deviceName = els.selectedDeviceName.value || "";
  const nextPresetId = isDanteDeviceName(deviceName) ? "dante-32" : state.settings.routing?.activePresetId;
  if (nextPresetId && [...els.routingPreset.options].some((option) => option.value === nextPresetId)) {
    els.routingPreset.value = nextPresetId;
    state.settings.routing.activePresetId = nextPresetId;
  }
  renderRoutingStructure();
  renderBusLayer();
}

function selectedAudioDevice() {
  const selected = els.selectedDeviceName?.value || state.audioDevices?.selectedDeviceName || state.settings?.audioEngine?.selectedDeviceName || "";
  const devices = state.audioDevices?.devices || [];
  return devices.find((device) => device.id === selected || device.name === selected) || state.audioDevices?.selectedDevice || null;
}

function routingMatrixOutputCount() {
  const device = selectedAudioDevice();
  const deviceName = `${device?.id || ""} ${device?.name || ""} ${state.settings?.audioEngine?.selectedDeviceName || ""}`;
  if (isDanteDeviceName(deviceName)) return 32;
  const channels = Number(device?.channels || state.audioDevices?.selectedDevice?.channels || 0);
  return Math.max(2, Math.min(32, Number.isFinite(channels) && channels > 0 ? channels : 32));
}

function isDanteDeviceName(value) {
  return /dante/i.test(String(value || ""));
}

function toggleDanteMatrixCell(cell) {
  const row = cell.closest("[data-route-row]");
  if (!row) return;
  const active = !cell.classList.contains("active");
  cell.classList.toggle("active", active);
  cell.setAttribute("aria-pressed", active ? "true" : "false");
  const channels = [...row.querySelectorAll("[data-route-channel].active")]
    .map((activeCell) => Number(activeCell.dataset.routeChannel))
    .filter((channel) => Number.isFinite(channel))
    .sort((a, b) => a - b);
  const summary = row.querySelector("[data-route-summary]");
  if (summary) summary.textContent = routingChannelsLabel(channels);
}

function routingChannelsLabel(channels) {
  const parsed = [...new Set((Array.isArray(channels) ? channels : [])
    .map(Number)
    .filter((channel) => Number.isFinite(channel) && channel > 0))]
    .sort((a, b) => a - b);
  return parsed.length ? parsed.join(", ") : "Off";
}

function renderBusLayer() {
  if (!els.busLayer) return;
  const selected = selectedMetadata();
  const preset = activeRoutingPreset();
  const busRows = [
    ["Tracks", "tracks"],
    ["Click", "click"],
    ["Guide", "cues"],
    ["Pads", "pads"],
    ["Dynamic Cue", "dynamicCue"],
    ["IEM", "iem"]
  ];
  els.busLayer.replaceChildren();
  const header = document.createElement("div");
  header.className = "section-header-line";
  header.innerHTML = `<strong>${escapeHtml(selected?.title || "No song selected")}</strong><span>${escapeHtml(preset?.name || "No routing preset")}</span>`;
  els.busLayer.append(header);
  for (const [label, key] of busRows) {
    const row = document.createElement("div");
    row.className = "bus-row";
    const outputs = Array.isArray(preset?.routes?.[key]) ? preset.routes[key].join(", ") : "Stem default";
    const busStems = key === "iem"
      ? selected?.mixer?.stems?.filter((stem) => stem.iemSend && canonicalRoute(stem.routeBus || stem.role || classifyClientStem(stem.name || stem.fileName)) === "tracks") || []
      : selected?.mixer?.stems?.filter((stem) => canonicalRoute(stem.routeBus || stem.role || classifyClientStem(stem.name || stem.fileName)) === key) || [];
    const soloCount = busStems.filter((stem) => stem.solo).length;
    const averageVolume = busStems.length
      ? Math.round(busStems.reduce((total, stem) => total + Number(stem.volume ?? 80), 0) / busStems.length)
      : 0;
    row.innerHTML = `
      <strong>${escapeHtml(label)}</strong>
      <div class="meter-track horizontal"><div class="meter-fill" style="width: ${averageVolume}%"></div></div>
      <span>${busStems.length} stem${busStems.length === 1 ? "" : "s"}${soloCount ? ` | ${soloCount} solo` : ""}</span>
      <span>Out ${escapeHtml(outputs)}</span>
    `;
    els.busLayer.append(row);
  }
}

function renderPadLayer() {
  if (!els.padLayer) return;
  const selected = selectedMetadata();
  const clickPatternFolder = state.settings?.dynamicClick?.soundFolderPath || "D:\\PlaybackAppV2\\click-patterns";
  const dynamicCueFolder = state.settings?.dynamicCue?.folderPath || "No dynamic cue folder";
  const padsFolder = state.settings?.pads?.folderPath || "No pads folder";
  els.padLayer.replaceChildren();
  const rows = [
    ["Dynamic Cue", dynamicCueFolder],
    ["Dynamic Click", clickPatternFolder],
    ["Pads", padsFolder],
    ["Selected Song", selected ? "Ready with selected song" : "Select song"]
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "pad-row";
    row.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span>`;
    els.padLayer.append(row);
  }
}

function activeRoutingPreset() {
  return (state.settings?.routing?.presets || []).find((preset) => preset.id === state.settings?.routing?.activePresetId)
    || state.settings?.routing?.presets?.[0]
    || null;
}

function statusPill(label, value, status) {
  const item = document.createElement("div");
  item.className = `status-pill ${status}`;
  item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "--")}</strong>`;
  return item;
}

function emptyState(message) {
  const item = document.createElement("div");
  item.className = "empty-state";
  item.textContent = message;
  return item;
}

function markUiInteractionActive(event = null) {
  const target = event?.target;
  if (isInteractiveElement(target) || target?.closest?.(".region-menu, .song-action-menu, #transitionEditorDock, .mixer-strip")) {
    state.uiInteractionHoldUntil = Date.now() + 1200;
  }
}

function isUserEditingUi() {
  const active = document.activeElement;
  if (isInteractiveElement(active)) return true;
  if (Date.now() < Number(state.uiInteractionHoldUntil || 0)) return true;
  if (state.openTransitionFromSlot) return true;
  if (els.regionMenu && !els.regionMenu.classList.contains("hidden")) return true;
  if (document.querySelector(".setlist-slot.menu-open")) return true;
  return false;
}

function isInteractiveElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest("[data-live-render-safe]")) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true'], .transition-editor, #transitionEditorDock, .region-menu, .song-action-menu, .mixer-strip"));
}

async function loadPlaybackState() {
  const playback = await api("/api/playback/state");
  state.playbackState = playback && typeof playback === "object" ? playback : { mode: "edit", transport: "stopped" };
  renderPlaybackState();
}

async function handleShellMenuCommand(command) {
  const selected = selectedMetadata();
  try {
    switch (command) {
      case "saveDraft":
        await saveSelectedMetadata();
        setAlert("Draft saved.");
        break;
      case "exportSetPackage":
        await exportSetPackage();
        break;
      case "importSetPackage":
        await importSetPackage();
        break;
      case "confirmSet":
        await confirmSet();
        break;
      case "undo":
        undoLastCueMove();
        break;
      case "splitAtPlayhead":
        splitSelectedRegionAtPlayhead();
        break;
      case "deleteSelection":
        if (state.selectedCueIndex !== null) deleteSelectedCue();
        else if (state.selectedRegionIndex !== null) deleteSelectedRegion();
        break;
      case "removeCloseGap":
        removeSelectedRegionAndCloseGap();
        break;
      case "reloadData":
        await reloadAppData();
        break;
      case "toggleMixer":
        toggleMixerCollapse();
        break;
      case "resetMixerHeight":
        resetMixerHeightForCurrentMode();
        break;
      case "zoomIn":
        setTimelineZoom(state.timelineZoom + timelineZoomStep(1));
        break;
      case "zoomOut":
        setTimelineZoom(state.timelineZoom - timelineZoomStep(-1));
        break;
      case "refreshLibrary":
        await refreshLibrary();
        break;
      case "openLibrarySettings":
        openSettingsDrawer();
        showSettingsSection("librarySettings");
        break;
      case "openAudioSettings":
        openSettingsDrawer();
        showSettingsSection("audioSettings");
        break;
      case "refreshAudioDevices":
        await refreshAudioDevices();
        break;
      case "openDanteMatrix":
        openSettingsDrawer();
        showSettingsSection("routingSettings");
        break;
      case "play":
      case "pause":
      case "stop":
      case "seek":
      case "songTransition":
      case "togglePad":
      case "panic":
        await sendPlaybackCommand(command, selected?.slot ? { slot: selected.slot } : {});
        break;
      case "testProPresenterMidi":
        openSettingsDrawer();
        showSettingsSection("playbackSettings");
        await testProPresenterMidiSlide();
        break;
      default:
        break;
    }
  } catch (error) {
    setAlert(error.message);
  }
}

async function exportSetPackage() {
  if (!window.playbackShell?.saveSetPackage) {
    throw new Error("Set package export is only available in the Windows app.");
  }
  if (state.playbackState?.mode !== "performance") {
    await saveSelectedMetadata();
    await saveCurrentSetlist();
  }
  setAlert("Preparing set package...");
  const packagePayload = await api("/api/set-package/export");
  const result = await window.playbackShell.saveSetPackage(packagePayload);
  if (result?.canceled) {
    setAlert("Set package export canceled.");
    return;
  }
  setAlert(`Set package exported: ${result.filePath}`);
}

async function importSetPackage() {
  if (!window.playbackShell?.openSetPackage) {
    throw new Error("Set package import is only available in the Windows app.");
  }
  if (!window.confirm("Import this set package as the current draft set on this PC?")) return;
  const opened = await window.playbackShell.openSetPackage();
  if (opened?.canceled) {
    setAlert("Set package import canceled.");
    return;
  }
  setAlert("Importing set package and preparing local cache...");
  const result = await api("/api/set-package/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: opened.package })
  });
  await reloadAppData();
  setAlert(result.message || "Set package imported. Confirm Set on this PC before Performance.");
}

async function confirmSet() {
  try {
    els.playbackStatus.textContent = "Confirming set and preparing snapshot...";
    const result = await api("/api/playback/confirm-set", { method: "POST" });
    state.playbackState = result.state;
    await loadCurrentSetlist();
    await loadSetMetadata();
    await loadPlaybackState();
    await loadCacheReport();
    await loadEngineManifestPreview();
    closeSettingsDrawer();
  } catch (error) {
    els.playbackStatus.textContent = error.message;
    setAlert(error.message);
  }
}

async function togglePlaybackMode() {
  const nextMode = state.playbackState?.mode === "performance" ? "edit" : "performance";
  if (nextMode === "performance" && !window.confirm("Enter Performance mode and lock the current set?")) {
    return;
  }
  try {
    els.modeToggle.disabled = true;
    if (nextMode === "performance") {
      els.playbackStatus.textContent = "Saving editor data and confirming set...";
      await masterSaveBeforePerformance();
    }
    state.playbackState = await api("/api/playback/mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode })
    });
    if (nextMode === "edit") {
      await loadCurrentSetlist();
      await loadSetMetadata();
      await loadCacheReport();
      await loadEngineManifestPreview();
    }
    renderPlaybackState();
  } catch (error) {
    els.playbackStatus.textContent = error.message;
    setAlert(error.message);
  } finally {
    els.modeToggle.disabled = false;
  }
}

async function masterSaveBeforePerformance() {
  clearTimeout(state.saveTimer);
  clearTimeout(state.metadataSaveTimer);
  if (state.playbackState?.mode !== "performance") {
    await saveCurrentSetlist();
    await saveSelectedMetadata();
  }
  const result = await api("/api/playback/confirm-set", { method: "POST" });
  state.playbackState = result.state;
  await loadCacheReport();
  await loadEngineManifestPreview();
}

function renderPlaybackState() {
  const playback = state.playbackState || {};
  const repeat = playback.liveRepeat || {};
  const repeatStateKey = `${playback.currentSlot || ""}:${repeat.mode || ""}:${repeat.regionId || ""}:${repeat.releaseRequested ? "release" : ""}:${repeat.releaseAfterNextPass ? "defer" : ""}`;
  if (state.liveRepeatStateKey !== repeatStateKey) {
    state.liveRepeatStateKey = repeatStateKey;
  }
  const isPerformance = playback.mode === "performance";
  if (isPerformance && state.editorLoopTest) {
    state.editorLoopTest = null;
    state.editorLoopActionInFlight = false;
  }
  if (["stopped", "panic"].includes(playback.transport) && state.editorLoopTest) {
    state.editorLoopTest = null;
    state.editorLoopActionInFlight = false;
  }
  const readiness = playback.readiness || {};
  const engineState = readiness.engine?.state || "offline";
  const heartbeatRequired = readiness.engine?.heartbeatRequired === true;
  const displayEngineState = engineState === "ready" && heartbeatRequired && readiness.engine?.heartbeatFresh === false ? "heartbeat-stale" : engineState;
  const currentSong = playback.currentSlot ? state.setlist[playback.currentSlot - 1] : null;
  const visualSlot = playbackVisualSlot(playback);
  if (visualSlot && state.setlist[visualSlot - 1]) {
    state.selectedSetlistIndex = visualSlot - 1;
    state.selectedMetadataSlot = visualSlot;
  }
  els.appModeStatus.textContent = isPerformance ? "Performance mode" : "Edit mode";
  els.playbackModeTitle.textContent = isPerformance ? "Performance Mode" : "Edit Mode";
  const playbackStatusMessage = playback.lastMessage || readiness.performanceBlockers?.join(" ") || (playback.confirmed ? "Set confirmed." : "Confirm the set before Performance.");
  els.playbackStatus.textContent = /^Selected\s/i.test(playbackStatusMessage) ? "" : playbackStatusMessage;
  els.engineStatus.textContent = engineStatusLabel(displayEngineState);
  els.engineStatus.className = `engine-status ${displayEngineState}`;
  if (els.audioReadiness) els.audioReadiness.textContent = readiness.audioDevice?.state === "missing"
    ? "Audio device missing"
    : readiness.audioDevice?.selectedDeviceName
      ? `${engineStatusLabel(displayEngineState)}: ${readiness.audioDevice.selectedDeviceName}`
      : engineStatusLabel(displayEngineState);
  document.body.classList.toggle("engine-crashed", engineState === "crashed" && isPerformance);
  document.body.classList.toggle("engine-stale", displayEngineState === "heartbeat-stale" && isPerformance);
  document.body.classList.toggle("performance-mode", isPerformance);
  applyMixerPanelHeight();
  els.transportState.textContent = playback.panic?.active ? "Panic" : titleCase(playback.transport || "stopped");
  els.transportSong.textContent = currentSong?.title || selectedMetadata()?.title || "No song selected";
  els.modeToggle.textContent = isPerformance ? "Edit Mode" : "Performance Mode";
  els.confirmSet.disabled = isPerformance;
  if (els.quickConfirmSet) {
    els.quickConfirmSet.disabled = isPerformance;
    els.quickConfirmSet.classList.toggle("hidden", isPerformance);
  }
  const panicActive = playback.panic?.active === true;
  els.panicCommand.classList.remove("hidden");
  els.exitPanic?.classList.toggle("hidden", !panicActive);
  els.panicRecoveryPanel?.classList.toggle("hidden", !panicActive);
  if (els.panicRecoveryStatus) {
    const backendRecovery = playback.panic?.recoveryTarget?.pending ? playback.panic.recoveryTarget : null;
    els.panicRecoveryStatus.textContent = backendRecovery
      ? backendRecovery.message || "Panic release queued at next region"
      : (playback.panic?.detail || "Tracks Down / Click Alive / Scheduled Cues Suppressed");
  }
  renderCommandButtons(playback.transport);
  syncTransportClock();
  setPlanningLocked(isPerformance);
  if (!isUserEditingUi()) {
    renderSetlist();
    renderFoundationPanels();
    renderLoadedSong();
    renderSelectedMetadata();
  }
  renderEditorTransport(selectedMetadata());
}

function playbackVisualSlot(playback = state.playbackState || {}) {
  const slot = Number(playback?.currentSlot || 0);
  if (!slot || !state.setlist[slot - 1]) return 0;
  if (playback.mode === "performance") return slot;
  if (["playing", "paused", "panic"].includes(playback.transport)) return slot;
  if (state.selectedSetlistIndex !== null && state.selectedSetlistIndex !== undefined) return 0;
  if (playback.pad?.active || playback.transition?.active || playback.transition?.pending) return slot;
  return slot;
}

function renderCommandButtons(transport) {
  for (const button of els.commandButtons) {
    const command = button.dataset.command;
    const active = (state.playbackState?.panic?.active && command === "panic")
      || (state.playbackState?.pad?.active && command === "togglePad")
      || (transport === "playing" && command === "play")
      || (transport === "paused" && command === "pause")
      || (transport === "stopped" && command === "stop")
      || (transport === "panic" && command === "panic");
    button.classList.toggle("active-command", active);
    button.disabled = state.playbackCommandPending || shouldDisablePlaybackCommand(command);
  }
}

function syncTransportClock() {
  if (state.transportFrame) {
    window.cancelAnimationFrame(state.transportFrame);
    state.transportFrame = null;
  }
  if (state.playbackState?.transport === "playing") {
    const tick = () => {
      renderLiveTransportPosition();
      state.transportFrame = window.requestAnimationFrame(tick);
    };
    state.transportFrame = window.requestAnimationFrame(tick);
  } else {
    renderLiveTransportPosition();
  }
}

function renderLiveTransportPosition() {
  const slot = selectedMetadata();
  const playbackSlot = currentPlaybackMetadata();
  if (slot) {
    renderScrubPlayhead(slot);
    updateWaveformReadout(slot);
    refreshTimelineForLiveRegionChange(slot);
    serviceEditorRegionLoop(slot);
    renderEditorTransport(slot);
  }
  if (playbackSlot) {
    serviceArrangementBlocks(playbackSlot);
    serviceArrangementCuts(playbackSlot);
    serviceProPresenterMidiCues(playbackSlot);
  }
}

function refreshTimelineForLiveRegionChange(slot) {
  if (state.playbackState?.mode !== "performance") return;
  const currentId = currentTimelineRegion(slot)?.region?.id || "";
  if (currentId === state.renderedLiveRegionId) return;
  state.renderedLiveRegionId = currentId;
  renderTimeline(slot);
}

function engineStatusLabel(value) {
  const labels = {
    offline: "JUCE offline",
    starting: "JUCE starting",
    ready: "JUCE ready",
    "device-missing": "Device missing",
    "heartbeat-stale": "Heartbeat stale",
    crashed: "JUCE crashed"
  };
  return labels[value] || "JUCE offline";
}

function setPlanningLocked(locked) {
  const controls = [els.clearSetlist, els.addSelectedSong];
  for (const control of controls) {
    control.disabled = locked;
  }
  els.search.disabled = false;
  els.select.disabled = false;
  for (const tab of els.tabs) {
    tab.disabled = false;
  }
  els.refresh.disabled = false;
  els.setlistSlots.classList.toggle("locked", locked);
  els.saveMetadata.disabled = locked || !selectedMetadata();
  if (els.approveMetadata) els.approveMetadata.disabled = locked || !selectedMetadata();
  els.addRegion.disabled = locked || !selectedMetadata();
  els.addCue.disabled = locked || !selectedMetadata();
  updateCueUndoControl();
  renderEditorTransport(selectedMetadata());
}

async function sendPlaybackCommand(command, extra = {}) {
  const action = operatorPlaybackCommand(command, extra);
  const explicitEditStart = command === "play"
    && state.playbackState?.mode === "edit"
    && Number.isFinite(Number(extra.startSeconds));
  if (!extra.systemAction && !explicitEditStart && state.playbackState?.transport === "playing" && isPlaybackInterruptCommand(action)) {
    return;
  }
  if (state.playbackCommandPending && Date.now() - Number(state.playbackCommandPendingSince || 0) < 2000) return;
  if (state.playbackCommandPending) {
    state.playbackCommandPending = false;
  }
  state.playbackCommandPending = true;
  state.playbackCommandPendingSince = Date.now();
  setTransportControlsDisabled(true);
  try {
    const commandPayload = playbackCommandPayload(action, command === action ? extra : { ...extra, fromSlot: transitionCommandFromSlot(extra) });
    const result = await api("/api/playback/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandPayload)
    });
    state.playbackState = result.state;
    if (result.state?.currentSlot) {
      state.selectedMetadataSlot = result.state.currentSlot;
      state.selectedSetlistIndex = result.state.currentSlot - 1;
    }
    if (!result.accepted) setAlert(result.reason || "Command rejected.");
    renderPlaybackState();
  } catch (error) {
    setAlert(error.message);
  } finally {
    state.playbackCommandPending = false;
    state.playbackCommandPendingSince = 0;
    setTransportControlsDisabled(false);
  }
}

function setTransportControlsDisabled(disabled) {
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.disabled = disabled || shouldDisablePlaybackCommand(button.dataset.command);
  });
}

function shouldDisablePlaybackCommand(command) {
  if (command === "panic") {
    return state.playbackState?.panic?.active !== true && state.playbackState?.transport !== "playing";
  }
  return state.playbackState?.transport === "playing" && isPlaybackInterruptCommand(operatorPlaybackCommand(command));
}

function isPlaybackInterruptCommand(command) {
  return ["play", "restart", "nextSong", "previousSong", "fadeOut", "seek"].includes(command);
}

function operatorPlaybackCommand(command, extra = {}) {
  if (command !== "nextSong") return command;
  return transitionForOperatorNext(extra) ? "songTransition" : command;
}

function transitionCommandFromSlot(extra = {}) {
  return positiveClientNumber(extra.fromSlot)
    || positiveClientNumber(extra.slot)
    || positiveClientNumber(state.playbackState?.currentSlot)
    || positiveClientNumber(state.selectedMetadataSlot)
    || positiveClientNumber(state.selectedSetlistIndex === null ? null : state.selectedSetlistIndex + 1);
}

function transitionForOperatorNext(extra = {}) {
  const fromSlot = transitionCommandFromSlot(extra);
  return fromSlot ? transitionAfterSlot(fromSlot) : null;
}

function positiveClientNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function playbackCommandPayload(command, extra = {}) {
  const payload = { command, slot: state.selectedMetadataSlot, ...extra };
  if (command === "songTransition" && payload.fromSlot === undefined) {
    payload.fromSlot = transitionCommandFromSlot(extra);
  }
  if (command === "seek" && payload.seconds === undefined) {
    payload.seconds = 0;
    payload.slot = state.playbackState?.currentSlot || state.selectedMetadataSlot;
  }
  if (command !== "play" || payload.startSeconds !== undefined) {
    return payload;
  }
  const selected = selectedMetadata();
  const point = currentScrubPoint(selected);
  if (!selected || !point) return payload;
  payload.slot = selected.slot;
  payload.startSeconds = Number(point.timeSeconds || 0);
  if (arrangementCacheReady(selected)) return payload;
  const mapped = rawTimeForArrangedTime(selected, payload.startSeconds);
  if (mapped) {
    payload.startSeconds = mapped.rawSeconds;
    state.arrangementPlayback = {
      slot: selected.slot,
      blockId: mapped.blockId,
      index: mapped.index
    };
  } else {
    state.arrangementPlayback = null;
  }
  return payload;
}

function showOperatorPanel(panelId) {
  els.operatorTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.operatorPanel === panelId));
  els.operatorPanels.forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
}

function openSettingsDrawer() {
  document.querySelector("#settingsView").classList.add("active");
}

function closeSettingsDrawer() {
  document.querySelector("#settingsView").classList.remove("active");
}

function showSettingsSection(sectionId) {
  els.settingsTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.settingsTab === sectionId));
  els.settingsSections.forEach((section) => section.classList.toggle("active", section.id === sectionId));
}

async function loadSetMetadata() {
  state.setMetadata = await api("/api/set-metadata/current");
  const slots = state.setMetadata.slots || [];
  if (state.selectedSetlistIndex !== null) {
    const tileSlot = state.selectedSetlistIndex + 1;
    const tileHasMetadata = slots.some((slot) => slot.slot === tileSlot);
    if (!tileHasMetadata || !state.setlist[state.selectedSetlistIndex]) {
      state.selectedSetlistIndex = null;
    }
  }
  if (!slots.some((slot) => slot.slot === state.selectedMetadataSlot)) {
    state.selectedMetadataSlot = slots[0]?.slot || null;
  }
  if (state.selectedSetlistIndex === null && state.selectedMetadataSlot !== null) {
    const selectedIndex = state.selectedMetadataSlot - 1;
    if (state.setlist[selectedIndex]) {
      state.selectedSetlistIndex = selectedIndex;
    }
  }
  renderMetadataSlotOptions();
  renderSelectedMetadata();
  ensureSelectedWaveform();
  ensureSetlistWaveforms();
}

function renderMetadataSlotOptions() {
  els.metadataSlot.replaceChildren();
  for (const slot of state.setMetadata?.slots || []) {
    const option = document.createElement("option");
    option.value = String(slot.slot);
    option.textContent = `${slot.slot}. ${slot.title}`;
    option.selected = slot.slot === state.selectedMetadataSlot;
    els.metadataSlot.append(option);
  }
}

function selectedMetadata() {
  const slots = state.setMetadata?.slots || [];
  const playbackSlot = playbackVisualSlot();
  if (playbackSlot && state.setlist[playbackSlot - 1]) {
    const selected = slots.find((slot) => slot.slot === playbackSlot);
    if (selected) return selected;
  }
  const tileSlot = state.selectedSetlistIndex === null ? null : state.selectedSetlistIndex + 1;
  if (tileSlot && state.setlist[state.selectedSetlistIndex]) {
    const selected = slots.find((slot) => slot.slot === tileSlot);
    if (selected) return selected;
  }
  return slots.find((slot) => slot.slot === state.selectedMetadataSlot) || slots[0] || null;
}

function renderSelectedMetadata() {
  if (!els.metadataSlot) return;
  const selected = selectedMetadata();
  const locked = state.playbackState?.mode === "performance";
  if (selected) {
    if (Number(state.timelineZoomSlot) !== Number(selected.slot)) {
      state.timelineZoom = 1;
      state.timelineZoomSlot = selected.slot;
      if (els.timelineSurface) els.timelineSurface.scrollLeft = 0;
    }
    state.selectedMetadataSlot = selected.slot;
    els.metadataSlot.value = String(selected.slot);
  }
  els.metadataSlot.disabled = !state.setMetadata?.slots?.length;
  els.saveMetadata.disabled = locked || !selected;
  if (els.setAudioAlignSource) els.setAudioAlignSource.disabled = locked || !selected;
  if (els.setAudioAlignTarget) els.setAudioAlignTarget.disabled = locked || !selected;
  if (els.alignAudioStart) els.alignAudioStart.disabled = locked || !selected;
  if (els.resetAudioAlignment) els.resetAudioAlignment.disabled = locked || !selected;
  els.addRegion.disabled = locked || !selected;
  if (els.removeRegion) els.removeRegion.disabled = locked || !selected || !removableRegionRange(selected);
  if (els.reorderRegions) els.reorderRegions.disabled = locked || !selected || (selected.regions?.regions || []).length < 2;
  if (els.reorderCues) els.reorderCues.disabled = locked || !selected || (selected.cues?.cueMarkers || []).length < 2;
  syncArrangementControls(selected, locked);
  if (els.undoArrangement) els.undoArrangement.disabled = locked || !selected || !state.arrangementUndoStack.length;
  if (els.trimSongStart) els.trimSongStart.disabled = locked || !selected;
  if (els.trimSongEnd) els.trimSongEnd.disabled = locked || !selected;
  if (els.saveArrangement) els.saveArrangement.disabled = locked || !selected;
  if (els.clearArrangement) els.clearArrangement.disabled = locked || !selected || !arrangementHasCuts(selected);
  els.addCue.disabled = locked || !selected;
  els.createRegionFromSelection.disabled = locked || !selected || !regionSketchForSlot(selected);
  updateCueUndoControl();
  updateArrangementUndoControl();
  renderEditorTransport(selected);

  if (!selected) {
    state.regionSketch = null;
    state.selectedRegionIndex = null;
    state.selectedCueIndex = null;
    els.timelinePanel.classList.add("hidden");
    els.editorPanel.classList.add("hidden");
    els.timelineStatus.textContent = "No setlist song selected.";
    renderTransportReadout();
    els.playbackKey.textContent = "--";
    els.playbackTempo.textContent = "--";
    els.playbackTime.textContent = "--";
    renderPlaybackKeyEditor(null);
    els.regionLane.replaceChildren();
    els.cueLane.replaceChildren();
    els.sectionLane.replaceChildren();
    els.timelineGrid.replaceChildren();
    els.timelineRuler?.replaceChildren();
    els.fakeWaveform.replaceChildren();
    renderRegionSketchSelection(null);
    updateWaveformReadout();
    els.regionEditorList.replaceChildren();
    els.cueEditorList.replaceChildren();
    syncSelectedNameEditors(null, true);
    renderMixerStrip(null);
    renderFoundationPanels();
    hideRegionMenu();
    renderEditorTransport(null);
    return;
  }

  els.timelinePanel.classList.remove("hidden");
  els.editorPanel.classList.toggle("hidden", locked);
  const tempo = selected.tempoMap || {};
  els.timelineStatus.textContent = playbackBoundsStatusText(selected);
  renderTransportReadout(selected);
  els.playbackKey.textContent = tempo.key || "--";
  els.playbackTempo.textContent = tempo.bpm || "--";
  els.playbackTime.textContent = tempo.timeSignature || "--";
  els.tempoKey.value = tempo.key || "";
  els.tempoBpm.value = tempo.bpm || "";
  els.tempoTimeSignature.value = tempo.timeSignature || "";
  renderPlaybackKeyEditor(selected);
  if (els.audioAlignmentStatus) {
    renderAudioAlignmentStatus(selected);
  }
  els.cueLane.classList.remove("hidden");
  renderTimeline(selected);
  renderMetadataEditors(selected, locked);
  renderMixerStrip(selected);
  renderFoundationPanels();
  ensureSelectedWaveform(selected);
}

function slotHasWaveformPeaks(slot) {
  return waveformSummaryUsable(slot?.arrangementCache?.waveform) || waveformSummaryUsable(slot?.waveform);
}

function waveformSummaryUsable(waveform) {
  return Boolean(
    Array.isArray(waveform?.peaks)
    && waveform.peaks.length
    && Number(waveform.tracksUsed || 0) > 0
    && waveform.peaks.some((peak) => Number(peak) > 0.005)
  );
}

async function ensureSelectedWaveform(selected = selectedMetadata()) {
  if (!selected || slotHasWaveformPeaks(selected)) return;
  const slotNumber = Number(selected.slot || 0);
  await ensureSlotWaveform(slotNumber);
}

function playbackBoundsStatusText(slot) {
  const arrangement = slot?.arrangement || {};
  const start = Number(arrangement.trimStartSeconds || 0);
  const end = Number(arrangement.trimEndSeconds || 0);
  const audioEnd = slotWaveformDuration(slot);
  const tailMeasures = 8;
  if (start > 0 || end > 0) {
    return `Playback trim ${formatSeconds(start)} -> ${formatSeconds(end || audioEnd)} | ruler +${tailMeasures} measures`;
  }
  return `Timeline ready | ruler +${tailMeasures} measures`;
}

function renderTransportReadout(fallbackSelected = null) {
  const playback = state.playbackState || {};
  const currentSong = playback.currentSlot ? state.setlist[playback.currentSlot - 1] : null;
  els.transportState.textContent = titleCase(playback.transport || "stopped");
  els.transportSong.textContent = currentSong?.title || fallbackSelected?.title || "No song selected";
}

function renderTimeline(slot) {
  els.timelineGrid.replaceChildren();
  els.timelineRuler?.replaceChildren();
  els.regionLane.replaceChildren();
  els.cueLane.replaceChildren();
  els.sectionLane.replaceChildren();
  els.fakeWaveform.replaceChildren();
  const regions = slot.regions?.regions || [];
  const regionEntries = arrangedRegionEntries(slot);
  const cues = arrangedCueEntries(slot).map((entry) => entry.cue);
  const beatGrid = visualBeatGrid(slot);
  const maxBeatGridBar = beatGrid.reduce((max, beat) => Math.max(max, Number(beat.measure || 0)), 0);
  const maxBar = Math.max(16, maxBeatGridBar, ...regionEntries.map((entry) => Number(entry.region.endBar || 1)), ...cues.map((cue) => Number(cue.bar || 1)));
  const duration = slotTimelineDuration(slot);
  const locked = state.playbackState?.mode === "performance";
  const liveRegion = locked ? currentTimelineRegion(slot) : null;
  const nextLiveRegion = locked ? nextTimelineRegion(slot, liveRegion) : null;
  const performanceControlRegion = locked ? performanceActionRegion(slot, liveRegion) : null;
  const liveRepeat = state.playbackState?.liveRepeat || {};
  els.timelinePanel.style.setProperty("--timeline-zoom", state.timelineZoom);
  els.timelineSurface.classList.toggle("timeline-zoomed", state.timelineZoom > 1);
  if (state.timelineZoom <= 1) els.timelineSurface.scrollLeft = 0;
  els.zoomReadout.textContent = `${Math.round(state.timelineZoom * 100)}%`;
  renderTimelineRuler(beatGrid, duration);
  renderTimelineGrid(beatGrid, duration);
  renderWaveformBed(slot, maxBar);
  renderSectionLane(slot, duration, cues);
  renderScrubPlayhead(slot);
  renderRegionSketchSelection(slot);
  updateWaveformReadout(slot);
  regionEntries.forEach((entry) => {
    const { region } = entry;
    const index = entry.sourceIndex;
    const item = document.createElement("div");
    item.className = "timeline-region";
    const isCurrentLiveRegion = Boolean(locked && liveRegion?.region?.id === region.id);
    const isNextLiveRegion = Boolean(locked && nextLiveRegion?.region?.id === region.id);
    const panicActive = state.playbackState?.panic?.active === true;
    const showPerformanceActions = Boolean(locked && (panicActive || performanceControlRegion?.region?.id === region.id));
    const isQueuedRepeat = Boolean(liveRepeat.regionId === region.id && liveRepeat.queued && !liveRepeat.releaseRequested);
    item.classList.toggle("current-live-region", isCurrentLiveRegion);
    item.classList.toggle("next-live-region", isNextLiveRegion);
    item.classList.toggle("performance-action-region", showPerformanceActions);
    item.classList.toggle("repeat-queued", isQueuedRepeat);
    item.classList.toggle("selected-region", selectedArrangedEntryMatches(index, entry.blockId));
    item.dataset.regionIndex = String(index);
    const start = Number(region.startBar || 1);
    const end = Math.max(start + 0.25, Number(region.endBar || start + 1));
    const arrangedRange = {
      slot: slot.slot,
      index,
      blockId: entry.blockId || "",
      startBar: start,
      startBeat: Number(region.startBeat || 1),
      endBar: end,
      endBeat: Number(region.endBeat || 1),
      rawStartBar: Number(entry.rawRegion?.startBar || slot.regions?.regions?.[index]?.startBar || start),
      rawStartBeat: Number(entry.rawRegion?.startBeat || slot.regions?.regions?.[index]?.startBeat || region.startBeat || 1),
      rawEndBar: Number(entry.rawRegion?.endBar || slot.regions?.regions?.[index]?.endBar || end),
      rawEndBeat: Number(entry.rawRegion?.endBeat || slot.regions?.regions?.[index]?.endBeat || region.endBeat || 1),
      rawStartSeconds: Number(entry.block?.rawStartSeconds || 0),
      rawEndSeconds: Number(entry.block?.rawEndSeconds || 0)
    };
    const startTime = timeForBarBeat(slot, start, Number(region.startBeat || 1));
    const endTime = timeForBarBeat(slot, end, Number(region.endBeat || 1));
    const left = percentForTime(startTime, duration);
    const right = percentForTime(Math.max(startTime + 0.1, endTime), duration);
    item.style.left = `${left}%`;
    item.style.width = `${Math.max(0, Math.min(100 - left, Math.max(1, right - left)))}%`;
    const performanceBadge = locked && isCurrentLiveRegion
      ? "<em class=\"performance-region-badge\">Current</em>"
      : locked && isNextLiveRegion
        ? "<em class=\"performance-region-badge next\">Next</em>"
        : "";
    item.innerHTML = `
      ${locked ? "" : "<span class=\"region-resize region-resize-left\" data-resize=\"start\"></span>"}
      <strong>${escapeHtml(region.name)}</strong>${performanceBadge}
      ${showPerformanceActions ? regionLiveActions(region, liveRepeat, panicActive) : ""}
      ${locked ? "" : "<span class=\"region-resize region-resize-right\" data-resize=\"end\"></span>"}
    `;
    item.querySelectorAll("[data-region-command]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        state.selectedRegionIndex = index;
        const command = button.dataset.regionCommand;
        if (command === "recoverPanicRegion" || (command === "jumpRegion" && state.playbackState?.panic?.active === true)) {
          sendPlaybackCommand("jumpRegion", { slot: slot.slot, regionId: region.id, regionName: region.name });
          return;
        }
        const timing = liveRegionActionTiming(slot, region);
        if (command === "goOnRegion") {
          sendPlaybackCommand(command, { slot: slot.slot, regionId: region.id, regionName: region.name, deferRelease: !timing.safe });
          return;
        }
        if (!timing.safe && state.playbackState?.transport === "playing") return;
        sendPlaybackCommand(command, { slot: slot.slot, regionId: region.id, regionName: region.name });
      });
    });
    if (!locked) {
      item.addEventListener("click", (event) => {
        if (event.target.closest(".region-resize")) return;
        event.stopPropagation();
        selectRegionEditorIndex(index, { selected: slot, arrangedRange });
      });
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openRegionMenu(index, item, { focusName: false, event, arrangedRange });
      });
      item.addEventListener("pointerdown", (event) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openRegionMenu(index, item, { focusName: false, event, arrangedRange });
      });
      item.addEventListener("pointerdown", (event) => beginRegionPointerEdit(event, index, maxBar, slot, arrangedRange));
    }
    els.regionLane.append(item);
  });
  arrangedCueEntries(slot).forEach((entry) => {
    const { cue } = entry;
    const index = entry.sourceIndex;
    const item = document.createElement("div");
    item.className = "timeline-cue";
    item.classList.toggle("selected-cue", state.selectedCueIndex === index);
    item.dataset.cueIndex = String(index);
    item.style.left = `${percentForTime(timeForBarBeat(slot, Number(cue.bar || 1), Number(cue.beat || 1)), duration)}%`;
    item.innerHTML = `<span>${escapeHtml(cue.name)}</span>`;
    item.title = `${cue.name} | bar ${cue.bar || 1}, beat ${cue.beat || 1}`;
    if (!locked) {
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectCueMarker(index, slot, { seekPlayback: event.detail > 1 });
      });
      item.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectCueMarker(index, slot, { seekPlayback: true });
      });
      item.addEventListener("pointerdown", (event) => beginCuePointerEdit(event, index, slot));
    }
    els.cueLane.append(item);
  });
}

function selectedArrangedEntryMatches(index, blockId = "") {
  if (state.selectedRegionIndex !== index) return false;
  const selectedBlockId = state.selectedArrangedRegionRange?.blockId || "";
  return !selectedBlockId || !blockId || selectedBlockId === blockId;
}

function regionLiveActions(region, liveRepeat, panicActive = false) {
  if (panicActive) {
    return "<div class=\"region-live-actions\"><button data-region-command=\"recoverPanicRegion\" type=\"button\">Recover</button></div>";
  }
  if (liveRepeat.mode === "loop" && liveRepeat.regionId === region.id) {
    return "<div class=\"region-live-actions\"><button data-region-command=\"goOnRegion\" type=\"button\">Go On</button></div>";
  }
  return "<div class=\"region-live-actions\"><button data-region-command=\"jumpRegion\" type=\"button\">Jump</button><button data-region-command=\"skipRegion\" type=\"button\">Skip</button><button data-region-command=\"repeatRegion\" type=\"button\">Repeat 1</button><button data-region-command=\"loopRegion\" type=\"button\">Loop</button></div>";
}

function currentTimelineRegion(slot) {
  const point = currentScrubPoint(slot);
  const entries = timelineRegionEntries(slot);
  if (!point || !entries.length || state.playbackState?.currentSlot !== slot.slot || !["playing", "paused"].includes(state.playbackState?.transport)) {
    return null;
  }
  return entries.find((item) => point.timeSeconds >= item.startTime && point.timeSeconds < Math.max(item.startTime + 0.1, item.endTime)) || null;
}

function nextTimelineRegion(slot, current) {
  const entries = timelineRegionEntries(slot);
  if (!entries.length) return null;
  if (!current) return entries[0] || null;
  const index = entries.findIndex((entry) => entry.region.id === current.region.id);
  return index >= 0 ? entries[index + 1] || null : null;
}

function timelineRegionEntries(slot) {
  return (slot?.regions?.regions || [])
    .map((region, index) => ({
      region,
      index,
      startTime: timeForBarBeat(slot, Number(region.startBar || 1), Number(region.startBeat || 1)),
      endTime: timeForBarBeat(slot, Number(region.endBar || region.startBar || 1), Number(region.endBeat || 1))
    }))
    .sort((left, right) => left.startTime - right.startTime);
}

function performanceActionRegion(slot, liveRegion) {
  if (liveRegion) return liveRegion;
  const entries = arrangedRegionEntries(slot);
  if (!entries.length) return null;
  const selected = entries.find((entry) => entry.sourceIndex === state.selectedRegionIndex);
  if (selected) return selected;
  return entries[0];
}

function liveRegionActionTiming(slot, region) {
  if (!slot || !region) return { safe: false };
  const startTime = timeForBarBeat(slot, Number(region.startBar || 1), Number(region.startBeat || 1));
  const endTime = timeForBarBeat(slot, Number(region.endBar || region.startBar || 1), Number(region.endBeat || 1));
  const deadline = liveActionDeadlineSeconds(slot, endTime);
  const current = currentTransportSeconds();
  return {
    safe: deadline > startTime && current < deadline,
    deadline,
    current,
    startTime,
    endTime
  };
}

function liveActionDeadlineSeconds(slot, regionEndSeconds) {
  const beatGrid = visualBeatGrid(slot);
  if (!beatGrid.length) return Number(regionEndSeconds || 0);
  const safeBeats = liveActionSafeGridBeats(slot);
  const endIndex = beatGrid.findIndex((beat) => Number(beat.timeSeconds || 0) >= Number(regionEndSeconds || 0) - 0.0001);
  const targetIndex = (endIndex < 0 ? beatGrid.length : endIndex) - safeBeats;
  if (targetIndex < 0) return -1;
  return Number(beatGrid[targetIndex]?.timeSeconds || -1);
}

async function handlePanicCommandClick(button = null) {
  const now = Date.now();
  if (now - state.lastPanicButtonPressAt < 350) return;
  state.lastPanicButtonPressAt = now;
  if (state.playbackCommandPending) return;
  try {
    state.playbackState = await api("/api/playback/state");
    renderPlaybackState();
  } catch (error) {
    setAlert(error.message);
    return;
  }
  if (state.playbackState?.panic?.active === true) {
    sendPlaybackCommand("panic");
    return;
  }
  sendPlaybackCommand("panic");
}

function liveActionSafeGridBeats(slot) {
  return String(slot?.tempoMap?.timeSignature || "").trim().startsWith("6/8") ? 18 : 14;
}

function nextMeasureBoundarySeconds(slot, currentSeconds) {
  const beatGrid = visualBeatGrid(slot);
  const current = Number(currentSeconds || 0);
  const next = beatGrid.find((beat) => {
    const beatNumber = Number(beat.beat || beat.beatNumber || 1);
    const time = Number(beat.timeSeconds || 0);
    return beatNumber === 1 && time > current + 0.25;
  });
  return Number(next?.timeSeconds ?? current);
}

async function serviceArrangementBlocks(slot) {
  const playback = state.playbackState || {};
  if (state.arrangementSkipInFlight || playback.transport !== "playing" || playback.currentSlot !== slot?.slot) return;
  if (arrangementCacheReady(slot)) return;
  const blocks = arrangedBlocks(slot);
  if (!blocks.length) return;
  let cursor = state.arrangementPlayback?.slot === slot.slot ? Number(state.arrangementPlayback.index || 0) : 0;
  cursor = clamp(cursor, 0, blocks.length - 1);
  const current = currentTransportSeconds();
  const currentBlock = blocks[cursor];
  if (current < Number(currentBlock.rawEndSeconds || 0) - 0.04) return;

  state.arrangementSkipInFlight = true;
  try {
    const next = blocks[cursor + 1];
    if (!next) {
      state.arrangementPlayback = null;
      await sendPlaybackCommand("stop", { slot: slot.slot });
      return;
    }
    state.arrangementPlayback = {
      slot: slot.slot,
      blockId: next.id,
      index: cursor + 1
    };
    await sendPlaybackCommand("seek", { slot: slot.slot, seconds: Number(next.rawStartSeconds || 0), systemAction: true });
  } finally {
    window.setTimeout(() => {
      state.arrangementSkipInFlight = false;
    }, 220);
  }
}

async function serviceArrangementCuts(slot) {
  const playback = state.playbackState || {};
  if (state.arrangementSkipInFlight || playback.transport !== "playing" || playback.currentSlot !== slot?.slot) return;
  if (arrangedBlocks(slot).length) return;
  const cuts = arrangedCuts(slot);
  if (!cuts.length) return;
  const current = currentTransportSeconds();
  const cut = cuts.find((item) => {
    const start = Number(item.startSeconds || timeForBarBeat(slot, item.startBar, 1));
    const end = Number(item.endSeconds || timeForBarBeat(slot, item.endBar, 1));
    return end > start && current >= start - 0.015 && current < end - 0.04;
  });
  if (!cut) return;

  state.arrangementSkipInFlight = true;
  try {
    const endSeconds = Number(cut.endSeconds || timeForBarBeat(slot, cut.endBar, 1));
    await sendPlaybackCommand("seek", { slot: slot.slot, seconds: endSeconds, systemAction: true });
  } finally {
    window.setTimeout(() => {
      state.arrangementSkipInFlight = false;
    }, 220);
  }
}

function currentPlaybackMetadata() {
  const currentSlot = Number(state.playbackState?.currentSlot || 0);
  if (!currentSlot) return null;
  return (state.setMetadata?.slots || []).find((slot) => slot.slot === currentSlot) || null;
}

function renderEditorTransport(slot) {
  if (!els.editorTransport) return;
  const playback = state.playbackState || {};
  const isPerformance = playback.mode === "performance";
  const locked = isPerformance || !slot;
  const selectedEntry = selectedRegionEntry(slot);
  const activeTest = Boolean(state.editorLoopTest && slot && state.editorLoopTest.slot === slot.slot);
  const isCurrentSlot = playback.currentSlot === slot?.slot;
  const point = currentScrubPoint(slot);

  els.editorTransport.classList.toggle("hidden", isPerformance);
  els.editorTransport.classList.toggle("loop-testing", activeTest);
  for (const button of [els.editorPlay, els.editorRepeat, els.editorLoop, els.editorPause, els.editorStop]) {
    if (button) button.disabled = locked;
  }
  els.editorPlay?.classList.toggle("active-command", isCurrentSlot && playback.transport === "playing");
  els.editorRepeat?.classList.toggle("active-command", activeTest && state.editorLoopTest?.repeatMode === "once");
  els.editorLoop?.classList.toggle("active-command", activeTest);
  els.editorPause?.classList.toggle("active-command", isCurrentSlot && playback.transport === "paused");
  els.editorStop?.classList.toggle("active-command", isCurrentSlot && playback.transport === "stopped");

  if (els.editorPlay) {
    els.editorPlay.title = "Play from editor position";
  }
  if (els.editorLoop) {
    const sketch = regionSketchForSlot(slot);
    els.editorLoop.title = activeTest
      ? "Stop looping selected area"
      : sketch
      ? "Loop selected area"
      : "Select a yellow area to loop";
  }
  if (els.editorRepeat) {
    const sketch = regionSketchForSlot(slot);
    els.editorRepeat.title = sketch
      ? "Repeat yellow selection once"
      : selectedEntry
      ? `Repeat ${selectedEntry.region.name || "selected region"} once`
      : "Select a yellow area or blue region to repeat";
  }
  if (!els.editorTransportStatus) return;
  if (!slot) {
    els.editorTransportStatus.textContent = "Editor --";
  } else if (activeTest) {
    els.editorTransportStatus.textContent = `Looping ${state.editorLoopTest.regionName}`;
  } else if (selectedEntry) {
    els.editorTransportStatus.textContent = `Selected ${selectedEntry.region.name || "region"}`;
  } else {
    els.editorTransportStatus.textContent = point ? `Editor ${formatSeconds(point.timeSeconds)}` : "Editor --";
  }
}

function editorTransportLocked(slot) {
  return state.playbackState?.mode === "performance" || !slot;
}

async function alignAudioStartToPlayhead() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  const markers = audioAlignmentMarkers(slot);
  if (!markers.source || !markers.target) {
    setAlert("Set a source waveform point and a target grid point first.");
    return;
  }
  const currentShift = Number(slot.audioAlignment?.shiftSeconds || 0);
  const deltaSeconds = Number(markers.target.timeSeconds || 0) - Number(markers.source.timeSeconds || 0);
  const nextShift = currentShift + deltaSeconds;
  const direction = deltaSeconds > 0 ? "add space before the song" : deltaSeconds < 0 ? "remove space from the front" : "leave the song in place";
  const message = `Move source ${formatSeconds(markers.source.timeSeconds)} to target ${formatSeconds(markers.target.timeSeconds)}?\n\nThis will ${direction} by ${Math.abs(deltaSeconds).toFixed(3)}s.\nSaved song shift will be ${nextShift.toFixed(3)}s.\n\nThis rewrites the app cache, not Dropbox WAVs.`;
  if (!window.confirm(message)) return;
  await applyAudioAlignment(slot, nextShift);
}

function setAudioAlignmentSourceMarker() {
  setAudioAlignmentMarker("source");
}

function setAudioAlignmentTargetMarker() {
  setAudioAlignmentMarker("target");
}

function setAudioAlignmentMarker(kind) {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  const point = currentScrubPoint(slot);
  if (!point) return;
  const markers = audioAlignmentMarkers(slot);
  markers[kind] = {
    timeSeconds: Number(point.timeSeconds || 0),
    measure: Number(point.measure || 1),
    beat: Number(point.beat || 1)
  };
  renderAudioAlignmentStatus(slot);
  setAlert(`${kind === "source" ? "Source" : "Target"} marker set at ${formatSeconds(point.timeSeconds)} (${point.measure}.${point.beat}).`);
}

function audioAlignmentMarkers(slot) {
  if (!slot?.slot) return {};
  if (!state.audioAlignMarkersBySlot[slot.slot]) state.audioAlignMarkersBySlot[slot.slot] = {};
  return state.audioAlignMarkersBySlot[slot.slot];
}

function renderAudioAlignmentStatus(slot = selectedMetadata()) {
  if (!els.audioAlignmentStatus) return;
  if (!slot) {
    els.audioAlignmentStatus.textContent = "Shift: 0.000s | Source: -- | Target: --";
    return;
  }
  const markers = audioAlignmentMarkers(slot);
  const source = markers.source ? formatSeconds(markers.source.timeSeconds) : "--";
  const target = markers.target ? formatSeconds(markers.target.timeSeconds) : "--";
  const shift = Number(slot.audioAlignment?.shiftSeconds || 0);
  const pending = markers.source && markers.target
    ? ` | Move: ${(Number(markers.target.timeSeconds || 0) - Number(markers.source.timeSeconds || 0)).toFixed(3)}s`
    : "";
  els.audioAlignmentStatus.textContent = `Shift: ${shift.toFixed(3)}s | Source: ${source} | Target: ${target}${pending}`;
}

async function resetAudioAlignment() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  if (!window.confirm("Reset this song's saved audio shift and rebuild its app cache?")) return;
  await applyAudioAlignment(slot, 0);
}

async function applyAudioAlignment(slot, seconds) {
  try {
    setBusy("Rebuilding shifted audio cache...");
    const markerSeconds = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
    const result = await api(`/api/set-metadata/current/slot/${slot.slot}/audio-shift`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds: markerSeconds })
    });
    state.setlist = result.setlist.slots.map((item) => item.songId ? setlistSongFromSlot(item) : null);
    state.setlistTransitions = normalizeClientTransitions(result.setlist.transitions || state.setlistTransitions);
    state.setMetadata = result.metadata;
    const updated = (state.setMetadata?.slots || []).find((item) => item.slot === slot.slot);
    if (updated) {
      state.selectedMetadataSlot = updated.slot;
      state.selectedSetlistIndex = updated.slot - 1;
      delete state.audioAlignMarkersBySlot[updated.slot];
      state.waveformLoadInFlight.delete(updated.slot);
      const targetSeconds = Math.max(0, Number(slotWaveformDuration(updated) || 0) > 0 ? Math.min(Number(slotWaveformDuration(updated)), Math.abs(Number(result.shiftSeconds || 0))) : 0);
      state.scrubBySlot[updated.slot] = beatAtTime(visualBeatGrid(updated), targetSeconds) || {
        timeSeconds: targetSeconds,
        measure: 1,
        beat: 1,
        globalBeat: 0
      };
      state.movingTransportSlot = updated.slot;
    }
    await loadPlaybackState();
    await loadCacheReport();
    renderSetlist();
    renderSelectedMetadata();
    const savedShift = Number(result.shiftSeconds || 0);
    setAlert(savedShift === 0
      ? "Audio shift reset to original. Confirm Set before Performance."
      : `Audio shift saved: ${savedShift.toFixed(3)}s. Confirm Set before Performance.`);
  } catch (error) {
    setAlert(error.message);
  }
}

async function ensureSetlistWaveforms() {
  const slots = Array.isArray(state.setMetadata?.slots) ? state.setMetadata.slots : [];
  for (const slot of slots) {
    if (!slot?.slot || !slot.songId || slotHasWaveformPeaks(slot)) continue;
    ensureSlotWaveform(Number(slot.slot));
  }
}

async function ensureSlotWaveform(slotNumber) {
  if (!slotNumber || state.waveformLoadInFlight.has(slotNumber)) return;
  state.waveformLoadInFlight.add(slotNumber);
  try {
    const waveform = await api(`/api/set-metadata/current/slot/${slotNumber}/waveform?buckets=1800`);
    const slot = (state.setMetadata?.slots || []).find((item) => Number(item.slot) === slotNumber);
    if (slot) {
      slot.waveform = waveform;
      if (Number(selectedMetadata()?.slot) === slotNumber) {
        renderTimeline(slot);
      }
    }
  } catch (error) {
    console.warn("Waveform refresh failed", error);
  } finally {
    state.waveformLoadInFlight.delete(slotNumber);
  }
}

async function redrawInvalidSetWaveforms() {
  const slots = Array.isArray(state.setMetadata?.slots) ? state.setMetadata.slots : [];
  const targets = slots.filter((slot) => slot?.slot && slot.songId && !slotHasWaveformPeaks(slot));
  if (!targets.length) return;
  if (els.timelineStatus) els.timelineStatus.textContent = `Redrawing ${targets.length} waveform${targets.length === 1 ? "" : "s"}...`;
  await Promise.all(targets.map((slot) => ensureSlotWaveform(Number(slot.slot))));
}

async function playEditorFromTransport() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  clearEditorRegionLoopTest();
  renderEditorTransport(slot);
  const point = currentScrubPoint(slot);
  await sendPlaybackCommand("play", {
    slot: slot.slot,
    startSeconds: Number(point?.timeSeconds || 0)
  });
}

async function toggleEditorSelectionLoop() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  if (state.editorLoopTest?.slot === slot.slot) {
    clearEditorRegionLoopTest();
    renderEditorTransport(slot);
    return;
  }
  const sketch = regionSketchForSlot(slot);
  if (!sketch) {
    setAlert("Select a yellow area first, then press Loop.");
    return;
  }
  await startEditorSketchLoopTest(slot, sketch);
}

async function repeatEditorSelectionOnce() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  const sketch = regionSketchForSlot(slot);
  if (sketch) {
    await startEditorSketchRepeatOnce(slot, sketch);
    return;
  }
  const selectedEntry = selectedRegionEntry(slot);
  if (selectedEntry) {
    await startEditorRegionRepeatOnce(slot, selectedEntry);
    return;
  }
  setAlert("Select a yellow area or blue region first, then press Repeat.");
}

async function pauseEditorPlayback() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  await sendPlaybackCommand("pause", { slot: slot.slot });
}

async function stopEditorPlayback() {
  const slot = selectedMetadata();
  if (editorTransportLocked(slot)) return;
  clearEditorRegionLoopTest();
  renderEditorTransport(slot);
  await sendPlaybackCommand("stop", { slot: slot.slot });
}

async function startEditorRegionLoopTest(slot, entry) {
  const timing = regionTiming(slot, entry.region);
  if (!timing || timing.endSeconds <= timing.startSeconds + 0.1) {
    setAlert("Selected region is too short to loop-test.");
    return;
  }
  const playback = state.playbackState || {};
  const alreadyTesting = state.editorLoopTest?.slot === slot.slot && state.editorLoopTest.regionIndex === entry.index;
  state.editorLoopTest = {
    slot: slot.slot,
    regionId: entry.region.id,
    regionIndex: entry.index,
    regionName: entry.region.name || `Region ${entry.index + 1}`,
    repeatMode: "loop",
    startSeconds: timing.startSeconds,
    endSeconds: timing.endSeconds
  };
  state.editorLoopActionInFlight = false;
  renderEditorTransport(slot);
  if (alreadyTesting && playback.transport === "paused" && playback.currentSlot === slot.slot) {
    await sendPlaybackCommand("play", { slot: slot.slot, skipSketchLoop: true });
    return;
  }
  const startPoint = pointForBarBeat(slot, Number(entry.region.startBar || 1), Number(entry.region.startBeat || 1));
  setTimelineTransportPoint(slot, startPoint);
  await sendPlaybackCommand("play", { slot: slot.slot, startSeconds: timing.startSeconds, skipSketchLoop: true });
}

async function startEditorSketchLoopTest(slot, sketch) {
  await startEditorSketchRepeat(slot, sketch, "loop");
}

async function startEditorSketchRepeatOnce(slot, sketch) {
  await startEditorSketchRepeat(slot, sketch, "once");
}

async function startEditorRegionRepeatOnce(slot, entry) {
  await startEditorRegionRepeat(slot, entry, "once");
}

async function startEditorRegionRepeat(slot, entry, repeatMode) {
  const timing = regionTiming(slot, entry.region);
  if (!timing || timing.endSeconds <= timing.startSeconds + 0.1) {
    setAlert("Selected region is too short to repeat.");
    return;
  }
  const playback = state.playbackState || {};
  state.editorLoopTest = {
    slot: slot.slot,
    regionId: entry.region.id,
    regionIndex: entry.index,
    regionName: entry.region.name || `Region ${entry.index + 1}`,
    repeatMode,
    startSeconds: timing.startSeconds,
    endSeconds: timing.endSeconds
  };
  state.editorLoopActionInFlight = false;
  renderEditorTransport(slot);
  if (playback.currentSlot === slot.slot && playback.transport === "playing") return;
  const startPoint = pointForBarBeat(slot, Number(entry.region.startBar || 1), Number(entry.region.startBeat || 1));
  setTimelineTransportPoint(slot, startPoint);
  await sendPlaybackCommand("play", { slot: slot.slot, startSeconds: timing.startSeconds, skipSketchLoop: true });
}

async function startEditorSketchRepeat(slot, sketch, repeatMode) {
  const range = normalizedRegionSketchRange(sketch);
  const draftRegion = {
    id: "sketch-selection",
    name: "Selection",
    startBar: range.startBar,
    startBeat: range.startBeat,
    endBar: range.endBar,
    endBeat: range.endBeat
  };
  const timing = regionTiming(slot, draftRegion);
  if (!timing || timing.endSeconds <= timing.startSeconds + 0.1) {
    setAlert("Selected area is too short to repeat.");
    return;
  }
  const playback = state.playbackState || {};
  const alreadyTesting = state.editorLoopTest?.slot === slot.slot
    && state.editorLoopTest.regionId === draftRegion.id
    && state.editorLoopTest.repeatMode === repeatMode;
  state.editorLoopTest = {
    slot: slot.slot,
    regionId: draftRegion.id,
    regionIndex: -1,
    regionName: `Selection ${range.startBar}-${range.endBar - 1}`,
    repeatMode,
    startSeconds: timing.startSeconds,
    endSeconds: timing.endSeconds
  };
  state.editorLoopActionInFlight = false;
  renderEditorTransport(slot);
  if (alreadyTesting && playback.transport === "paused" && playback.currentSlot === slot.slot) {
    await sendPlaybackCommand("play", { slot: slot.slot, skipSketchLoop: true });
    return;
  }
  const startPoint = pointForBarBeat(slot, range.startBar, range.startBeat);
  setTimelineTransportPoint(slot, startPoint);
  await sendPlaybackCommand("play", { slot: slot.slot, startSeconds: timing.startSeconds, skipSketchLoop: true });
}

function clearEditorRegionLoopTest() {
  state.editorLoopTest = null;
  state.editorLoopActionInFlight = false;
}

async function serviceEditorRegionLoop(slot) {
  const test = state.editorLoopTest;
  const playback = state.playbackState || {};
  if (!test || playback.mode === "performance" || playback.transport !== "playing") return;
  if (playback.currentSlot !== test.slot || slot?.slot !== test.slot || state.editorLoopActionInFlight) return;
  if (currentTransportSeconds() < Math.max(test.startSeconds + 0.1, test.endSeconds) - 0.02) return;

  state.editorLoopActionInFlight = true;
  try {
    await sendPlaybackCommand("seek", {
      slot: test.slot,
      seconds: test.startSeconds,
      regionId: test.regionId,
      regionName: test.regionName
    });
    if (test.repeatMode === "once") {
      clearEditorRegionLoopTest();
      renderEditorTransport(slot);
    }
  } finally {
    window.setTimeout(() => {
      state.editorLoopActionInFlight = false;
    }, 180);
  }
}

function selectedRegionEntry(slot) {
  const index = Number(state.selectedRegionIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  const region = slot?.regions?.regions?.[index];
  return region ? { region, index } : null;
}

function regionTiming(slot, region) {
  if (!slot || !region) return null;
  const startSeconds = timeForBarBeat(slot, Number(region.startBar || 1), Number(region.startBeat || 1));
  const endSeconds = timeForBarBeat(slot, Number(region.endBar || region.startBar || 1), Number(region.endBeat || 1));
  return { startSeconds, endSeconds };
}

function renderTimelineRuler(beatGrid, duration) {
  if (!els.timelineRuler) return;
  const fragment = document.createDocumentFragment();
  const timelineWidth = Math.max(1, (els.timelineSurface?.clientWidth || 1) * state.timelineZoom);
  let lastLabelX = -Infinity;
  for (let index = 0; index < beatGrid.length; index += 1) {
    const beat = beatGrid[index];
    const timeSeconds = Number(beat.timeSeconds || 0);
    const percent = percentForTime(timeSeconds, duration);
    const pixel = (percent / 100) * timelineWidth;
    const measure = Number(beat.measure);
    const beatInMeasure = Number(beat.beat || beat.beatInMeasure);
    const downbeat = isGridDownbeat(beat, index);
    const tick = document.createElement("div");
    tick.className = `ruler-tick ${downbeat ? "major" : "minor"}`;
    tick.style.left = `${percent}%`;
    const labelMeasure = Number.isFinite(measure) && measure > 0 ? measure : Math.floor(gridGlobalBeat(beat, index) / 4) + 1;
    const labelBeat = Number.isFinite(beatInMeasure) && beatInMeasure > 0 ? beatInMeasure : (gridGlobalBeat(beat, index) % 4) + 1;
    tick.title = `${labelMeasure}.${labelBeat} | ${formatSeconds(timeSeconds)}`;
    const labelSpacing = downbeat ? 58 : 82;
    if (index === 0 || pixel - lastLabelX >= labelSpacing) {
      tick.classList.add("labelled");
      tick.innerHTML = `<strong>${labelMeasure}.${labelBeat}</strong>`;
      lastLabelX = pixel;
    }
    fragment.append(tick);
  }
  els.timelineRuler.append(fragment);
}

function renderTimelineGrid(beatGrid, duration) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < beatGrid.length; index += 1) {
    const beat = beatGrid[index];
    const globalBeat = gridGlobalBeat(beat, index);
    const line = document.createElement("i");
    line.className = "timeline-grid-line";
    const downbeat = isGridDownbeat(beat, index);
    line.classList.toggle("measure-line", downbeat);
    line.classList.toggle("beat-line", !downbeat);
    line.style.left = `${percentForTime(Number(beat.timeSeconds || 0), duration)}%`;
    if (downbeat) {
      line.dataset.measure = String(Number(beat.measure || Math.floor(globalBeat / 4) + 1));
    }
    fragment.append(line);
  }
  els.timelineGrid.append(fragment);
}

function renderWaveformBed(slot, maxBar) {
  const peaks = appendTimelineTailPeaks(slot, arrangedWaveformPeaks(slot));
  const bars = peaks.length ? peaks.length : Math.min(220, Math.max(48, Math.round(maxBar * 1.5)));
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < bars; index += 1) {
    const bar = document.createElement("i");
    const peak = peaks.length ? Number(peaks[index] || 0) : 0;
    const displayPeak = peak < 0.01 ? 0 : Math.min(1, peak);
    bar.classList.toggle("silent-waveform-bin", displayPeak === 0);
    bar.style.setProperty("--amp", displayPeak.toFixed(4));
    fragment.append(bar);
  }
  els.fakeWaveform.append(fragment);
  els.fakeWaveform.classList.toggle("waveform-real", Boolean(peaks.length));
}

function arrangedWaveformPeaks(slot) {
  if (slot?.arrangementCache?.waveform?.peaks?.length) {
    return slot.arrangementCache.waveform.peaks;
  }
  const peaks = Array.isArray(slot?.waveform?.peaks) ? slot.waveform.peaks : [];
  const blocks = arrangedBlocks(slot);
  if (arrangementEnabled(slot) && peaks.length && blocks.length) {
    const duration = Number(slot.waveform.durationSeconds || 0);
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
  const cuts = Array.isArray(slot?.arrangement?.cuts) ? slot.arrangement.cuts : [];
  if (!arrangementEnabled(slot) || !peaks.length || !cuts.length) return peaks;
  const duration = Number(slot.waveform.durationSeconds || 0);
  if (!duration) return peaks;
  const buckets = peaks.length;
  const keep = peaks.filter((_, index) => {
    const time = (index / Math.max(1, buckets - 1)) * duration;
    return !cuts.some((cut) => time >= Number(cut.startSeconds || 0) && time < Number(cut.endSeconds || 0));
  });
  return keep.length ? keep : peaks;
}

function renderSectionLane(slot, duration, cueMarkers = null) {
  const cues = (cueMarkers || slot.cues?.cueMarkers || []).slice().sort((a, b) => Number(a.bar || 1) - Number(b.bar || 1) || Number(a.beat || 1) - Number(b.beat || 1));
  if (!cues.length) return;
  cues.forEach((cue, index) => {
    const start = Number(cue.bar || 1);
    const startTime = timeForBarBeat(slot, start, Number(cue.beat || 1));
    const next = cues[index + 1];
    const endTime = next ? timeForBarBeat(slot, Number(next.bar || start + 1), Number(next.beat || 1)) : duration;
    const item = document.createElement("div");
    item.className = "timeline-section-block";
    const left = percentForTime(startTime, duration);
    const right = percentForTime(Math.max(startTime + 0.25, endTime), duration);
    item.style.left = `${left}%`;
    item.style.width = `${Math.max(0, Math.min(100 - left, Math.max(3, right - left)))}%`;
    item.title = `${cue.name || `Cue ${index + 1}`} ${start}.${cue.beat || 1}`;
    els.sectionLane.append(item);
  });
}

function updateWaveformReadout(slot = null) {
  const cues = arrangedCueEntries(slot).map((entry) => entry.cue);
  const scrub = slot ? currentScrubPoint(slot) : null;
  const ordered = cues.slice().sort((a, b) => Number(a.bar || 1) - Number(b.bar || 1) || Number(a.beat || 1) - Number(b.beat || 1));
  const currentCue = scrub ? cueAtBeat(ordered, scrub) : ordered[0];
  const nextCue = scrub ? nextCueAfterBeat(ordered, scrub) : ordered[1];
  els.waveformCurrentSection.textContent = currentCue?.name || "--";
  els.waveformSelectedSection.textContent = slot?.title || "--";
  els.waveformNextSection.textContent = nextCue?.name || "--";
  if (slot && scrub) {
    els.timelineStatus.textContent = `${formatSeconds(scrub.timeSeconds)} | ${scrub.measure}.${scrub.beat}`;
  }
}

function beginTimelineScrub(event) {
  const selected = selectedMetadata();
  if (!selected) return;
  if (event.target.closest(".timeline-ruler") || event.target.closest(".region-lane") || event.target.closest(".timeline-region") || event.target.closest(".timeline-cue") || event.target.closest("#regionMenu")) return;
  event.preventDefault();
  state.movingTransportSlot = selected.slot;
  els.timelineSurface.setPointerCapture(event.pointerId);
  scrubTimelineToPointer(event, selected);
  const move = (moveEvent) => scrubTimelineToPointer(moveEvent, selected);
  const up = () => {
    els.timelineSurface.removeEventListener("pointermove", move);
    els.timelineSurface.removeEventListener("pointerup", up);
    els.timelineSurface.removeEventListener("pointercancel", up);
  };
  els.timelineSurface.addEventListener("pointermove", move);
  els.timelineSurface.addEventListener("pointerup", up);
  els.timelineSurface.addEventListener("pointercancel", up);
}

function beginRulerGesture(event) {
  const selected = selectedMetadata();
  if (!selected || event.button !== 0) return;
  if (event.target.closest("#regionMenu")) return;
  const startPoint = snappedBeatFromPointer(event, selected);
  if (!startPoint) return;
  event.preventDefault();
  event.stopPropagation();
  if (state.playbackState?.mode === "performance") {
    setTimelineTransportPoint(selected, startPoint, { seekPlayback: true });
    renderSelectedMetadata();
    return;
  }
  hideRegionMenu();
  state.selectedRegionIndex = null;
  state.selectedCueIndex = null;
  state.regionSketch = null;
  let isSelecting = false;
  const startX = event.clientX;
  setTimelineTransportPoint(selected, startPoint);
  els.timelineRuler.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const point = snappedBeatFromPointer(moveEvent, selected);
    if (!point) return;
    if (Math.abs(moveEvent.clientX - startX) > 4) isSelecting = true;
    setTimelineTransportPoint(selected, point);
    if (!isSelecting) return;
    state.regionSketch = {
      slot: selected.slot,
      startMeasure: startPoint.measure,
      endMeasure: point.measure
    };
    renderRegionSketchSelection(selected);
    els.createRegionFromSelection.disabled = false;
    const range = normalizedRegionSketchRange(state.regionSketch);
    const measureCount = selectedMeasureCount(range);
    els.timelineStatus.textContent = `${measureCount} measures selected`;
  };

  const up = (upEvent) => {
    els.timelineRuler.removeEventListener("pointermove", move);
    els.timelineRuler.removeEventListener("pointerup", up);
    els.timelineRuler.removeEventListener("pointercancel", up);
    const point = snappedBeatFromPointer(upEvent, selected) || startPoint;
    setTimelineTransportPoint(selected, point, { seekPlayback: !isSelecting });
    renderSelectedMetadata();
  };

  els.timelineRuler.addEventListener("pointermove", move);
  els.timelineRuler.addEventListener("pointerup", up);
  els.timelineRuler.addEventListener("pointercancel", up);
}

function beginRegionSketch(event) {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance" || event.button !== 0) return;
  if (event.target.closest(".timeline-region") || event.target.closest("#regionMenu")) return;
  event.preventDefault();
  event.stopPropagation();
  const start = measurePointFromPointer(event, selected) || insertionPointForSelectedSlot(selected, { measureSnap: true });
  if (!start) return;
  const end = measurePointFromPointer(event, selected) || start;
  state.regionSketch = {
    slot: selected.slot,
    startMeasure: start.measure,
    endMeasure: end.measure
  };
  renderRegionSketchSelection(selected);
  renderSelectedMetadata();
  els.regionLane.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const point = measurePointFromPointer(moveEvent, selected);
    if (!point || !state.regionSketch) return;
    state.regionSketch.endMeasure = point.measure;
    renderRegionSketchSelection(selected);
    els.createRegionFromSelection.disabled = false;
    const range = normalizedRegionSketchRange(state.regionSketch);
    const measureCount = selectedMeasureCount(range);
    els.timelineStatus.textContent = `${measureCount} measures selected`;
  };

  const up = () => {
    els.regionLane.removeEventListener("pointermove", move);
    els.regionLane.removeEventListener("pointerup", up);
    els.regionLane.removeEventListener("pointercancel", up);
    renderSelectedMetadata();
  };

  els.regionLane.addEventListener("pointermove", move);
  els.regionLane.addEventListener("pointerup", up);
  els.regionLane.addEventListener("pointercancel", up);
}

function measurePointFromPointer(event, slot) {
  const beatGrid = visualBeatGrid(slot);
  if (!beatGrid.length) return null;
  const rect = els.timelineSurface.getBoundingClientRect();
  const timelineWidth = Math.max(1, els.timelineSurface.clientWidth * state.timelineZoom);
  const x = Math.max(0, Math.min(timelineWidth, event.clientX - rect.left + els.timelineSurface.scrollLeft));
  const duration = slotTimelineDuration(slot);
  const targetSeconds = (x / timelineWidth) * duration;
  const measureGrid = fourBeatSnapGrid(beatGrid);
  return nearestBeat(measureGrid.length ? measureGrid : beatGrid, targetSeconds);
}

function renderRegionSketchSelection(slot) {
  if (!els.regionSketchSelection) return;
  const sketch = slot ? regionSketchForSlot(slot) : null;
  if (!slot || !sketch || state.playbackState?.mode === "performance") {
    els.regionSketchSelection.classList.add("hidden");
    return;
  }
  const range = normalizedRegionSketchRange(sketch);
  const duration = slotTimelineDuration(slot);
  const startTime = timeForBarBeat(slot, range.startBar, 1);
  const endTime = timeForBarBeat(slot, range.endBar, 1);
  const left = percentForTime(startTime, duration);
  const right = percentForTime(Math.max(startTime + 0.1, endTime), duration);
  const width = Math.max(0, Math.min(100 - left, Math.max(1, right - left)));
  els.regionSketchSelection.style.left = `calc(100% * var(--timeline-zoom, 1) * ${left / 100})`;
  els.regionSketchSelection.style.width = `calc(100% * var(--timeline-zoom, 1) * ${width / 100})`;
  els.regionSketchSelection.querySelector("span")?.remove();
  const label = document.createElement("span");
  const measureCount = selectedMeasureCount(range);
  label.textContent = `${measureCount}m`;
  els.regionSketchSelection.append(label);
  els.regionSketchSelection.classList.remove("hidden");
}

function regionSketchForSlot(slot) {
  return state.regionSketch?.slot === slot?.slot ? state.regionSketch : null;
}

function normalizedRegionSketchRange(sketch) {
  const startMeasure = Number(sketch?.startMeasure || 1);
  const endMeasure = Number(sketch?.endMeasure || startMeasure);
  const first = Math.min(startMeasure, endMeasure);
  const last = Math.max(startMeasure, endMeasure);
  return {
    startBar: first,
    startBeat: 1,
    endBar: Math.max(first + 1, last + 1),
    endBeat: 1
  };
}

function selectedMeasureCount(range) {
  return Math.max(1, Number(range?.endBar || 1) - Number(range?.startBar || 1));
}

function createRegionFromSketchSelection() {
  const selected = selectedMetadata();
  const sketch = regionSketchForSlot(selected);
  if (!selected || !sketch || state.playbackState?.mode === "performance") return;
  const range = normalizedRegionSketchRange(sketch);
  const regions = selected.regions.regions;
  pushEditorUndo("Create region");
  regions.push({
    id: `region-${Date.now()}`,
    name: `Region ${regions.length + 1}`,
    startBar: range.startBar,
    startBeat: range.startBeat,
    endBar: range.endBar,
    endBeat: range.endBeat
  });
  state.regionSketch = null;
  renderSelectedMetadata();
  flushMetadataAutosave();
}

function scrubTimelineToPointer(event, slot) {
  const point = snappedBeatFromPointer(event, slot);
  if (!point) return;
  setTimelineTransportPoint(slot, point);
}

function setTimelineTransportPoint(slot, point, options = {}) {
  if (!slot || !point) return;
  state.movingTransportSlot = slot.slot;
  state.scrubBySlot[slot.slot] = point;
  renderScrubPlayhead(slot);
  updateWaveformReadout(slot);
  renderAudioAlignmentStatus(slot);
  renderTransportReadout(slot);
  if (options.seekPlayback) seekPlaybackToPoint(slot, point);
}

function seekPlaybackToPoint(slot, point) {
  const playback = state.playbackState || {};
  if (playback.currentSlot !== slot?.slot) return;
  sendPlaybackCommand("seek", { seconds: Number(point.timeSeconds || 0) });
}

function snappedBeatFromPointer(event, slot) {
  const beatGrid = visualBeatGrid(slot);
  if (!beatGrid.length) return null;
  const rect = els.timelineSurface.getBoundingClientRect();
  const timelineWidth = Math.max(1, els.timelineSurface.clientWidth * state.timelineZoom);
  const x = Math.max(0, Math.min(timelineWidth, event.clientX - rect.left + els.timelineSurface.scrollLeft));
  const duration = slotTimelineDuration(slot);
  const targetSeconds = (x / timelineWidth) * duration;
  const lastBeat = beatGrid.at(-1);
  if (lastBeat && targetSeconds > Number(lastBeat.timeSeconds || 0)) {
    return transportPointFromGridBeat(lastBeat, targetSeconds);
  }
  return nearestTransportSnap(beatGrid, targetSeconds);
}

function timeForBarBeat(slot, bar, beat) {
  const beatGrid = visualBeatGrid(slot);
  if (!beatGrid.length) return 0;
  const exact = beatGrid.find((item) => Number(item.measure) === Number(bar) && Number(item.beat || item.beatInMeasure) === Number(beat));
  if (exact) return Number(exact.timeSeconds || 0);
  const measureStart = beatGrid.find((item) => Number(item.measure) === Number(bar));
  if (measureStart) return Number(measureStart.timeSeconds || 0);
  return Number(beatGrid.at(-1)?.timeSeconds || 0);
}

function sourceTimeForBarBeat(slot, bar, beat) {
  const beatGrid = sourceBeatGrid(slot);
  if (!beatGrid.length) return 0;
  const exact = beatGrid.find((item) => Number(item.measure) === Number(bar) && Number(item.beat || item.beatInMeasure) === Number(beat));
  if (exact) return Number(exact.timeSeconds || 0);
  const measureStart = beatGrid.find((item) => Number(item.measure) === Number(bar));
  if (measureStart) return Number(measureStart.timeSeconds || 0);
  return Number(beatGrid.at(-1)?.timeSeconds || 0);
}

function sourceBeatGrid(slot) {
  return Array.isArray(slot?.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
}

function visualBeatGrid(slot) {
  const source = sourceBeatGrid(slot);
  if (!arrangementEnabled(slot)) return extendBeatGridForTimeline(source);
  const blocks = arrangedBlocks(slot);
  if (!blocks.length) return extendBeatGridForTimeline(source);
  const arranged = [];
  let fallbackGlobalBeat = 0;
  blocks.forEach((block) => {
    const rawStart = Number(block.rawStartSeconds || 0);
    const rawEnd = Number(block.rawEndSeconds || rawStart);
    const arrangedStart = Number(block.arrangedStartSeconds || 0);
    source.forEach((beat) => {
      const rawTime = Number(beat.timeSeconds || 0);
      if (rawTime < rawStart - 0.0001 || rawTime >= rawEnd - 0.0001) return;
      const rawMeasure = Number(beat.measure || block.rawStartBar);
      const rawBeat = Number(beat.beat || beat.beatInMeasure || 1);
      arranged.push({
        ...beat,
        timeSeconds: arrangedStart + Math.max(0, rawTime - rawStart),
        measure: Number(block.startBar || 1) + Math.max(0, rawMeasure - Number(block.rawStartBar || 1)),
        beat: rawBeat,
        beatInMeasure: rawBeat,
        globalBeat: fallbackGlobalBeat,
        isDownbeat: rawBeat === 1 || Boolean(beat.isDownbeat)
      });
      fallbackGlobalBeat += 1;
    });
  });
  return extendBeatGridForTimeline(arranged.length ? arranged : source);
}

function appendTimelineTailPeaks(slot, peaks) {
  if (!Array.isArray(peaks) || !peaks.length) return peaks;
  const audioDuration = slotWaveformDuration(slot);
  const timelineDuration = slotTimelineDuration(slot);
  if (timelineDuration <= audioDuration + 0.001) return peaks;
  const tailCount = Math.ceil(peaks.length * ((timelineDuration - audioDuration) / Math.max(0.001, audioDuration)));
  return peaks.concat(Array(Math.min(400, Math.max(1, tailCount))).fill(0));
}

function extendBeatGridForTimeline(beatGrid, extraMeasures = 8) {
  const source = Array.isArray(beatGrid) ? beatGrid.slice() : [];
  if (source.length < 2 || extraMeasures <= 0) return source;
  const last = source.at(-1);
  const previous = source.at(-2);
  const beatSeconds = Math.max(0.001, Number(last.timeSeconds || 0) - Number(previous.timeSeconds || 0));
  const beatsPerMeasure = beatsPerMeasureFromGrid(source);
  const extended = source.slice();
  let measure = Number(last.measure || 1);
  let beat = Number(last.beat || last.beatInMeasure || beatsPerMeasure);
  let globalBeat = gridGlobalBeat(last, source.length - 1);
  let timeSeconds = Number(last.timeSeconds || 0);
  const beatsToAdd = Math.max(0, Math.floor(extraMeasures * beatsPerMeasure));
  for (let index = 0; index < beatsToAdd; index += 1) {
    beat += 1;
    if (beat > beatsPerMeasure) {
      beat = 1;
      measure += 1;
    }
    globalBeat += 1;
    timeSeconds += beatSeconds;
    extended.push({
      ...last,
      timeSeconds,
      measure,
      beat,
      beatInMeasure: beat,
      globalBeat,
      isDownbeat: beat === 1,
      timelineTail: true
    });
  }
  return extended;
}

function beatsPerMeasureFromGrid(beatGrid) {
  const measures = new Map();
  beatGrid.forEach((beat) => {
    const measure = Number(beat.measure);
    const beatNumber = Number(beat.beat || beat.beatInMeasure);
    if (!Number.isFinite(measure) || !Number.isFinite(beatNumber)) return;
    measures.set(measure, Math.max(measures.get(measure) || 0, beatNumber));
  });
  const values = [...measures.values()].filter((value) => value > 0);
  return Math.max(1, Math.round(values.at(-1) || values[0] || 4));
}

function percentForTime(timeSeconds, durationSeconds) {
  const duration = Math.max(0.001, Number(durationSeconds || 0));
  return Math.max(0, Math.min(100, (Number(timeSeconds || 0) / duration) * 100));
}

function nearestBeat(beatGrid, targetSeconds) {
  let selected = beatGrid[0];
  let bestDistance = Math.abs(Number(selected.timeSeconds || 0) - targetSeconds);
  for (const beat of beatGrid) {
    const distance = Math.abs(Number(beat.timeSeconds || 0) - targetSeconds);
    if (distance < bestDistance) {
      selected = beat;
      bestDistance = distance;
    }
  }
  return transportPointFromGridBeat(selected);
}

function nearestTransportSnap(beatGrid, targetSeconds) {
  if (currentTimelineSnap() === "free") return beatAtTime(beatGrid, targetSeconds);
  if (currentTimelineSnap() !== "measure") return nearestBeat(beatGrid, targetSeconds);
  const measureGrid = fourBeatSnapGrid(beatGrid);
  return nearestBeat(measureGrid.length ? measureGrid : beatGrid, targetSeconds);
}

function currentTimelineSnap() {
  if (els.timelineSnap?.value === "free") return "free";
  return ["measure", "bar"].includes(els.timelineSnap?.value) ? "measure" : "beat";
}

function fourBeatSnapGrid(beatGrid) {
  return beatGrid.filter((beat, index) => isGridDownbeat(beat, index));
}

function isGridDownbeat(beat, index = 0) {
  const beatInMeasure = Number(beat?.beat || beat?.beatInMeasure);
  if (beat?.isDownbeat || beatInMeasure === 1) return true;
  return !Number.isFinite(beatInMeasure) && gridGlobalBeat(beat, index) % 4 === 0;
}

function beatAtTime(beatGrid, targetSeconds) {
  if (!beatGrid.length) return null;
  let selected = beatGrid[0];
  for (const beat of beatGrid) {
    if (Number(beat.timeSeconds || 0) > targetSeconds) break;
    selected = beat;
  }
  return transportPointFromGridBeat(selected, targetSeconds);
}

function transportPointFromGridBeat(gridBeat, timeSeconds = null) {
  const globalBeat = gridGlobalBeat(gridBeat, 0);
  const measure = Number(gridBeat?.measure);
  const beat = Number(gridBeat?.beat || gridBeat?.beatInMeasure);
  return {
    timeSeconds: Number(timeSeconds ?? gridBeat?.timeSeconds ?? 0),
    measure: Number.isFinite(measure) && measure > 0 ? measure : Math.floor(globalBeat / 4) + 1,
    beat: Number.isFinite(beat) && beat > 0 ? beat : (globalBeat % 4) + 1,
    globalBeat
  };
}

function insertionPointForSelectedSlot(slot, options = {}) {
  if (!slot) return null;
  const liveOrScrub = currentScrubPoint(slot);
  if (!liveOrScrub) return null;
  if (!options.measureSnap) return liveOrScrub;
  const beatGrid = Array.isArray(slot.tempoMap?.beatGrid) ? slot.tempoMap.beatGrid : [];
  if (!beatGrid.length) return liveOrScrub;
  const measureGrid = fourBeatSnapGrid(beatGrid);
  return nearestBeat(measureGrid.length ? measureGrid : beatGrid, liveOrScrub.timeSeconds);
}

function gridGlobalBeat(gridBeat, fallbackIndex) {
  const value = Number(gridBeat?.globalBeat);
  return Number.isFinite(value) ? value : fallbackIndex;
}

function currentTransportSeconds() {
  const playback = state.playbackState || {};
  const meterTime = activeMeterTransportSeconds(playback.currentSlot);
  if (meterTime !== null) return meterTime;
  const anchor = Number(playback.transportAnchorSeconds ?? playback.currentTimeSeconds ?? 0) || 0;
  if (playback.transport !== "playing" || !playback.transportStartedAt) {
    return Number(playback.currentTimeSeconds ?? anchor) || 0;
  }
  const startedAt = Date.parse(playback.transportStartedAt);
  if (!Number.isFinite(startedAt)) return Number(playback.currentTimeSeconds || anchor) || 0;
  return Math.max(0, anchor + ((Date.now() - startedAt) / 1000));
}

function activeMeterTransportSeconds(slotNumber) {
  const meters = state.mixerMeters || {};
  if (state.playbackState?.transport !== "playing" || !meters.active) return null;
  if (Number(meters.slot) !== Number(slotNumber)) return null;
  const time = Number(meters.currentTimeSeconds);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function renderScrubPlayhead(slot) {
  const point = currentScrubPoint(slot);
  if (!point) {
    els.waveformPlayhead.style.transform = "translate3d(0, 0, 0)";
    els.waveformPlayhead.title = "Start";
    return;
  }
  const duration = slotTimelineDuration(slot);
  const percent = duration > 0 ? Math.max(0, Math.min(100, (point.timeSeconds / duration) * 100)) : 0;
  const surfaceWidth = Math.max(1, els.timelineSurface?.clientWidth || 1);
  const playheadX = surfaceWidth * state.timelineZoom * (percent / 100);
  els.waveformPlayhead.style.transform = `translate3d(${playheadX}px, 0, 0)`;
  els.waveformPlayhead.title = `${formatSeconds(point.timeSeconds)} | measure ${point.measure}, beat ${point.beat}`;
  keepTransportInWaveformView(percent);
}

function keepTransportInWaveformView(percent) {
  const surface = els.timelineSurface;
  if (!surface || state.userTimelineScrollActiveUntil > performance.now()) return;
  const playback = state.playbackState || {};
  if (!["playing", "paused"].includes(playback.transport) && !state.movingTransportSlot) return;
  const timelineWidth = Math.max(1, surface.clientWidth * state.timelineZoom);
  const playheadX = Math.max(0, Math.min(timelineWidth, timelineWidth * (percent / 100)));
  const leftEdge = surface.scrollLeft;
  const rightEdge = leftEdge + surface.clientWidth;
  const margin = Math.max(90, Math.min(220, surface.clientWidth * 0.22));
  let nextScrollLeft = null;
  if (playheadX < leftEdge + margin) {
    nextScrollLeft = playheadX - margin;
  } else if (playheadX > rightEdge - margin) {
    nextScrollLeft = playheadX - surface.clientWidth + margin;
  }
  if (nextScrollLeft === null) return;
  const maxScroll = Math.max(0, surface.scrollWidth - surface.clientWidth);
  state.timelineAutoScrolling = true;
  surface.scrollLeft = Math.max(0, Math.min(maxScroll, nextScrollLeft));
  window.requestAnimationFrame(() => {
    state.timelineAutoScrolling = false;
  });
}

function markManualTimelineScroll() {
  if (state.timelineAutoScrolling) return;
  state.userTimelineScrollActiveUntil = performance.now() + 900;
}

function currentScrubPoint(slot) {
  if (!slot) return null;
  const stored = state.scrubBySlot[slot.slot];
  const playback = state.playbackState || {};
  if (state.movingTransportSlot === slot.slot && stored && playback.transport !== "playing") return stored;
  if (playback.currentSlot === slot.slot && ["playing", "paused"].includes(playback.transport)) {
    const beatGrid = visualBeatGrid(slot);
    const seconds = arrangementCacheReady(slot) ? currentTransportSeconds() : (arrangedTimeForRawTime(slot, currentTransportSeconds()) ?? currentTransportSeconds());
    return beatAtTime(beatGrid, seconds);
  }
  if (stored) return stored;
  const firstBeat = visualBeatGrid(slot)[0];
  return {
    timeSeconds: 0,
    measure: Number(firstBeat?.measure || 1),
    beat: Number(firstBeat?.beat || firstBeat?.beatInMeasure || 1),
    globalBeat: Number(firstBeat?.globalBeat || 0)
  };
}

function arrangementCacheReady(slot) {
  return Boolean(slot?.arrangementCache?.ready && Number(slot.arrangementCache.durationSeconds || slot.arrangementCache.waveform?.durationSeconds || 0) > 0);
}

function rawTimeForArrangedTime(slot, arrangedSeconds) {
  const blocks = arrangedBlocks(slot);
  if (!blocks.length) return null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const arrangedStart = Number(block.arrangedStartSeconds || timeForBarBeat(slot, block.startBar, 1));
    const arrangedEnd = Number(block.arrangedEndSeconds || timeForBarBeat(slot, block.endBar, 1));
    if (arrangedSeconds >= arrangedStart && arrangedSeconds < arrangedEnd) {
      return {
        index,
        blockId: block.id,
        rawSeconds: Number(block.rawStartSeconds || 0) + Math.max(0, arrangedSeconds - arrangedStart)
      };
    }
  }
  const first = blocks[0];
  return first ? { index: 0, blockId: first.id, rawSeconds: Number(first.rawStartSeconds || 0) } : null;
}

function arrangedTimeForRawTime(slot, rawSeconds) {
  const blocks = arrangedBlocks(slot);
  if (!blocks.length) return null;
  const cursorIndex = state.arrangementPlayback?.slot === slot.slot ? Number(state.arrangementPlayback.index || 0) : -1;
  const block = blocks[cursorIndex] || blocks.find((item) => rawSeconds >= Number(item.rawStartSeconds || 0) && rawSeconds < Number(item.rawEndSeconds || 0));
  if (!block) return null;
  const arrangedStart = Number(block.arrangedStartSeconds || timeForBarBeat(slot, block.startBar, 1));
  return arrangedStart + Math.max(0, rawSeconds - Number(block.rawStartSeconds || 0));
}

function slotWaveformDuration(slot) {
  const arrangementDuration = Number(slot?.arrangementCache?.durationSeconds || slot?.arrangementCache?.waveform?.durationSeconds || 0);
  if (arrangementDuration > 0) return arrangementDuration;
  const blocks = arrangedBlocks(slot);
  if (blocks.length) {
    return Math.max(1, blocks.reduce((total, block) => {
      return total + Math.max(0, Number(block.rawEndSeconds || 0) - Number(block.rawStartSeconds || 0));
    }, 0));
  }
  const waveformDuration = Number(slot.waveform?.durationSeconds || 0);
  if (waveformDuration > 0) return waveformDuration;
  const beatGrid = visualBeatGrid(slot);
  const gridDuration = Number(beatGrid.at(-1)?.timeSeconds || 0);
  return Math.max(gridDuration, 1);
}

function slotTimelineDuration(slot) {
  const audioDuration = slotWaveformDuration(slot);
  const beatGrid = visualBeatGrid(slot);
  const gridDuration = Number(beatGrid.at(-1)?.timeSeconds || 0);
  return Math.max(audioDuration, gridDuration, 1);
}

function cueAtBeat(cues, point) {
  let current = cues[0] || null;
  for (const cue of cues) {
    if (cueBeatIndex(cue) <= point.globalBeat) current = cue;
  }
  return current;
}

function nextCueAfterBeat(cues, point) {
  return cues.find((cue) => cueBeatIndex(cue) > point.globalBeat) || null;
}

function cueBeatIndex(cue) {
  const beatGrid = visualBeatGrid(selectedMetadata());
  const match = beatGrid.find((beat) => Number(beat.measure) === Number(cue.bar || 1) && Number(beat.beat || beat.beatInMeasure) === Number(cue.beat || 1));
  return Number(match?.globalBeat || 0);
}

function pointForBarBeat(slot, bar, beat) {
  const beatGrid = visualBeatGrid(slot);
  const exact = beatGrid.find((item) => Number(item.measure) === Number(bar) && Number(item.beat || item.beatInMeasure) === Number(beat));
  if (exact) return transportPointFromGridBeat(exact);
  return {
    timeSeconds: timeForBarBeat(slot, bar, beat),
    measure: Number(bar || 1),
    beat: Number(beat || 1),
    globalBeat: cueBeatIndex({ bar, beat })
  };
}

function selectCueMarker(index, slot, options = {}) {
  const cue = slot?.cues?.cueMarkers?.[index];
  if (!cue) return;
  state.selectedCueIndex = index;
  state.selectedRegionIndex = null;
  hideRegionMenu();
  const point = pointForBarBeat(slot, Number(cue.bar || 1), Number(cue.beat || 1));
  setTimelineTransportPoint(slot, point, { seekPlayback: Boolean(options.seekPlayback) });
  renderTimeline(slot);
  renderMetadataEditors(slot, false);
}

function beginCuePointerEdit(event, index, slot) {
  const cue = slot?.cues?.cueMarkers?.[index];
  if (!cue || state.playbackState?.mode === "performance" || event.button !== 0) return;
  const original = {
    slot: slot.slot,
    songId: slot.songId,
    cueId: cue.id,
    cueIndex: index,
    cueName: cue.name || `Cue ${index + 1}`,
    from: {
      bar: Number(cue.bar || 1),
      beat: Number(cue.beat || 1)
    }
  };
  event.preventDefault();
  event.stopPropagation();
  state.selectedCueIndex = index;
  state.selectedRegionIndex = null;
  hideRegionMenu();
  let moved = false;

  const onMove = (moveEvent) => {
    const point = snappedBeatFromPointer(moveEvent, slot);
    if (!point) return;
    if (!moved) pushEditorUndo("Move cue");
    moved = true;
    cue.bar = Number(point.measure || 1);
    cue.beat = Number(point.beat || 1);
    setTimelineTransportPoint(slot, point);
    renderTimeline(slot);
    renderMetadataEditors(slot, false);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (moved) {
      pushCueMoveUndo({
        ...original,
        to: {
          bar: Number(cue.bar || 1),
          beat: Number(cue.beat || 1)
        }
      });
      scheduleMetadataAutosave();
      return;
    }
    selectCueMarker(index, slot);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function pushCueMoveUndo(action) {
  if (!action?.from || !action?.to) return;
  if (Number(action.from.bar) === Number(action.to.bar) && Number(action.from.beat) === Number(action.to.beat)) {
    updateCueUndoControl();
    return;
  }
  state.cueMoveUndoStack.push(action);
  if (state.cueMoveUndoStack.length > 30) state.cueMoveUndoStack.shift();
  updateCueUndoControl();
}

function undoLastCueMove() {
  const action = state.editorUndoStack.pop();
  if (!action) {
    updateCueUndoControl();
    return;
  }
  if (!restoreEditorUndo(action)) {
    updateCueUndoControl();
    return;
  }
  setAlert(`Undid ${action.label || "edit"}.`);
  updateCueUndoControl();
}

function pushEditorUndo(label = "edit") {
  const selected = selectedMetadata();
  if (!selected) return;
  state.editorUndoStack.push({
    label,
    slot: selected.slot,
    songId: selected.songId,
    selectedRegionIndex: state.selectedRegionIndex,
    selectedCueIndex: state.selectedCueIndex,
    snapshot: structuredClone({
      regions: selected.regions,
      cues: selected.cues,
      tempoMap: selected.tempoMap,
      arrangement: selected.arrangement,
      waveform: selected.waveform
    })
  });
  if (state.editorUndoStack.length > 30) state.editorUndoStack.shift();
  updateCueUndoControl();
}

function restoreEditorUndo(action) {
  const slot = (state.setMetadata?.slots || []).find((item) => {
    if (item.slot !== action.slot) return false;
    return !action.songId || item.songId === action.songId;
  });
  if (!slot || !action.snapshot) {
    setAlert("Could not undo because that song is no longer in the set.");
    return false;
  }
  slot.regions = structuredClone(action.snapshot.regions || { regions: [] });
  slot.cues = structuredClone(action.snapshot.cues || { cueMarkers: [] });
  slot.tempoMap = structuredClone(action.snapshot.tempoMap || slot.tempoMap || {});
  slot.arrangement = structuredClone(action.snapshot.arrangement || { cuts: [] });
  slot.waveform = structuredClone(action.snapshot.waveform || slot.waveform || null);
  state.selectedMetadataSlot = slot.slot;
  state.selectedSetlistIndex = slot.slot ? slot.slot - 1 : null;
  state.selectedCueIndex = Number.isInteger(action.selectedCueIndex) ? action.selectedCueIndex : null;
  state.selectedRegionIndex = Number.isInteger(action.selectedRegionIndex) ? action.selectedRegionIndex : null;
  state.regionSketch = null;
  renderMetadataSlotOptions();
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  return true;
}

function updateCueUndoControl() {
  if (!els.undoCueMove) return;
  const locked = state.playbackState?.mode === "performance";
  const action = state.editorUndoStack.at(-1);
  els.undoCueMove.disabled = locked || !action;
  els.undoCueMove.textContent = "Undo Edit";
  els.undoCueMove.title = action
    ? `Undo ${action.label || "last edit"}`
    : "No edit to undo";
}

function deleteSelectedCue() {
  const selected = selectedMetadata();
  if (state.selectedCueIndex === null || !selected?.cues?.cueMarkers) return;
  pushEditorUndo("Delete cue");
  selected.cues.cueMarkers.splice(state.selectedCueIndex, 1);
  state.selectedCueIndex = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function openRegionMenu(index, item, options = {}) {
  const selected = selectedMetadata();
  const region = selected?.regions?.regions?.[index];
  if (!region) return;
  const itemRect = item.getBoundingClientRect();
  const pointerLeft = options.event ? options.event.clientX : null;
  const pointerTop = options.event ? options.event.clientY : null;
  state.selectedRegionIndex = index;
  state.selectedArrangedRegionRange = options.arrangedRange || null;
  state.selectedCueIndex = null;
  els.regionNameSelect.value = region.name || "";
  highlightSelectedRegionEditorRow(index, { scroll: false });
  els.regionMenu.style.left = "12px";
  els.regionMenu.style.top = "12px";
  els.regionMenu.classList.remove("hidden");
  const menuRect = els.regionMenu.getBoundingClientRect();
  const desiredLeft = pointerLeft ?? itemRect.left;
  const desiredTop = pointerTop ?? (itemRect.top + itemRect.height + 8);
  const left = clamp(desiredLeft, 12, Math.max(12, window.innerWidth - menuRect.width - 12));
  const top = clamp(desiredTop, 12, Math.max(12, window.innerHeight - menuRect.height - 12));
  els.regionMenu.style.left = `${left}px`;
  els.regionMenu.style.top = `${top}px`;
  els.regionLane.querySelectorAll(".timeline-region").forEach((regionItem) => {
    regionItem.classList.toggle("selected-region", Number(regionItem.dataset.regionIndex) === index);
  });
  els.cueLane.querySelectorAll(".timeline-cue").forEach((cueItem) => cueItem.classList.remove("selected-cue"));
  if (options.focusName) {
    window.setTimeout(() => {
      els.regionNameSelect.focus();
      els.regionNameSelect.select();
    }, 0);
  }
}

function openTimelineRegionContextMenu(event) {
  if (state.playbackState?.mode === "performance") return;
  if (event.target.closest("#regionMenu") || event.target.closest(".timeline-region")) return;
  const selected = selectedMetadata();
  const match = regionEntryFromTimelinePointer(event, selected);
  if (!match) return;
  event.preventDefault();
  event.stopPropagation();
  const item = {
    getBoundingClientRect: () => ({
      left: event.clientX,
      top: event.clientY,
      height: 0
    })
  };
  openRegionMenu(match.index, item, {
    focusName: false,
    event,
    arrangedRange: match.arrangedRange
  });
}

function regionEntryFromTimelinePointer(event, slot) {
  if (!slot) return null;
  const duration = slotTimelineDuration(slot);
  if (!duration) return null;
  const rect = els.timelineSurface.getBoundingClientRect();
  const timelineWidth = Math.max(1, els.timelineSurface.clientWidth * state.timelineZoom);
  const x = Math.max(0, Math.min(timelineWidth, event.clientX - rect.left + els.timelineSurface.scrollLeft));
  const pointerTime = (x / timelineWidth) * duration;
  const entries = arrangedRegionEntries(slot);
  for (const entry of entries) {
    const region = entry.region;
    const start = timeForBarBeat(slot, Number(region.startBar || 1), Number(region.startBeat || 1));
    const end = timeForBarBeat(slot, Number(region.endBar || region.startBar || 1), Number(region.endBeat || 1));
    if (pointerTime < start || pointerTime > Math.max(start + 0.1, end)) continue;
    const index = entry.sourceIndex;
    return {
      index,
      arrangedRange: {
        slot: slot.slot,
        index,
        blockId: entry.blockId || "",
        startBar: Number(region.startBar || 1),
        startBeat: Number(region.startBeat || 1),
        endBar: Number(region.endBar || region.startBar || 1),
        endBeat: Number(region.endBeat || 1),
        rawStartBar: Number(entry.rawRegion?.startBar || slot.regions?.regions?.[index]?.startBar || region.startBar || 1),
        rawStartBeat: Number(entry.rawRegion?.startBeat || slot.regions?.regions?.[index]?.startBeat || region.startBeat || 1),
        rawEndBar: Number(entry.rawRegion?.endBar || slot.regions?.regions?.[index]?.endBar || region.endBar || 1),
        rawEndBeat: Number(entry.rawRegion?.endBeat || slot.regions?.regions?.[index]?.endBeat || region.endBeat || 1)
      }
    };
  }
  return null;
}

function hideRegionMenu() {
  state.selectedRegionIndex = null;
  state.selectedArrangedRegionRange = null;
  els.regionMenu?.classList.add("hidden");
  els.regionLane?.querySelectorAll(".timeline-region").forEach((regionItem) => regionItem.classList.remove("selected-region"));
}

function updateSelectedRegionName() {
  const region = selectedRegion();
  if (!region) return;
  const nextName = els.regionNameSelect.value.trim();
  if (!nextName) return;
  region.name = nextName;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function trimSelectedRegion() {
  const region = selectedRegion();
  if (!region) return;
  pushEditorUndo("Trim region");
  const start = Number(region.startBar || 1);
  region.endBar = Math.max(start + 1, Number(region.endBar || start + 2) - 1);
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function splitSelectedRegionAtPlayhead() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  const point = currentScrubPoint(selected);
  if (!point) return;
  const splitSeconds = Number(point.timeSeconds || 0);
  const blocks = ensureArrangementBlocks(selected, { initializeFullSong: true });
  const blockIndex = blocks.findIndex((block) => {
    const region = (selected.regions?.regions || []).find((item) => item.id === block.regionId);
    if (!region) return false;
    const start = Number(block.trimStartSeconds ?? sourceTimeForBarBeat(selected, Number(block.trimStartBar || region.startBar || 1), Number(block.trimStartBeat || region.startBeat || 1)));
    const end = Number(block.trimEndSeconds ?? sourceTimeForBarBeat(selected, Number(block.trimEndBar || region.endBar || Number(region.startBar || 1) + 1), Number(block.trimEndBeat || region.endBeat || 1)));
    return splitSeconds > start + 0.05 && splitSeconds < end - 0.05;
  });
  if (blockIndex < 0) {
    setAlert("Move the playhead inside a region block before splitting.");
    return;
  }
  pushArrangementUndo("Split at playhead");
  const block = blocks[blockIndex];
  const region = (selected.regions?.regions || []).find((item) => item.id === block.regionId);
  const leftId = `${block.id || `block-${block.regionId}`}-a-${Date.now()}`;
  const rightId = `${block.id || `block-${block.regionId}`}-b-${Date.now()}`;
  const left = {
    ...block,
    id: leftId,
    trimStartSeconds: Number(block.trimStartSeconds ?? sourceTimeForBarBeat(selected, Number(block.trimStartBar || region.startBar || 1), Number(block.trimStartBeat || region.startBeat || 1))),
    trimEndSeconds: splitSeconds
  };
  const right = {
    ...block,
    id: rightId,
    trimStartSeconds: splitSeconds,
    trimEndSeconds: Number(block.trimEndSeconds ?? sourceTimeForBarBeat(selected, Number(block.trimEndBar || region.endBar || Number(region.startBar || 1) + 1), Number(block.trimEndBeat || region.endBeat || 1)))
  };
  blocks.splice(blockIndex, 1, left, right);
  selected.arrangementCache = null;
  hideRegionMenu();
  state.selectedRegionIndex = (selected.regions?.regions || []).findIndex((item) => item.id === block.regionId);
  state.selectedArrangedRegionRange = {
    slot: selected.slot,
    index: state.selectedRegionIndex,
    blockId: rightId,
    rawStartSeconds: right.trimStartSeconds,
    rawEndSeconds: right.trimEndSeconds
  };
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert("Split created. The right side is selected; press Delete to remove it and close the gap.");
}

function deleteSelectedRegion() {
  const selected = selectedMetadata();
  if (state.selectedRegionIndex === null || !selected?.regions?.regions) return;
  pushEditorUndo("Delete region");
  selected.regions.regions.splice(state.selectedRegionIndex, 1);
  hideRegionMenu();
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function selectedRegion() {
  const selected = selectedMetadata();
  if (state.selectedRegionIndex === null) return null;
  return selected?.regions?.regions?.[state.selectedRegionIndex] || null;
}

function beginRegionPointerEdit(event, index, maxBar, selected, arrangedRange = null) {
  const region = selected?.regions?.regions?.[index];
  if (!selected || !region || event.button !== 0) return;
  if (event.target.closest(".region-live-actions")) return;
  const item = event.currentTarget;
  const laneRect = els.regionLane.getBoundingClientRect();
  const resizeHandle = event.target.closest(".region-resize");
  const action = resizeHandle && state.selectedRegionIndex === index ? resizeHandle.dataset.resize : "move";
  const startX = event.clientX;
  const originalStart = Number(region.startBar || 1);
  const originalEnd = Math.max(originalStart + 1, Number(region.endBar || originalStart + 1));
  let didDrag = false;

  event.preventDefault();
  item.setPointerCapture(event.pointerId);

  const onMove = (moveEvent) => {
    if (!didDrag && Math.abs(moveEvent.clientX - startX) <= 4) return;
    if (!didDrag) pushEditorUndo(action === "move" ? "Move region" : "Resize region");
    didDrag = true;
    if (action === "move") {
      reorderArrangementBlockByPointer(moveEvent, selected, arrangedRange);
      return;
    }
    const deltaBars = Math.round(((moveEvent.clientX - startX) / laneRect.width) * maxBar);
    if (action === "start") {
      region.startBar = clamp(originalStart + deltaBars, 1, originalEnd - 1);
    } else if (action === "end") {
      region.endBar = clamp(originalEnd + deltaBars, originalStart + 1, maxBar);
    } else {
      const length = originalEnd - originalStart;
      const nextStart = clamp(originalStart + deltaBars, 1, maxBar - length);
      region.startBar = nextStart;
      region.endBar = nextStart + length;
    }
    pushPullNeighborRegions(selected.regions.regions, index);
    region.startBeat = Number(region.startBeat || 1);
    region.endBeat = Number(region.endBeat || 1);
    renderTimeline(selected);
    renderMetadataEditors(selected, false);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!didDrag) {
      selectRegionEditorIndex(index, { selected, arrangedRange });
      return;
    }
    scheduleMetadataAutosave();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function reorderArrangementBlockByPointer(event, slot, arrangedRange) {
  if (!slot || !arrangedRange) return;
  const blocks = ensureArrangementBlocks(slot, { initializeFullSong: true });
  const sourceRegion = slot.regions?.regions?.[arrangedRange.index];
  const activeBlockId = arrangedRange.blockId || blocks.find((block) => block.regionId === sourceRegion?.id)?.id || "";
  const fromIndex = blocks.findIndex((block) => block.id === activeBlockId);
  if (fromIndex < 0) return;
  const rect = els.regionLane.getBoundingClientRect();
  const timelineWidth = Math.max(1, els.regionLane.clientWidth);
  const x = Math.max(0, Math.min(timelineWidth, event.clientX - rect.left + els.timelineSurface.scrollLeft));
  const percent = Math.max(0, Math.min(100, (x / timelineWidth) * 100));
  const duration = slotTimelineDuration(slot);
  const pointerTime = (percent / 100) * duration;
  const entries = arrangedRegionEntries(slot);
  const target = entries.find((entry) => {
    if (!entry.blockId || entry.blockId === activeBlockId) return false;
    const start = timeForBarBeat(slot, Number(entry.region.startBar || 1), Number(entry.region.startBeat || 1));
    const end = timeForBarBeat(slot, Number(entry.region.endBar || entry.region.startBar || 1), Number(entry.region.endBeat || 1));
    return pointerTime >= start && pointerTime <= end;
  });
  if (!target) return;
  const toIndex = blocks.findIndex((block) => block.id === target.blockId);
  if (toIndex < 0 || toIndex === fromIndex) return;
  const [moved] = blocks.splice(fromIndex, 1);
  blocks.splice(toIndex, 0, moved);
  slot.arrangement.enabled = true;
  slot.arrangementCache = null;
  state.selectedArrangedRegionRange = {
    ...arrangedRange,
    blockId: moved.id
  };
  renderTimeline(slot);
  renderMetadataEditors(slot, false);
}

function pushPullNeighborRegions(regions, changedIndex) {
  const sorted = regions
    .map((region, index) => ({ region, index }))
    .sort((a, b) => Number(a.region.startBar || 1) - Number(b.region.startBar || 1));
  const position = sorted.findIndex((item) => item.index === changedIndex);
  if (position < 0) return;

  for (let i = position - 1; i >= 0; i -= 1) {
    const current = sorted[i].region;
    const next = sorted[i + 1].region;
    const nextStart = Number(next.startBar || 1);
    const currentStart = Number(current.startBar || 1);
    if (Number(current.endBar || currentStart + 1) > nextStart) {
      current.endBar = Math.max(currentStart + 1, nextStart);
    }
  }

  for (let i = position + 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1].region;
    const current = sorted[i].region;
    const previousEnd = Number(previous.endBar || Number(previous.startBar || 1) + 1);
    const currentStart = Number(current.startBar || 1);
    const currentEnd = Number(current.endBar || currentStart + 1);
    if (currentStart < previousEnd) {
      const length = Math.max(1, currentEnd - currentStart);
      current.startBar = previousEnd;
      current.endBar = previousEnd + length;
    }
  }
}

function setTimelineZoom(value) {
  state.timelineZoom = clamp(value, 1, 12);
  renderSelectedMetadata();
}

function timelineZoomStep(direction = 1) {
  if (direction < 0 && state.timelineZoom > 3) return 0.5;
  if (direction > 0 && state.timelineZoom >= 3) return 0.5;
  return 0.25;
}

function renderMetadataEditors(slot, locked) {
  syncSelectedNameEditors(slot, locked);
  const regions = slot.regions?.regions || [];
  const cues = slot.cues?.cueMarkers || [];
  reconcileEditorRows({
    container: els.regionEditorList,
    items: regions,
    locked,
    rowType: "region",
    headerFactory: regionEditorHeader,
    rowFactory: regionRow,
    syncRow: syncRegionRow,
    emptyText: "No regions yet."
  });
  reconcileEditorRows({
    container: els.cueEditorList,
    items: cues,
    locked,
    rowType: "cue",
    headerFactory: cueEditorHeader,
    rowFactory: cueRow,
    syncRow: syncCueRow,
    emptyText: "No cue markers yet."
  });
}

function reconcileEditorRows({ container, items, locked, rowType, headerFactory, rowFactory, syncRow, emptyText }) {
  const active = document.activeElement;
  const activeInside = active instanceof HTMLElement && container.contains(active);
  const wantedKeys = new Set(items.map((item, index) => editorRowKey(rowType, item, index)));

  container.querySelectorAll(`[data-${rowType}-row-key]`).forEach((row) => {
    if (!wantedKeys.has(row.dataset[`${rowType}RowKey`])) row.remove();
  });
  container.querySelectorAll(".empty").forEach((item) => item.remove());

  if (!items.length) {
    container.replaceChildren(emptyEditorMessage(emptyText));
    return;
  }

  let header = container.querySelector(`.${rowType}-edit-row.edit-row-header`);
  if (!header) {
    header = headerFactory();
    container.prepend(header);
  }

  let anchor = header;
  items.forEach((item, index) => {
    const key = editorRowKey(rowType, item, index);
    let row = container.querySelector(`[data-${rowType}-row-key="${cssEscape(key)}"]`);
    if (!row) row = rowFactory(item, index, locked, key);
    syncRow(row, item, index, locked, activeInside ? active : null);
    if (row.previousElementSibling !== anchor) {
      anchor.after(row);
    }
    anchor = row;
  });
}

function editorRowKey(rowType, item, index) {
  return `${rowType}-${item?.id || index}`;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function regionEditorHeader() {
  const row = document.createElement("div");
  row.className = "edit-row edit-row-header region-edit-row";
  row.innerHTML = `
    <span>Region Name</span>
    <span>Start</span>
    <span>Length</span>
    <span>Delete</span>
  `;
  return row;
}

function regionRow(region, index, locked, key = editorRowKey("region", region, index)) {
  const row = document.createElement("div");
  row.className = "edit-row region-edit-row";
  row.dataset.regionRowKey = key;
  row.innerHTML = `
    <input data-region-field="name" aria-label="Region name" title="Region name">
    <input data-region-field="startLocation" aria-label="Region start location" title="Start measure.beat" inputmode="decimal">
    <input data-region-field="lengthMeasures" aria-label="Region length in measures" title="Length in measures" type="number" min="1" step="1">
    <button class="delete-row-button" type="button" title="Delete region" aria-label="Delete region">&times;</button>
  `;
  row.addEventListener("click", selectRegionEditorRow);
  row.addEventListener("input", updateRegionDraftFromInput);
  row.addEventListener("change", flushMetadataAutosave);
  row.querySelectorAll("input").forEach((input) => {
    isolateEditorInput(input);
    input.addEventListener("focus", () => {
      const currentIndex = Number(input.dataset.index);
      state.selectedRegionIndex = currentIndex;
      state.selectedCueIndex = null;
      els.regionEditorList.querySelectorAll(".region-edit-row").forEach((rowItem) => {
        rowItem.classList.toggle("selected-editor-row", Number(rowItem.dataset.regionIndex) === currentIndex);
      });
      syncSelectedNameEditors(selectedMetadata(), false);
      renderEditorTransport(selectedMetadata());
    });
    input.addEventListener("blur", () => {
      commitRegionInputValue(input);
      flushMetadataAutosave();
    });
  });
  row.querySelector(".delete-row-button")?.addEventListener("click", deleteRegionDraft);
  syncRegionRow(row, region, index, locked, null);
  return row;
}

function cueRow(cue, index, locked, key = editorRowKey("cue", cue, index)) {
  const row = document.createElement("div");
  row.className = "edit-row cue-edit-row";
  row.dataset.cueRowKey = key;
  row.innerHTML = `
    <input data-cue-field="name" aria-label="Cue name" title="Cue name">
    <input data-cue-field="position" aria-label="Cue measure position" title="Measure.beat" inputmode="decimal">
    <button class="delete-row-button" type="button" title="Delete cue" aria-label="Delete cue">&times;</button>
  `;
  row.addEventListener("input", updateCueDraftFromInput);
  row.addEventListener("change", flushMetadataAutosave);
  row.querySelectorAll("input").forEach((input) => {
    isolateEditorInput(input);
    input.addEventListener("focus", () => {
      const currentIndex = Number(input.dataset.index);
      state.selectedCueIndex = currentIndex;
      state.selectedRegionIndex = null;
      els.cueEditorList.querySelectorAll(".cue-edit-row").forEach((rowItem) => {
        rowItem.classList.toggle("selected-editor-row", Number(rowItem.dataset.cueIndex) === currentIndex);
      });
      syncSelectedNameEditors(selectedMetadata(), false);
      renderEditorTransport(selectedMetadata());
    });
    input.addEventListener("blur", () => {
      commitCueInputValue(input);
      flushMetadataAutosave();
    });
  });
  row.addEventListener("click", selectCueEditorRow);
  row.querySelector(".delete-row-button")?.addEventListener("click", deleteCueDraft);
  syncCueRow(row, cue, index, locked, null);
  return row;
}

function syncRegionRow(row, region, index, locked, active = null) {
  row.classList.toggle("selected-editor-row", state.selectedRegionIndex === index);
  row.dataset.regionIndex = String(index);
  const fields = row.querySelectorAll("[data-region-field]");
  fields.forEach((input) => {
    input.dataset.index = String(index);
    input.disabled = locked;
  });
  const name = row.querySelector("[data-region-field=\"name\"]");
  const start = row.querySelector("[data-region-field=\"startLocation\"]");
  const length = row.querySelector("[data-region-field=\"lengthMeasures\"]");
  setInputValueUnlessActive(name, region.name || "", active);
  setInputValueUnlessActive(start, regionStartLocation(region), active);
  setInputValueUnlessActive(length, String(regionLengthMeasures(region)), active);
  const deleteButton = row.querySelector(".delete-row-button");
  if (deleteButton) {
    deleteButton.dataset.deleteRegion = String(index);
    deleteButton.disabled = locked;
  }
}

function syncCueRow(row, cue, index, locked, active = null) {
  row.classList.toggle("selected-editor-row", state.selectedCueIndex === index);
  row.dataset.cueIndex = String(index);
  const fields = row.querySelectorAll("[data-cue-field]");
  fields.forEach((input) => {
    input.dataset.index = String(index);
    input.disabled = locked;
  });
  const name = row.querySelector("[data-cue-field=\"name\"]");
  const position = row.querySelector("[data-cue-field=\"position\"]");
  setInputValueUnlessActive(name, cue.name || "", active);
  setInputValueUnlessActive(position, cuePosition(cue), active);
  const deleteButton = row.querySelector(".delete-row-button");
  if (deleteButton) {
    deleteButton.dataset.deleteCue = String(index);
    deleteButton.disabled = locked;
  }
}

function setInputValueUnlessActive(input, value, active = null) {
  if (!input || input === active) return;
  if (input.value !== String(value)) input.value = String(value);
}

function syncSelectedNameEditors(slot, locked) {
  const region = slot?.regions?.regions?.[state.selectedRegionIndex] || null;
  if (els.selectedRegionName && document.activeElement !== els.selectedRegionName) {
    els.selectedRegionName.value = region?.name || "";
    els.selectedRegionName.placeholder = region ? "Region name" : "Select a region";
  }
  if (els.selectedRegionName) els.selectedRegionName.disabled = locked || !region;

  const cue = slot?.cues?.cueMarkers?.[state.selectedCueIndex] || null;
  if (els.selectedCueName && document.activeElement !== els.selectedCueName) {
    els.selectedCueName.value = cue?.name || "";
    els.selectedCueName.placeholder = cue ? "Cue name" : "Select a cue marker";
  }
  if (els.selectedCueName) els.selectedCueName.disabled = locked || !cue;
}

function isolateEditorInput(input) {
  const stop = (event) => event.stopPropagation();
  for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
    input.addEventListener(eventName, stop, true);
    input.addEventListener(eventName, stop);
  }
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  input.addEventListener("keyup", (event) => event.stopPropagation());
}

function cueEditorHeader() {
  const row = document.createElement("div");
  row.className = "edit-row edit-row-header cue-edit-row";
  row.innerHTML = `
    <span>Cue Name</span>
    <span>Position</span>
    <span>Delete</span>
  `;
  return row;
}

function emptyEditorMessage(text) {
  const item = document.createElement("p");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function addRegionDraft() {
  const selected = selectedMetadata();
  if (!selected) return;
  pushEditorUndo("Add region");
  const regions = selected.regions.regions;
  const point = insertionPointForSelectedSlot(selected, { measureSnap: true }) || { measure: 1, beat: 1 };
  regions.push({
    id: `region-${Date.now()}`,
    name: `Region ${regions.length + 1}`,
    startBar: Number(point.measure || 1),
    startBeat: Number(point.beat || 1),
    endBar: Number(point.measure || 1) + 1,
    endBeat: Number(point.beat || 1)
  });
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function reorderRegionsByTimeline() {
  const selected = selectedMetadata();
  const regions = selected?.regions?.regions;
  if (!regions?.length || state.playbackState?.mode === "performance") return;
  const selectedRegionId = selectedRegion()?.id || null;
  pushEditorUndo("Reorder regions");
  regions.sort((a, b) => {
    const startA = Number(a.startBar || 1);
    const startB = Number(b.startBar || 1);
    if (startA !== startB) return startA - startB;
    const beatA = Number(a.startBeat || 1);
    const beatB = Number(b.startBeat || 1);
    if (beatA !== beatB) return beatA - beatB;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  state.selectedRegionIndex = selectedRegionId
    ? regions.findIndex((region) => region.id === selectedRegionId)
    : null;
  if (state.selectedRegionIndex < 0) state.selectedRegionIndex = null;
  state.selectedArrangedRegionRange = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert("Regions reordered by timeline.");
}

function reorderCuesByTimeline() {
  const selected = selectedMetadata();
  const cues = selected?.cues?.cueMarkers;
  if (!cues?.length || state.playbackState?.mode === "performance") return;
  const selectedCueId = selected?.cues?.cueMarkers?.[state.selectedCueIndex]?.id || null;
  pushEditorUndo("Reorder cues");
  cues.sort((a, b) => {
    const barA = Number(a.bar || 1);
    const barB = Number(b.bar || 1);
    if (barA !== barB) return barA - barB;
    const beatA = Number(a.beat || 1);
    const beatB = Number(b.beat || 1);
    if (beatA !== beatB) return beatA - beatB;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  state.selectedCueIndex = selectedCueId
    ? cues.findIndex((cue) => cue.id === selectedCueId)
    : null;
  if (state.selectedCueIndex < 0) state.selectedCueIndex = null;
  state.selectedRegionIndex = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert("Cue markers reordered by timeline.");
}

function removeSelectedRegionAndCloseGap() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  const range = removableRegionRange(selected);
  if (!range) {
    setAlert("Select a yellow area or blue region to remove.");
    return;
  }
  const length = Math.max(1, Number(range.endBar || 1) - Number(range.startBar || 1));
  pushArrangementUndo("Remove region and close gap");
  removeArrangementRange(selected, range);
  selected.arrangementCache = null;

  state.regionSketch = null;
  state.selectedRegionIndex = null;
  state.selectedArrangedRegionRange = null;
  state.selectedCueIndex = null;
  hideRegionMenu();
  clearEditorRegionLoopTest();
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert(`Removed ${length} ${length === 1 ? "measure" : "measures"} and closed the gap.`);
}

function removeArrangementRange(slot, range) {
  const arrangement = ensureArrangement(slot);
  arrangement.blocks = arrangementBaseBlocksForRemoval(slot);
  const removeBlockId = range.blockId || blockIdForRange(slot, range);
  if (removeBlockId) {
    arrangement.blocks = arrangement.blocks.filter((block) => block.id !== removeBlockId);
  } else {
    const removeStart = Number(range.rawStartBar || range.startBar || 1);
    const removeEnd = Number(range.rawEndBar || range.endBar || removeStart);
    const removeLength = Math.max(1, removeEnd - removeStart);
    arrangement.blocks = arrangement.blocks
      .map((block) => splitOrTrimArrangementBlock(slot, block, removeStart, removeEnd, removeLength))
      .flat()
      .filter(Boolean);
  }
  arrangement.cuts = [];
  arrangement.enabled = true;
  refreshRemovedCueSources(slot);
}

function arrangementBaseBlocksForRemoval(slot) {
  const existing = Array.isArray(slot?.arrangement?.blocks) && slot.arrangement.blocks.length
    ? slot.arrangement.blocks
    : fullSongArrangementBlocks(slot);
  return existing.map((block) => ({ ...block }));
}

function refreshRemovedCueSources(slot) {
  const arrangement = ensureArrangement(slot);
  const keptRegionIds = new Set((arrangement.blocks || []).map((block) => block.regionId));
  const removed = fullSongArrangementBlocks(slot).filter((block) => {
    return !keptRegionIds.has(block.regionId);
  });
  const ids = removed.map((block) => {
    const region = (slot?.regions?.regions || []).find((item) => item.id === block.regionId);
    if (!region) return "";
    return removedRegionCueIds(slot, {
      rawStartBar: Number(region.startBar || 1),
      rawStartBeat: Number(region.startBeat || 1),
      rawEndBar: Number(region.endBar || Number(region.startBar || 1) + 1),
      rawEndBeat: Number(region.endBeat || 1)
    })[0] || "";
  }).filter(Boolean);
  arrangement.removedCueSourceIds = [...new Set(ids)];
}

function removedRegionCueIds(slot, range) {
  const cues = slot?.cues?.cueMarkers || [];
  const removedRegion = removedRegionForRange(slot, range);
  if (!removedRegion) return [];
  const expected = cuePositionForRegionStart(slot, Number(removedRegion.startBar || 1), Number(removedRegion.startBeat || 1));
  return cues
    .filter((cue) => {
      if (Number(cue.bar || 1) !== expected.bar || Number(cue.beat || 1) !== expected.beat) return false;
      return cueNameMatchesRegion(cue.name, removedRegion.name);
    })
    .map((cue) => cue.id)
    .filter(Boolean);
}

function removedRegionForRange(slot, range) {
  const rawStart = Number(range.rawStartBar || range.startBar || 1);
  const rawEnd = Number(range.rawEndBar || range.endBar || rawStart);
  return (slot?.regions?.regions || []).find((region) => {
    return Number(region.startBar || 1) === rawStart && Number(region.endBar || 1) === rawEnd;
  }) || null;
}

function cuePositionForRegionStart(slot, startBar, startBeat = 1) {
  const measureLead = 2;
  return {
    bar: Math.max(1, Number(startBar || 1) - measureLead),
    beat: Number(startBeat || 1)
  };
}

function cueNameMatchesRegion(cueName, regionName) {
  const cue = sectionNameKey(cueName);
  const region = sectionNameKey(regionName);
  return cue && region && (cue === region || region.startsWith(cue) || cue.startsWith(region));
}

function sectionNameKey(value) {
  return String(value || "").toLowerCase().replace(/\d+/g, "").replace(/[^a-z]+/g, "").trim();
}

function arrangementBlockFromEntry(entry) {
  const regionId = entry?.block?.regionId || entry?.region?.id || entry?.rawRegion?.id;
  if (!regionId) return null;
  return {
    id: entry.blockId || entry.block?.id || `block-${regionId}`,
    regionId,
    name: entry.block?.name || "",
    trimStartBar: Number(entry.block?.rawStartBar || entry.rawRegion?.startBar || entry.region?.startBar || 1),
    trimStartBeat: Number(entry.block?.rawStartBeat || entry.rawRegion?.startBeat || 1),
    trimEndBar: Number(entry.block?.rawEndBar || entry.rawRegion?.endBar || entry.region?.endBar || 1),
    trimEndBeat: Number(entry.block?.rawEndBeat || entry.rawRegion?.endBeat || 1)
  };
}

function fullSongArrangementBlocks(slot) {
  return (slot?.regions?.regions || [])
    .slice()
    .sort(compareRegionsByTimeline)
    .map((region) => ({
      id: `block-${region.id}`,
      regionId: region.id,
      name: "",
      trimStartBar: Number(region.startBar || 1),
      trimStartBeat: Number(region.startBeat || 1),
      trimEndBar: Number(region.endBar || Number(region.startBar || 1) + 1),
      trimEndBeat: Number(region.endBeat || 1)
    }));
}

function blockIdForRange(slot, range) {
  const rawStart = Number(range.rawStartBar || range.startBar || 1);
  const rawEnd = Number(range.rawEndBar || range.endBar || rawStart);
  const entry = arrangedRegionEntries(slot).find((item) => {
    return Number(item.block?.rawStartBar || 0) === rawStart && Number(item.block?.rawEndBar || 0) === rawEnd;
  });
  return entry?.blockId || "";
}

function splitOrTrimArrangementBlock(slot, block, removeStart, removeEnd, removeLength) {
  const region = (slot.regions?.regions || []).find((item) => item.id === block.regionId);
  if (!region) return null;
  const start = Number(block.trimStartBar || region.startBar || 1);
  const end = Math.max(start + 1, Number(block.trimEndBar || region.endBar || start + 1));
  if (end <= removeStart || start >= removeEnd) return block;
  if (start >= removeStart && end <= removeEnd) return null;
  if (start < removeStart && end > removeEnd) {
    return [
      { id: `${block.id}-a-${Date.now()}`, regionId: block.regionId, trimStartBar: start, trimEndBar: removeStart },
      { id: `${block.id}-b-${Date.now()}`, regionId: block.regionId, trimStartBar: removeEnd, trimEndBar: end }
    ];
  }
  if (start < removeStart && end > removeStart) {
    return { ...block, trimStartBar: start, trimEndBar: removeStart };
  }
  if (start < removeEnd && end > removeEnd) {
    return { ...block, trimStartBar: removeEnd, trimEndBar: end };
  }
  return null;
}

function pushArrangementUndo(label = "Arrangement edit") {
  const selected = selectedMetadata();
  if (!selected) return;
  state.arrangementUndoStack.push({
    label,
    slot: selected.slot,
    songId: selected.songId,
    arrangement: structuredClone(selected.arrangement || { cuts: [] })
  });
  if (state.arrangementUndoStack.length > 10) state.arrangementUndoStack.shift();
  updateArrangementUndoControl();
}

function arrangementEnabled(slot) {
  if (!slot?.arrangement || typeof slot.arrangement !== "object") return false;
  const hasCuts = Array.isArray(slot.arrangement.cuts) && slot.arrangement.cuts.length;
  const hasBlocks = Array.isArray(slot.arrangement.blocks) && slot.arrangement.blocks.length;
  const hasSongTrim = Number(slot.arrangement.trimStartBar || 1) > 1
    || Number(slot.arrangement.trimEndBar || 0) > 0
    || Number(slot.arrangement.trimStartSeconds || 0) > 0
    || Number(slot.arrangement.trimEndSeconds || 0) > 0;
  return slot.arrangement.enabled !== false && Boolean(hasCuts || hasBlocks || hasSongTrim);
}

function arrangementHasCuts(slot) {
  return Boolean(slot && ((Array.isArray(slot.arrangement?.cuts) && slot.arrangement.cuts.length)
    || (Array.isArray(slot.arrangement?.blocks) && slot.arrangement.blocks.length)
    || Number(slot.arrangement?.trimStartBar || 1) > 1
    || Number(slot.arrangement?.trimEndBar || 0) > 0
    || Number(slot.arrangement?.trimStartSeconds || 0) > 0
    || Number(slot.arrangement?.trimEndSeconds || 0) > 0));
}

function ensureArrangementBlocks(slot, options = {}) {
  const arrangement = ensureArrangement(slot);
  const regions = (slot?.regions?.regions || []).slice().sort(compareRegionsByTimeline);
  const existing = new Set(regions.map((region) => region.id));
  const current = Array.isArray(arrangement.blocks) ? arrangement.blocks.filter((block) => existing.has(block.regionId)) : [];
  if (!current.length || options.initializeFullSong) {
    const currentIds = new Set(current.map((block) => block.regionId));
    regions.forEach((region) => {
      if (currentIds.has(region.id)) return;
      current.push({
        id: `block-${region.id}`,
        regionId: region.id,
        trimStartBar: Number(region.startBar || 1),
        trimStartBeat: Number(region.startBeat || 1),
        trimEndBar: Number(region.endBar || Number(region.startBar || 1) + 1),
        trimEndBeat: Number(region.endBeat || 1)
      });
    });
  }
  arrangement.blocks = current;
  arrangement.enabled = true;
  return arrangement.blocks;
}

function trimSongStartToPlayhead() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  const point = currentScrubPoint(selected);
  if (!point) return;
  const maxBar = songTrimMaxBar(selected);
  const trimStartBar = clamp(Number(point.measure || 1), 1, Math.max(1, maxBar - 1));
  const arrangement = ensureArrangement(selected);
  const trimEndBar = Number(arrangement.trimEndBar || maxBar);
  const trimStartSeconds = Number(point.timeSeconds || 0);
  const trimEndSeconds = Number(arrangement.trimEndSeconds || slotWaveformDuration(selected));
  if (trimStartBar >= trimEndBar || trimStartSeconds >= trimEndSeconds) {
    setAlert("Start trim must be before the end trim.");
    return;
  }
  pushArrangementUndo("Trim song start");
  arrangement.trimStartBar = trimStartBar;
  arrangement.trimStartBeat = Number(point.beat || 1);
  arrangement.trimStartSeconds = trimStartSeconds;
  arrangement.enabled = true;
  arrangement.updatedAt = new Date().toISOString();
  selected.arrangementCache = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert(`Song start trimmed to ${trimStartBar}.${Number(point.beat || 1)}.`);
}

function trimSongEndToPlayhead() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  const point = currentScrubPoint(selected);
  if (!point) return;
  const maxBar = songTrimMaxBar(selected);
  const trimEndBar = clamp(Number(point.measure || maxBar), 2, maxBar);
  const arrangement = ensureArrangement(selected);
  const trimStartBar = Number(arrangement.trimStartBar || 1);
  const trimEndSeconds = Number(point.timeSeconds || 0);
  const trimStartSeconds = Number(arrangement.trimStartSeconds || 0);
  if (trimEndBar <= trimStartBar || trimEndSeconds <= trimStartSeconds + 0.05) {
    setAlert("End trim must be after the start trim.");
    return;
  }
  pushArrangementUndo("Trim song end");
  arrangement.trimEndBar = trimEndBar;
  arrangement.trimEndBeat = Number(point.beat || 1);
  arrangement.trimEndSeconds = trimEndSeconds;
  arrangement.enabled = true;
  arrangement.updatedAt = new Date().toISOString();
  selected.arrangementCache = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert(`Song end trimmed to ${trimEndBar}.${Number(point.beat || 1)}.`);
}

function songTrimMaxBar(slot) {
  const regions = slot?.regions?.regions || [];
  const regionMax = regions.reduce((max, region) => Math.max(max, Number(region.endBar || region.startBar || 1)), 1);
  const grid = visualBeatGrid(slot);
  const gridMax = grid.reduce((max, beat) => Math.max(max, Number(beat.measure || 1)), 1);
  return Math.max(regionMax, gridMax, 2);
}

function arrangedRegionEntries(slot) {
  const blocks = arrangedBlocks(slot);
  if (arrangementEnabled(slot) && blocks.length) {
    return blocks.map((block, blockIndex) => {
      const sourceIndex = (slot.regions?.regions || []).findIndex((region) => region.id === block.regionId);
      return {
        sourceIndex,
        blockIndex,
        blockId: block.id,
        region: {
          ...(slot.regions?.regions?.[sourceIndex] || {}),
          id: block.regionId,
          name: block.name,
          startBar: block.startBar,
          startBeat: 1,
          endBar: block.endBar,
          endBeat: 1
        },
        rawRegion: slot.regions?.regions?.[sourceIndex] || null,
        block
      };
    }).filter((entry) => entry.sourceIndex >= 0);
  }
  let entries = (slot?.regions?.regions || []).map((region, sourceIndex) => ({
    sourceIndex,
    region: { ...region }
  }));
  const cuts = arrangedCuts(slot);
  if (!arrangementEnabled(slot) || !cuts.length) return entries;

  cuts.forEach((cut) => {
    const cutLength = cut.endBar - cut.startBar;
    entries = entries
      .map((entry) => {
        const region = removeRangeFromRegion(entry.region, cut.startBar, cut.endBar, cutLength);
        return region ? { ...entry, region } : null;
      })
      .filter(Boolean);
  });
  return entries;
}

function arrangedCueEntries(slot) {
  const blocks = arrangedBlocks(slot);
  if (arrangementEnabled(slot) && blocks.length) {
    const cues = slot?.cues?.cueMarkers || [];
    const removedCueIds = new Set(Array.isArray(slot?.arrangement?.removedCueSourceIds) ? slot.arrangement.removedCueSourceIds : []);
    const associatedSourceIndexes = new Set(blocks
      .map((block) => associatedCueForBlock(cues, block, removedCueIds)?.sourceIndex)
      .filter((index) => Number.isInteger(index)));
    const entries = [];
    blocks.forEach((block) => {
      const usedSourceIndexes = new Set();
      const associated = associatedCueForBlock(cues, block, removedCueIds);
      if (associated) {
        usedSourceIndexes.add(associated.sourceIndex);
        entries.push({
          sourceIndex: associated.sourceIndex,
          blockId: block.id,
          cue: {
            ...associated.cue,
            bar: Math.max(1, Number(block.startBar || 1) - 2),
            beat: Number(associated.cue.beat || 1)
          }
        });
      }
      cues.forEach((cue, sourceIndex) => {
        if (removedCueIds.has(cue.id)) return;
        if (associatedSourceIndexes.has(sourceIndex)) return;
        if (usedSourceIndexes.has(sourceIndex)) return;
        const cueBar = Number(cue.bar || 1);
        if (cueBar < block.rawStartBar || cueBar >= block.rawEndBar) return;
        entries.push({
          sourceIndex,
          blockId: block.id,
          cue: {
            ...cue,
            bar: block.startBar + (cueBar - block.rawStartBar),
            beat: Number(cue.beat || 1)
          }
        });
      });
    });
    return entries;
  }
  let entries = (slot?.cues?.cueMarkers || []).map((cue, sourceIndex) => ({
    sourceIndex,
    cue: { ...cue }
  }));
  const cuts = arrangedCuts(slot);
  if (!arrangementEnabled(slot) || !cuts.length) return entries;
  cuts.forEach((cut) => {
    const cutLength = cut.endBar - cut.startBar;
    entries = entries
      .map((entry) => {
        const cue = removeRangeFromCue(entry.cue, cut.startBar, cut.endBar, cutLength);
        return cue ? { ...entry, cue } : null;
      })
      .filter(Boolean);
  });
  return entries;
}

function associatedCueForBlock(cues, block, removedCueIds) {
  const expectedBar = Math.max(1, Number(block.rawStartBar || 1) - 2);
  const expectedBeat = Number(block.rawStartBeat || 1);
  const sourceIndex = cues.findIndex((cue) => {
    if (removedCueIds.has(cue.id)) return false;
    if (Number(cue.bar || 1) !== expectedBar || Number(cue.beat || 1) !== expectedBeat) return false;
    return cueNameMatchesRegion(cue.name, block.name);
  });
  return sourceIndex >= 0 ? { sourceIndex, cue: cues[sourceIndex] } : null;
}

function arrangedBlocks(slot) {
  if (!arrangementEnabled(slot)) return [];
  const regions = (slot?.regions?.regions || []).slice().sort(compareRegionsByTimeline);
  if (!regions.length) return [];
  const waveformDuration = Number(slot?.waveform?.durationSeconds || 0);
  const savedBlocks = Array.isArray(slot?.arrangement?.blocks) ? slot.arrangement.blocks : [];
  const sourceBlocks = savedBlocks.length ? savedBlocks : regions.map((region) => ({ regionId: region.id }));
  const trimStartBar = Number(slot?.arrangement?.trimStartBar || 1);
  const trimEndBar = Number(slot?.arrangement?.trimEndBar || 0);
  const trimStartSeconds = Number(slot?.arrangement?.trimStartSeconds || 0);
  const trimEndSeconds = Number(slot?.arrangement?.trimEndSeconds || 0);
  let cursor = 1;
  let arrangedSeconds = 0;
  return sourceBlocks
    .map((block, index) => {
      const region = regions.find((item) => item.id === block.regionId);
      if (!region) return null;
      const regionStartBar = Number(region.startBar || 1);
      const regionEndBar = Math.max(regionStartBar + 1, Number(region.endBar || regionStartBar + 1));
      const rawStartBar = Math.max(regionStartBar, trimStartBar, Number(block.trimStartBar || regionStartBar));
      const useMeasureEndTrim = trimEndBar > 0 && !trimEndSeconds;
      const rawEndBar = Math.min(regionEndBar, useMeasureEndTrim ? trimEndBar : regionEndBar, Math.max(rawStartBar + 1, Number(block.trimEndBar || regionEndBar)));
      if (rawEndBar <= rawStartBar) return null;
      const length = Math.max(1, rawEndBar - rawStartBar);
      const blockStartSeconds = sourceTimeForBarBeat(slot, rawStartBar, Number(region.startBeat || 1));
      const blockEndSeconds = waveformDuration > 0
        ? Math.min(waveformDuration, sourceTimeForBarBeat(slot, rawEndBar, Number(region.endBeat || 1)))
        : sourceTimeForBarBeat(slot, rawEndBar, Number(region.endBeat || 1));
      const blockTrimStartSeconds = Number(block.trimStartSeconds || 0);
      const blockTrimEndSeconds = Number(block.trimEndSeconds || 0);
      const rawStartSeconds = Math.max(blockStartSeconds, trimStartSeconds, blockTrimStartSeconds || 0);
      const rawEndSeconds = Math.min(
        blockEndSeconds,
        trimEndSeconds > 0 ? trimEndSeconds : blockEndSeconds,
        blockTrimEndSeconds > 0 ? blockTrimEndSeconds : blockEndSeconds
      );
      if (rawEndSeconds <= rawStartSeconds) return null;
      const blockDuration = Math.max(0, rawEndSeconds - rawStartSeconds);
      const arranged = {
        id: String(block.id || `block-${region.id || index}`),
        regionId: region.id,
        name: region.name || `Region ${index + 1}`,
        startBar: cursor,
        startBeat: 1,
        endBar: cursor + length,
        endBeat: 1,
        rawStartBar,
        rawStartBeat: Number(region.startBeat || 1),
        rawEndBar,
        rawEndBeat: Number(region.endBeat || 1),
        rawStartSeconds,
        rawEndSeconds,
        arrangedStartSeconds: arrangedSeconds,
        arrangedEndSeconds: arrangedSeconds + blockDuration
      };
      cursor += length;
      arrangedSeconds += blockDuration;
      return arranged;
    })
    .filter(Boolean);
}

function compareRegionsByTimeline(a, b) {
  const startA = Number(a.startBar || 1);
  const startB = Number(b.startBar || 1);
  if (startA !== startB) return startA - startB;
  return Number(a.startBeat || 1) - Number(b.startBeat || 1);
}

function arrangedCuts(slot) {
  if (!arrangementEnabled(slot)) return [];
  return (Array.isArray(slot?.arrangement?.cuts) ? slot.arrangement.cuts : [])
    .map((cut) => ({
      ...cut,
      startBar: Number(cut.startBar || 1),
      endBar: Number(cut.endBar || cut.startBar || 1),
      startSeconds: Number(cut.startSeconds || 0),
      endSeconds: Number(cut.endSeconds || 0)
    }))
    .filter((cut) => cut.endBar > cut.startBar || cut.endSeconds > cut.startSeconds)
    .sort((a, b) => (a.startSeconds || timeForBarBeat(slot, a.startBar, 1)) - (b.startSeconds || timeForBarBeat(slot, b.startBar, 1)));
}

function ensureArrangement(slot) {
  if (!slot.arrangement || typeof slot.arrangement !== "object") {
    slot.arrangement = { enabled: true, cuts: [] };
  }
  if (!Array.isArray(slot.arrangement.cuts)) slot.arrangement.cuts = [];
  if (slot.arrangement.enabled === undefined) slot.arrangement.enabled = true;
  return slot.arrangement;
}

function syncArrangementControls(slot, locked) {
  if (!els.arrangementEnabled) return;
  const disabled = locked || !slot;
  els.arrangementEnabled.disabled = disabled;
  els.arrangementEnabled.checked = arrangementEnabled(slot);
  if (els.arrangementEnabledLabel) els.arrangementEnabledLabel.textContent = arrangementEnabled(slot) ? "Arrangement On" : "Arrangement Off";
}

function toggleArrangementEnabled() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  pushArrangementUndo("Toggle arrangement");
  const arrangement = ensureArrangement(selected);
  arrangement.enabled = Boolean(els.arrangementEnabled.checked);
  selected.arrangementCache = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function undoArrangementEdit() {
  const action = state.arrangementUndoStack.pop();
  if (!action) {
    updateArrangementUndoControl();
    return;
  }
  const slot = (state.setMetadata?.slots || []).find((item) => item.slot === action.slot && item.songId === action.songId);
  if (!slot) {
    setAlert("Could not undo arrangement because that song is no longer in the set.");
    updateArrangementUndoControl();
    return;
  }
  slot.arrangement = structuredClone(action.arrangement || { cuts: [] });
  slot.arrangementCache = null;
  state.selectedMetadataSlot = slot.slot;
  state.selectedSetlistIndex = slot.slot - 1;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  updateArrangementUndoControl();
  setAlert(`Undid ${action.label || "arrangement edit"}.`);
}

function updateArrangementUndoControl() {
  if (!els.undoArrangement) return;
  const selected = selectedMetadata();
  const locked = state.playbackState?.mode === "performance";
  const action = state.arrangementUndoStack.at(-1);
  els.undoArrangement.disabled = locked || !selected || !action;
  els.undoArrangement.title = action ? `Undo ${action.label}` : "No arrangement edit to undo";
}

async function saveArrangementNow() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance") return;
  clearTimeout(state.metadataSaveTimer);
  await saveSelectedMetadata();
  setAlert("Arrangement saved.");
}

function clearArrangement() {
  const selected = selectedMetadata();
  if (!selected || state.playbackState?.mode === "performance" || !arrangementHasCuts(selected)) return;
  pushArrangementUndo("Clear arrangement");
  selected.arrangement = {
    ...ensureArrangement(selected),
    cuts: [],
    blocks: [],
    trimStartBar: null,
    trimStartBeat: null,
    trimEndBar: null,
    trimEndBeat: null,
    trimStartSeconds: null,
    trimEndSeconds: null
  };
  selected.arrangementCache = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
  setAlert("Arrangement cleared.");
}

function removableRegionRange(selected) {
  const sketch = regionSketchForSlot(selected);
  if (sketch) return normalizedRegionSketchRange(sketch);
  const arrangedRange = state.selectedArrangedRegionRange;
  if (arrangedRange?.slot === selected?.slot && arrangedRange.index === state.selectedRegionIndex) {
    return {
      startBar: Number(arrangedRange.startBar || 1),
      startBeat: Number(arrangedRange.startBeat || 1),
      endBar: Number(arrangedRange.endBar || arrangedRange.startBar || 1),
      endBeat: Number(arrangedRange.endBeat || 1),
      blockId: arrangedRange.blockId || "",
      rawStartBar: Number(arrangedRange.rawStartBar || arrangedRange.startBar || 1),
      rawStartBeat: Number(arrangedRange.rawStartBeat || arrangedRange.startBeat || 1),
      rawEndBar: Number(arrangedRange.rawEndBar || arrangedRange.endBar || arrangedRange.startBar || 1),
      rawEndBeat: Number(arrangedRange.rawEndBeat || arrangedRange.endBeat || 1)
    };
  }
  const region = selectedRegion();
  if (!region) return null;
  const start = Number(region.startBar || 1);
  const end = Math.max(start + 1, Number(region.endBar || start + 1));
  return {
    startBar: start,
    startBeat: Number(region.startBeat || 1),
    endBar: end,
    endBeat: Number(region.endBeat || 1)
  };
}

function removeRangeFromRegion(region, cutStart, cutEnd, cutLength) {
  const start = Number(region.startBar || 1);
  const end = Math.max(start + 1, Number(region.endBar || start + 1));
  if (end <= cutStart) return region;
  if (start >= cutEnd) {
    return {
      ...region,
      startBar: Math.max(1, start - cutLength),
      endBar: Math.max(2, end - cutLength)
    };
  }
  if (start >= cutStart && end <= cutEnd) return null;
  if (start < cutStart && end > cutEnd) {
    return {
      ...region,
      endBar: Math.max(start + 1, end - cutLength)
    };
  }
  if (start < cutStart && end > cutStart) {
    return {
      ...region,
      endBar: Math.max(start + 1, cutStart)
    };
  }
  if (start < cutEnd && end > cutEnd) {
    const nextStart = Math.max(1, cutStart);
    const nextEnd = Math.max(nextStart + 1, end - cutLength);
    return {
      ...region,
      startBar: nextStart,
      endBar: nextEnd
    };
  }
  return region;
}

function removeRangeFromCue(cue, cutStart, cutEnd, cutLength) {
  const bar = Number(cue.bar || 1);
  if (bar >= cutStart && bar < cutEnd) return null;
  if (bar >= cutEnd) {
    return {
      ...cue,
      bar: Math.max(1, bar - cutLength)
    };
  }
  return cue;
}

function addCueDraft() {
  const selected = selectedMetadata();
  if (!selected) return;
  pushEditorUndo("Add cue");
  const cues = selected.cues.cueMarkers;
  const point = insertionPointForSelectedSlot(selected) || { measure: 1, beat: 1 };
  cues.push({
    id: `cue-${Date.now()}`,
    name: `Cue ${cues.length + 1}`,
    bar: Number(point.measure || 1),
    beat: Number(point.beat || 1)
  });
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function deleteRegionDraft(event) {
  event.preventDefault();
  event.stopPropagation();
  const selected = selectedMetadata();
  const index = Number(event.currentTarget.dataset.deleteRegion);
  if (!selected?.regions?.regions || !Number.isInteger(index)) return;
  pushEditorUndo("Delete region");
  selected.regions.regions.splice(index, 1);
  state.selectedRegionIndex = null;
  hideRegionMenu();
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function deleteCueDraft(event) {
  event.preventDefault();
  event.stopPropagation();
  const selected = selectedMetadata();
  const index = Number(event.currentTarget.dataset.deleteCue);
  if (!selected?.cues?.cueMarkers || !Number.isInteger(index)) return;
  pushEditorUndo("Delete cue");
  selected.cues.cueMarkers.splice(index, 1);
  state.selectedCueIndex = null;
  renderSelectedMetadata();
  scheduleMetadataAutosave();
}

function selectRegionEditorRow(event) {
  if (event.target.closest("input, select, textarea, .delete-row-button")) return;
  const selected = selectedMetadata();
  const index = Number(event.currentTarget.dataset.regionIndex);
  selectRegionEditorIndex(index, { selected });
}

function selectRegionEditorIndex(index, options = {}) {
  const selected = options.selected || selectedMetadata();
  if (!selected?.regions?.regions?.[index] || !Number.isInteger(index)) return;
  state.selectedRegionIndex = index;
  state.selectedArrangedRegionRange = options.arrangedRange || null;
  state.selectedCueIndex = null;
  state.regionSketch = null;
  els.regionMenu?.classList.add("hidden");
  highlightSelectedRegionEditorRow(index, { scroll: true });
  const region = selected.regions.regions[index];
  if (options.moveTransport !== false) {
    const transportStartBar = Number(options.arrangedRange?.startBar || region.startBar || 1);
    const transportStartBeat = Number(options.arrangedRange?.startBeat || region.startBeat || 1);
    const point = pointForBarBeat(selected, transportStartBar, transportStartBeat);
    setTimelineTransportPoint(selected, point);
  }
  renderTimeline(selected);
  syncSelectedNameEditors(selected, false);
  if (options.focusName && els.selectedRegionName) {
    window.setTimeout(() => {
      els.selectedRegionName.focus();
      els.selectedRegionName.select();
    }, 0);
  }
  renderEditorTransport(selected);
}

function highlightSelectedRegionEditorRow(index, options = {}) {
  let selectedRow = null;
  els.regionEditorList.querySelectorAll(".region-edit-row").forEach((row) => {
    const selected = Number(row.dataset.regionIndex) === index;
    row.classList.toggle("selected-editor-row", selected);
    if (selected) selectedRow = row;
  });
  if (options.scroll && selectedRow) {
    selectedRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function selectCueEditorRow(event) {
  if (event.target.closest("input, select, textarea, .delete-row-button")) return;
  const selected = selectedMetadata();
  const index = Number(event.currentTarget.dataset.cueIndex);
  selectCueEditorIndex(index, { selected });
}

function selectCueEditorIndex(index, options = {}) {
  const selected = options.selected || selectedMetadata();
  if (!selected?.cues?.cueMarkers?.[index] || !Number.isInteger(index)) return;
  state.selectedCueIndex = index;
  state.selectedRegionIndex = null;
  hideRegionMenu();
  els.cueEditorList.querySelectorAll(".cue-edit-row").forEach((row) => {
    row.classList.toggle("selected-editor-row", Number(row.dataset.cueIndex) === index);
  });
  const cue = selected.cues.cueMarkers[index];
  const point = pointForBarBeat(selected, Number(cue.bar || 1), Number(cue.beat || 1));
  setTimelineTransportPoint(selected, point);
  renderTimeline(selected);
  syncSelectedNameEditors(selected, false);
  if (options.focusName && els.selectedCueName) {
    window.setTimeout(() => {
      els.selectedCueName.focus();
      els.selectedCueName.select();
    }, 0);
  }
  renderEditorTransport(selected);
}

function updateSelectedRegionNameFromEditor(event) {
  const selected = selectedMetadata();
  const region = selected?.regions?.regions?.[state.selectedRegionIndex];
  if (!region) return;
  region.name = event.target.value;
  updateSelectedRegionNameDisplays(region.name);
  scheduleMetadataAutosave();
}

function updateSelectedCueNameFromEditor(event) {
  const selected = selectedMetadata();
  const cue = selected?.cues?.cueMarkers?.[state.selectedCueIndex];
  if (!cue) return;
  cue.name = event.target.value;
  updateSelectedCueNameDisplays(cue.name);
  scheduleMetadataAutosave();
}

function updateSelectedRegionNameDisplays(name) {
  const index = Number(state.selectedRegionIndex);
  const field = els.regionEditorList.querySelector(`[data-region-field="name"][data-index="${index}"]`);
  if (field && field !== document.activeElement) field.value = name || "";
}

function updateSelectedCueNameDisplays(name) {
  const index = Number(state.selectedCueIndex);
  const field = els.cueEditorList.querySelector(`[data-cue-field="name"][data-index="${index}"]`);
  if (field && field !== document.activeElement) field.value = name || "";
}

function commitNameEditorOnEnter(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.currentTarget.blur();
  flushMetadataAutosave();
}

function updateRegionDraftFromInput(event) {
  const field = event.target.dataset.regionField;
  if (!field) return;
  event.stopPropagation();
  const selected = selectedMetadata();
  const index = Number(event.target.dataset.index);
  const region = selected?.regions?.regions?.[index];
  if (!region) return;
  state.selectedRegionIndex = index;
  state.selectedCueIndex = null;
  const value = event.target.value;
  if (field === "name") {
    region.name = value;
    if (els.selectedRegionName && document.activeElement !== els.selectedRegionName) {
      els.selectedRegionName.value = value;
    }
  } else if (field === "startLocation") {
    const point = parseMeasureBeat(value);
    if (!point) return;
    const length = regionLengthMeasures(region);
    region.startBar = point.measure;
    region.startBeat = point.beat;
    region.endBar = point.measure + length;
    region.endBeat = point.beat;
  } else if (field === "lengthMeasures") {
    const length = Math.max(1, Math.round(Number(value || 1)));
    region.endBar = Number(region.startBar || 1) + length;
    region.endBeat = Number(region.startBeat || 1);
  }
  pushPullNeighborRegions(selected.regions.regions, index);
  if (field !== "name") renderTimeline(selected);
  renderEditorTransport(selected);
  scheduleMetadataAutosave();
}

function updateCueDraftFromInput(event) {
  const field = event.target.dataset.cueField;
  if (!field) return;
  event.stopPropagation();
  const selected = selectedMetadata();
  const cue = selected?.cues?.cueMarkers?.[Number(event.target.dataset.index)];
  if (!cue) return;
  if (field === "name") {
    cue.name = event.target.value;
    if (els.selectedCueName && document.activeElement !== els.selectedCueName) {
      els.selectedCueName.value = event.target.value;
    }
  } else if (field === "position") {
    const point = parseMeasureBeat(event.target.value);
    if (!point) return;
    cue.bar = point.measure;
    cue.beat = point.beat;
  }
  if (field !== "name") renderTimeline(selected);
  scheduleMetadataAutosave();
}

function regionStartLocation(region) {
  return measureBeatText(region.startBar, region.startBeat);
}

function regionLengthMeasures(region) {
  const start = Number(region?.startBar || 1);
  const end = Number(region?.endBar || start + 1);
  return Math.max(1, Math.round(end - start));
}

function cuePosition(cue) {
  return measureBeatText(cue.bar, cue.beat);
}

function measureBeatText(measure, beat) {
  return `${Math.max(1, Number(measure || 1))}.${Math.max(1, Number(beat || 1))}`;
}

function parseMeasureBeat(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parts = text.split(/[.:,\s]+/).filter(Boolean);
  const measure = Math.max(1, Math.round(Number(parts[0] || 1)));
  const beat = Math.max(1, Math.round(Number(parts[1] || 1)));
  if (!Number.isFinite(measure) || !Number.isFinite(beat)) return null;
  return { measure, beat };
}

async function saveSelectedMetadata() {
  let selected = selectedMetadata();
  if (!selected) return;
  const keepEditorFocus = metadataInputHasFocus();
  commitFocusedMetadataInput(selected);
  const selectedBpm = Number(els.tempoBpm.value || 0) || null;
  const setlistIndex = Number(selected.slot) - 1;
  const setlistSong = state.setlist[setlistIndex] || null;
  if (selectedBpm && setlistSong && Math.abs(Number(setlistSong.bpm || 0) - selectedBpm) >= 0.001) {
    await updateSetlistSongBpm(setlistIndex, selectedBpm);
    selected = selectedMetadata();
    if (!selected) return;
    commitFocusedMetadataInput(selected);
  }
  selected.tempoMap = {
    ...(selected.tempoMap || {}),
    key: els.tempoKey.value.trim(),
    bpm: selectedBpm,
    timeSignature: els.tempoTimeSignature.value.trim()
  };
  state.setMetadata = await api(`/api/set-metadata/current/slot/${selected.slot}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      regions: selected.regions,
      cues: selected.cues,
      tempoMap: selected.tempoMap,
      arrangement: selected.arrangement,
      mixer: selected.mixer
    })
  });
  state.playbackState = await api("/api/playback/state");
  renderMetadataSlotOptions();
  if (metadataNameInputHasFocus()) {
    return;
  }
  if (keepEditorFocus) {
    renderTimeline(selectedMetadata());
    renderEditorTransport(selectedMetadata());
  } else {
    renderSelectedMetadata();
  }
}

async function approveSelectedMetadata() {
  const selected = selectedMetadata();
  if (!selected) return;
  await saveSelectedMetadata();
  try {
    const result = await api(`/api/set-metadata/current/slot/${selected.slot}/approve`, { method: "POST" });
    setAlert(`Approved cue/regions for slot ${result.slot}.`);
    await auditMetadataCache();
  } catch (error) {
    setAlert(`Approval failed: ${error.message}`);
  }
}

async function auditMetadataCache() {
  if (els.settingsStatus) els.settingsStatus.textContent = "Auditing cue/region cache...";
  try {
    const result = await api("/api/set-metadata/current/audit");
    renderMetadataAuditReport(result);
    if (els.settingsStatus) {
      els.settingsStatus.textContent = result.mismatchCount
        ? `Cue/region audit found ${result.mismatchCount} mismatch(es).`
        : `Cue/region audit clean: ${result.checked} song(s).`;
    }
    return result;
  } catch (error) {
    renderMetadataAuditReport({ ok: false, error: error.message });
    if (els.settingsStatus) els.settingsStatus.textContent = `Cue/region audit failed: ${error.message}`;
    return null;
  }
}

async function rehydrateMetadataCache() {
  if (els.settingsStatus) els.settingsStatus.textContent = "Rehydrating cue/region cache from analyzer files...";
  try {
    const result = await api("/api/set-metadata/current/rehydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeWaveforms: false })
    });
    state.setMetadata = null;
    state.waveformLoadInFlight.clear();
    await loadSetMetadata();
    renderMetadataAuditReport(result.audit || result);
    if (els.settingsStatus) {
      els.settingsStatus.textContent = `Rehydrated ${result.slotCount || 0} song(s), cleared ${result.clearedCount || 0} generated file(s).`;
    }
    return result;
  } catch (error) {
    renderMetadataAuditReport({ ok: false, error: error.message });
    if (els.settingsStatus) els.settingsStatus.textContent = `Rehydrate failed: ${error.message}`;
    return null;
  }
}

function renderMetadataAuditReport(result) {
  if (!els.metadataAuditReport) return;
  els.metadataAuditReport.classList.remove("hidden");
  const mismatches = Array.isArray(result?.mismatches) ? result.mismatches.slice(0, 12) : [];
  els.metadataAuditReport.textContent = JSON.stringify({
    ok: Boolean(result?.ok),
    checked: result?.checked || 0,
    mismatchCount: result?.mismatchCount || 0,
    error: result?.error || "",
    mismatches
  }, null, 2);
}

function metadataInputHasFocus() {
  const active = document.activeElement;
  return Boolean(active instanceof HTMLInputElement && (
    active.dataset.regionField
    || active.dataset.cueField
    || active === els.tempoBpm
  ));
}

function metadataNameInputHasFocus() {
  const active = document.activeElement;
  return Boolean(active instanceof HTMLInputElement && (
    active === els.selectedRegionName
    || active === els.selectedCueName
    || active.dataset.regionField === "name"
    || active.dataset.cueField === "name"
  ));
}

function commitFocusedMetadataInput(selected = selectedMetadata()) {
  const active = document.activeElement;
  if (!selected || !(active instanceof HTMLInputElement)) return;
  if (active.dataset.regionField) {
    commitRegionInputValue(active, selected);
  } else if (active.dataset.cueField) {
    commitCueInputValue(active, selected);
  } else if (active === els.tempoBpm) {
    normalizeTempoBpmInput();
  }
}

function normalizeTempoBpmInput() {
  if (!els.tempoBpm || els.tempoBpm.value === "") return;
  const bpm = Math.max(1, Math.min(300, Math.round(Number(els.tempoBpm.value || 0))));
  if (Number.isFinite(bpm)) els.tempoBpm.value = String(bpm);
}

function stepTempoBpmWithArrowKeys(event) {
  if (!els.tempoBpm || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const current = Number(els.tempoBpm.value || selectedMetadata()?.tempoMap?.bpm || 1);
  const delta = event.key === "ArrowUp" ? 1 : -1;
  const next = Math.max(1, Math.min(300, Math.round(current + delta)));
  els.tempoBpm.value = String(next);
}

function commitRegionInputValue(input, selected = selectedMetadata()) {
  const field = input.dataset.regionField;
  const index = Number(input.dataset.index);
  const region = selected?.regions?.regions?.[index];
  if (!field || !region) return;
  const value = input.value;
  if (field === "name") {
    region.name = value.trim() || `Region ${index + 1}`;
    input.value = region.name;
    return;
  }
  if (field === "startLocation") {
    const point = parseMeasureBeat(value);
    if (!point) return;
    const length = regionLengthMeasures(region);
    region.startBar = point.measure;
    region.startBeat = point.beat;
    region.endBar = point.measure + length;
    region.endBeat = point.beat;
    input.value = regionStartLocation(region);
    return;
  }
  if (field === "lengthMeasures") {
    const length = Math.max(1, Math.round(Number(value || 1)));
    region.endBar = Number(region.startBar || 1) + length;
    region.endBeat = Number(region.startBeat || 1);
    input.value = String(regionLengthMeasures(region));
  }
}

function commitCueInputValue(input, selected = selectedMetadata()) {
  const field = input.dataset.cueField;
  const index = Number(input.dataset.index);
  const cue = selected?.cues?.cueMarkers?.[index];
  if (!field || !cue) return;
  if (field === "name") {
    cue.name = input.value.trim() || `Cue ${index + 1}`;
    input.value = cue.name;
    return;
  }
  if (field === "position") {
    const point = parseMeasureBeat(input.value);
    if (!point) return;
    cue.bar = point.measure;
    cue.beat = point.beat;
    input.value = cuePosition(cue);
  }
}

function scheduleMetadataAutosave() {
  if (state.playbackState?.mode === "performance") return;
  clearTimeout(state.metadataSaveTimer);
  state.metadataSaveTimer = setTimeout(saveSelectedMetadata, 450);
}

function flushMetadataAutosave() {
  if (state.playbackState?.mode === "performance") return;
  clearTimeout(state.metadataSaveTimer);
  saveSelectedMetadata();
}

async function loadSong(songId) {
  setAlert("");
  els.songTitle.textContent = "Loading...";
  els.songMeta.textContent = "Checking library warnings.";

  const song = await api(`/api/songs/${encodeURIComponent(songId)}`);
  state.loadedSong = song;
  renderLoadedSong();
}

function renderLibraryStatus() {
  const library = state.library;
  const scanned = library.scannedAt ? new Date(library.scannedAt).toLocaleString() : "not scanned";
  const duplicateText = library.duplicateWarningCount
    ? ` ${library.duplicateWarningCount} duplicate WAV warnings.`
    : "";
  els.status.textContent = `${library.songCount || 0} songs. Last scan: ${scanned}.${duplicateText}`;
  els.refresh.disabled = false;
  renderTabCounts();
  renderSkippedFolders();
  if (state.settings) renderSettings();
}

function renderSongs() {
  const songs = filteredSongs();
  els.select.replaceChildren();

  for (const song of songs) {
    const option = document.createElement("option");
    option.value = song.id;
    option.textContent = state.activeVendor === "All" ? `${song.title} (${song.vendor})` : song.title;
    option.draggable = true;
    option.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-library-song-id", song.id);
      event.dataTransfer.effectAllowed = "copy";
    });
    if (song.duplicateWarnings?.length) {
      option.textContent = `! ${option.textContent}`;
    }
    els.select.append(option);
  }
}

function renderSetlist() {
  state.setlistTransitions = normalizeClientTransitions(state.setlistTransitions, state.setlist);
  els.setlistSlots.replaceChildren();
  const songCount = state.setlist.filter(Boolean).length;
  els.setlistCount.textContent = `${songCount}/${state.setlist.length} songs`;

  state.setlist.forEach((song, index) => {
    if (!song && state.playbackState?.mode === "performance") return;

    const slot = document.createElement("article");
    slot.className = "setlist-slot";
    slot.classList.add(readinessClass(song));
    slot.classList.toggle("selected", index === state.selectedSetlistIndex);
    slot.classList.toggle("current-playback", state.playbackState?.currentSlot === index + 1);
    slot.classList.toggle("selection-locked", setlistSelectionLocked(index));
    slot.dataset.index = String(index);
    slot.addEventListener("dragover", handleSlotDragOver);
    slot.addEventListener("dragleave", handleSlotDragLeave);
    slot.addEventListener("drop", handleSlotDrop);

    if (song) {
      slot.draggable = state.playbackState?.mode !== "performance";
      slot.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("application/x-setlist-index", String(index));
        event.dataTransfer.effectAllowed = "move";
      });
      slot.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        selectSetlistSong(index, song.id);
      });
    } else {
      slot.addEventListener("click", () => openAddSongModal(index));
    }

    const content = document.createElement("div");
    content.className = "slot-song";
    if (song) {
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      const readiness = document.createElement("span");
      const menu = document.createElement("button");
      menu.className = "song-tile-menu";
      menu.type = "button";
      menu.textContent = "...";
      menu.title = "Song actions";
      menu.disabled = state.playbackState?.mode === "performance";
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        selectSetlistSong(index, song.id);
        slot.classList.toggle("menu-open");
      });
      title.textContent = song.title;
      meta.textContent = setlistMetaText(song);
      readiness.className = "slot-readiness";
      readiness.textContent = readinessLabel(song);
      content.append(title, meta, readiness);
      slot.append(content, menu);
      slot.append(songActionMenu(index, song));
    } else {
      const add = document.createElement("button");
      add.className = "add-song-tile-button";
      add.type = "button";
      add.textContent = "+";
      add.setAttribute("aria-label", `Add song to slot ${index + 1}`);
      add.disabled = state.playbackState?.mode === "performance";
      add.addEventListener("click", (event) => {
        event.stopPropagation();
        openAddSongModal(index);
      });
      const label = document.createElement("span");
      label.textContent = `Slot ${index + 1}`;
      content.classList.add("slot-empty");
      content.append(add, label);
      slot.append(content);
    }

    if (song) {
      const remove = document.createElement("button");
      remove.className = "slot-remove";
      remove.type = "button";
      remove.textContent = "x";
      remove.title = "Remove song";
      remove.disabled = state.playbackState?.mode === "performance";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSongAt(index);
        if (state.selectedSetlistIndex === index) {
          state.selectedSetlistIndex = null;
          state.loadedSong = null;
          renderLoadedSong();
        }
        renderSetlist();
        scheduleSetlistSave();
      });
      slot.append(remove);
    }

    els.setlistSlots.append(slot);
    const transition = transitionAfterSlot(index + 1);
    if (transition) {
      els.setlistSlots.append(transitionTile(transition));
    }
  });
  if (!transitionEditorHasFocus()) {
    renderTransitionEditorDock();
  } else {
    syncTransitionTileEditingState();
  }
}

function transitionAfterSlot(fromSlot) {
  return (state.setlistTransitions || []).find((transition) => Number(transition.fromSlot) === Number(fromSlot)) || null;
}

function transitionTile(transition) {
  const tile = document.createElement("article");
  tile.className = `transition-tile transition-${transition.mode}`;
  tile.dataset.fromSlot = String(transition.fromSlot);
  tile.classList.toggle("editing", Number(state.openTransitionFromSlot) === Number(transition.fromSlot));
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "transition-summary";
  summary.innerHTML = `
    <strong>${escapeHtml(transitionModeLabel(transition.mode))}</strong>
    <span>${escapeHtml(transitionPadSummary(transition))}</span>
    <small>${transitionDurationForMode(transition, transition.mode)}s</small>
  `;
  const toggleEditor = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fromSlot = Number(transition.fromSlot);
    const willOpen = Number(state.openTransitionFromSlot) !== fromSlot;
    state.openTransitionFromSlot = willOpen ? fromSlot : null;
    document.querySelectorAll(".transition-tile.editing").forEach((item) => item.classList.remove("editing"));
    tile.classList.toggle("editing", willOpen);
    renderTransitionEditorDock();
  };
  tile.addEventListener("click", toggleEditor);
  summary.addEventListener("click", toggleEditor);

  tile.append(summary);
  return tile;
}

function renderTransitionEditorDock(options = {}) {
  if (!els.transitionEditorDock) return;
  if (!options.force && transitionEditorHasFocus()) return;
  const transition = state.openTransitionFromSlot === null ? null : transitionAfterSlot(state.openTransitionFromSlot);
  els.transitionEditorDock.replaceChildren();
  els.transitionEditorDock.classList.toggle("hidden", !transition);
  if (!transition) return;

  const title = document.createElement("div");
  title.className = "transition-dock-title";
  title.innerHTML = `
    <strong>Transition after slot ${Number(transition.fromSlot)}</strong>
    <span>${transition.toSlot ? `to slot ${Number(transition.toSlot)}` : "end of set"}</span>
  `;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    state.openTransitionFromSlot = null;
    renderTransitionEditorDock({ force: true });
    renderSetlist();
  });

  const mode = transitionTypeControl(transition.mode);
  const continuePad = document.createElement("label");
  continuePad.className = "transition-toggle";
  continuePad.innerHTML = `<input type="checkbox" ${transition.continuePad !== false ? "checked" : ""}> <span>Pad</span>`;
  const pad = selectControl("Pad", transition.padBehavior, [
    ["off", "Off"],
    ["hold-current-key", "Hold Current"],
    ["next-song-key", "Next Key"],
    ["crossfade-to-next-key", "Pad Xfade"]
  ]);
  const duration = document.createElement("label");
  duration.className = "transition-duration-field";
  duration.textContent = "Transition Time";
  const durationInput = document.createElement("input");
  durationInput.type = "number";
  durationInput.max = "30";
  durationInput.step = "0.25";
  durationInput.min = transition.mode === "crossfade" ? "0.25" : "0";
  durationInput.value = String(transitionDurationForMode(transition, transition.mode));
  duration.append(durationInput);
  const durationHint = document.createElement("span");
  durationHint.className = "transition-duration-hint";
  durationHint.textContent = `${transitionModeLabel(transition.mode)} lead`;
  duration.append(durationHint);
  const saveTransition = () => {
    const nextMode = mode.value();
    const durationByMode = {
      ...normalizeTransitionDurationByMode(transition.durationByMode || transition),
      [transitionDurationKey(nextMode)]: normalizeTransitionDurationSeconds(
        durationInput.value,
        defaultTransitionDurationForMode(nextMode),
        nextMode === "crossfade" ? 0.25 : 0
      )
    };
    updateTransition(transition.fromSlot, {
      mode: nextMode,
      continuePad: continuePad.querySelector("input").checked,
      padBehavior: pad.select.value,
      durationSeconds: transitionDurationForMode({ durationByMode }, nextMode),
      durationByMode
    });
  };
  mode.buttons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      mode.setValue(button.dataset.transitionMode);
      const nextMode = button.dataset.transitionMode;
      durationInput.min = nextMode === "crossfade" ? "0.25" : "0";
      durationInput.value = String(transitionDurationForMode(transition, nextMode));
      durationHint.textContent = `${transitionModeLabel(nextMode)} lead`;
      saveTransition();
    });
  });
  [pad.select, durationInput, continuePad.querySelector("input")].forEach((control) => {
    control.addEventListener("change", saveTransition);
    control.addEventListener("click", (event) => event.stopPropagation());
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
  });
  durationInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      durationInput.blur();
      saveTransition();
    }
  });
  durationInput.addEventListener("blur", saveTransition);

  const fields = document.createElement("div");
  fields.className = "transition-dock-fields";
  fields.append(mode.label, continuePad, pad.label, duration);
  els.transitionEditorDock.append(title, fields, close);
}

function transitionEditorHasFocus() {
  return Boolean(els.transitionEditorDock && els.transitionEditorDock.contains(document.activeElement));
}

function syncTransitionTileEditingState() {
  document.querySelectorAll(".transition-tile").forEach((tile) => {
    tile.classList.toggle("editing", Number(tile.dataset.fromSlot) === Number(state.openTransitionFromSlot));
  });
}

function transitionTypeControl(value) {
  const label = document.createElement("label");
  label.textContent = "Type";
  label.className = "transition-type-field";
  const group = document.createElement("div");
  group.className = "transition-type-options";
  const options = [
    ["cue-next", "Cue Next"],
    ["stay", "Stay"],
    ["crossfade", "Crossfade"]
  ];
  const buttons = options.map(([optionValue, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.transitionMode = optionValue;
    button.textContent = text;
    button.classList.toggle("active", optionValue === value);
    group.append(button);
    return button;
  });
  label.append(group);
  return {
    label,
    buttons,
    value: () => group.querySelector("button.active")?.dataset.transitionMode || "cue-next",
    setValue: (nextValue) => {
      buttons.forEach((button) => button.classList.toggle("active", button.dataset.transitionMode === nextValue));
    }
  };
}

function selectControl(labelText, value, options) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const select = document.createElement("select");
  for (const [optionValue, text] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = text;
    select.append(option);
  }
  select.value = value;
  label.append(select);
  return { label, select };
}

function updateTransition(fromSlot, patch) {
  state.openTransitionFromSlot = Number(fromSlot);
  state.setlistTransitions = normalizeClientTransitions(state.setlistTransitions.map((transition) => {
    if (Number(transition.fromSlot) !== Number(fromSlot)) return transition;
    return { ...transition, ...patch };
  }));
  refreshTransitionTile(fromSlot);
  scheduleTransitionSave();
}

function refreshTransitionTile(fromSlot) {
  const transition = transitionAfterSlot(fromSlot);
  const tile = els.setlistSlots?.querySelector(`.transition-tile[data-from-slot="${fromSlot}"]`);
  const summary = tile?.querySelector(".transition-summary");
  if (!transition || !tile || !summary) return;
  tile.className = `transition-tile transition-${transition.mode}`;
  tile.classList.toggle("editing", Number(state.openTransitionFromSlot) === Number(fromSlot));
  summary.innerHTML = `
    <strong>${escapeHtml(transitionModeLabel(transition.mode))}</strong>
    <span>${escapeHtml(transitionPadSummary(transition))}</span>
    <small>${transitionDurationForMode(transition, transition.mode)}s</small>
  `;
}

function scheduleTransitionSave() {
  clearTimeout(state.transitionSaveTimer);
  state.transitionSaveTimer = setTimeout(saveTransitionSettings, 150);
}

async function saveTransitionSettings() {
  clearTimeout(state.transitionSaveTimer);
  state.transitionSaveTimer = null;
  if (state.transitionSaveInFlight) {
    state.transitionSavePending = true;
    return;
  }
  state.transitionSaveInFlight = true;
  try {
    const saved = await api("/api/setlist/current/transitions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitions: state.setlistTransitions })
    });
    state.setlistTransitions = normalizeClientTransitions(saved.transitions || [], state.setlist);
    state.setlistFingerprint = setFingerprintClient({
      slots: state.setlist.map((song, index) => song ? {
        slot: index + 1,
        songId: song.id,
        key: song.key,
        selectedKey: song.selectedKey,
        padKey: song.padKey,
        padFileName: song.padFileName,
        bpm: song.bpm,
        timeSignature: song.timeSignature
      } : { slot: index + 1, songId: null }),
      transitions: state.setlistTransitions
    });
    renderPlaybackState();
  } catch (error) {
    setAlert(`Transition save failed: ${error.message}`);
  } finally {
    state.transitionSaveInFlight = false;
    if (state.transitionSavePending) {
      state.transitionSavePending = false;
      await saveTransitionSettings();
    }
  }
}

function transitionModeLabel(mode) {
  return {
    "cue-next": "Cue Next",
    stay: "Stay",
    crossfade: "Crossfade"
  }[mode] || "Cue Next";
}

function transitionPadSummary(transition) {
  if (transition.continuePad === false || transition.padBehavior === "off") return "Pad Off";
  return {
    "hold-current-key": "Pad Holds",
    "next-song-key": "Pad -> Next",
    "crossfade-to-next-key": "Pad Xfade"
  }[transition.padBehavior] || "Pad -> Next";
}

function normalizeTransitionMode(mode, toSlot = true) {
  if (!toSlot) return "stay";
  if (mode === "overlap") return "crossfade";
  if (mode === "autolink") return "cue-next";
  return ["cue-next", "stay", "crossfade"].includes(mode) ? mode : "cue-next";
}

function transitionDurationKey(mode) {
  if (mode === "crossfade") return "crossfade";
  if (mode === "stay") return "stay";
  return "cueNext";
}

function defaultTransitionDurationForMode(mode) {
  if (mode === "crossfade") return 5;
  if (mode === "stay") return 0;
  return 0.25;
}

function normalizeTransitionDurationByMode(value = {}) {
  const legacy = value.durationSeconds;
  return {
    crossfade: normalizeTransitionDurationSeconds(value.crossfade ?? value.crossfadeSeconds ?? legacy, 5, 0.25),
    cueNext: normalizeTransitionDurationSeconds(value.cueNext ?? value.cueNextSeconds ?? legacy, 0.25, 0),
    stay: normalizeTransitionDurationSeconds(value.stay ?? value.staySeconds ?? legacy, 0, 0)
  };
}

function normalizeTransitionDurationByModeForMode(value = {}, mode = "cue-next") {
  if (value.durationByMode && typeof value.durationByMode === "object") {
    return normalizeTransitionDurationByMode(value.durationByMode);
  }
  const defaults = normalizeTransitionDurationByMode({});
  if (value.durationSeconds !== undefined) {
    defaults[transitionDurationKey(mode)] = normalizeTransitionDurationSeconds(
      value.durationSeconds,
      defaultTransitionDurationForMode(mode),
      mode === "crossfade" ? 0.25 : 0
    );
  }
  return defaults;
}

function transitionDurationForMode(transition = {}, mode = "") {
  const durations = normalizeTransitionDurationByMode(transition.durationByMode || transition);
  return durations[transitionDurationKey(mode)];
}

function normalizeTransitionDurationSeconds(value, fallback = 5, minimum = 0.25) {
  const number = Number(value);
  const selected = Number.isFinite(number) && number >= 0 ? number : fallback;
  return Math.max(minimum, Math.min(30, Math.round(selected * 4) / 4));
}

function normalizeClientTransitions(transitions, slots = state.setlist) {
  const existingByPair = new Map((Array.isArray(transitions) ? transitions : []).map((transition) => ({
    fromSlot: Number(transition.fromSlot || 0),
    toSlot: Number(transition.toSlot || 0) || null,
    mode: normalizeTransitionMode(transition.mode, transition.toSlot),
    padBehavior: transition.toSlot && ["off", "hold-current-key", "next-song-key", "crossfade-to-next-key"].includes(transition.padBehavior) ? transition.padBehavior : "off",
    durationByMode: normalizeTransitionDurationByModeForMode(transition, normalizeTransitionMode(transition.mode, transition.toSlot)),
    continuePad: transition.toSlot ? transition.continuePad !== false : false
  })).filter((transition) => transition.fromSlot)
    .map((transition) => ({
      ...transition,
      durationSeconds: transitionDurationForMode(transition, transition.mode)
    }))
    .map((transition) => [`${transition.fromSlot}:${transition.toSlot || 0}`, transition]));
  const filled = (Array.isArray(slots) ? slots : [])
    .map((slot, index) => slot && (slot.songId || slot.id) ? Number(slot.slot || index + 1) : 0)
    .filter(Boolean)
    .sort((a, b) => a - b);
  return filled.map((fromSlot, index) => {
    const toSlot = filled[index + 1] || null;
    return existingByPair.get(`${fromSlot}:${toSlot || 0}`) || {
      fromSlot,
      toSlot,
      mode: toSlot ? "cue-next" : "stay",
      padBehavior: toSlot ? "next-song-key" : "off",
      durationByMode: normalizeTransitionDurationByMode({}),
      durationSeconds: transitionDurationForMode({ durationByMode: normalizeTransitionDurationByMode({}) }, toSlot ? "cue-next" : "stay"),
      continuePad: Boolean(toSlot)
    };
  });
}

function setFingerprintClient(setlist) {
  const slots = (setlist?.slots || []).map((slot) => ({
    slot: Number(slot.slot || 0),
    songId: slot.songId || "",
    key: slot.selectedKey || slot.key || "",
    padKey: slot.padKey || "",
    padKeyOverride: slot.padKeyOverride || "",
    padFileName: slot.padFileName || "",
    bpm: slot.bpm || "",
    timeSignature: slot.timeSignature || ""
  }));
  const transitions = normalizeClientTransitions(setlist?.transitions || [], setlist?.slots || []).map((transition) => ({
    fromSlot: transition.fromSlot,
    toSlot: transition.toSlot,
    mode: transition.mode,
    padBehavior: transition.padBehavior,
    durationSeconds: transition.durationSeconds,
    durationByMode: transition.durationByMode,
    continuePad: transition.continuePad
  }));
  return JSON.stringify({ slots, transitions });
}

function selectSetlistSong(index, songId) {
  if (setlistSelectionLocked(index)) {
    setAlert("Pause or stop before selecting another song.");
    return;
  }
  state.selectedSetlistIndex = index;
  state.selectedMetadataSlot = index + 1;
  state.selectedRegionIndex = null;
  state.selectedCueIndex = null;
  state.regionSketch = null;
  if (state.playbackState?.mode === "performance") {
    setAlert("");
    state.loadedSong = null;
  } else {
    loadSong(songId);
  }
  syncSelectedSlotToPlayback(index + 1);
  renderMetadataSlotOptions();
  renderSelectedMetadata();
  renderSetlist();
}

async function syncSelectedSlotToPlayback(slotNumber) {
  const selectedSlot = Number(slotNumber || 0);
  if (!selectedSlot || state.playbackState?.currentSlot === selectedSlot) return;
  try {
    const result = await api("/api/playback/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "selectSlot",
        slot: selectedSlot,
        source: "main-app-selection"
      })
    });
    state.playbackState = result.state;
    if (!result.accepted) {
      setAlert(result.reason || "Song selection was not accepted.");
      return;
    }
    renderPlaybackState();
  } catch (error) {
    setAlert(`Selection sync failed: ${error.message}`);
  }
}

function setlistSelectionLocked(index) {
  return state.playbackState?.transport === "playing" && state.playbackState?.currentSlot !== index + 1;
}

function songActionMenu(index, song) {
  const menu = document.createElement("div");
  menu.className = "song-action-menu";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit Song";
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    selectSetlistSong(index, song.id);
  });

  const playbackKey = document.createElement("button");
  playbackKey.type = "button";
  playbackKey.textContent = "Playback Key";
  playbackKey.addEventListener("click", (event) => {
    event.stopPropagation();
    selectSetlistSong(index, song.id);
    els.playbackKeySelect?.focus();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeSongAt(index);
    renderSetlist();
    scheduleSetlistSave();
  });

  menu.append(edit, playbackKey, remove);
  return menu;
}

function openAddSongModal(index) {
  if (state.playbackState?.mode === "performance") {
    setAlert("Set locked in Performance.");
    els.playbackStatus.textContent = "Set locked in Performance.";
    return;
  }
  state.addSongTargetIndex = index;
  els.addSongModal.classList.remove("hidden");
  els.search.focus();
}

function closeAddSongModal() {
  state.addSongTargetIndex = null;
  els.addSongModal.classList.add("hidden");
}

async function addSelectedSongToSet() {
  if (state.playbackState?.mode === "performance") return;
  if (state.addSongInFlight) return;
  const songId = els.select.value;
  if (!songId || state.addSongTargetIndex === null) return;
  const targetIndex = state.addSongTargetIndex;
  state.addSongInFlight = true;
  els.addSelectedSong.disabled = true;
  try {
    const song = await api(`/api/songs/${encodeURIComponent(songId)}`);
    insertSongAt(targetIndex, setlistSongFromLoadedSong(song));
    state.selectedMetadataSlot = targetIndex + 1;
    state.loadedSong = song;
    await saveCurrentSetlist();
    renderLoadedSong();
    await loadSetMetadata();
    closeAddSongModal();
  } catch (error) {
    setAlert(`Could not add song: ${error.message}`);
  } finally {
    state.addSongInFlight = false;
    els.addSelectedSong.disabled = false;
  }
}

function handleSlotDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
}

function handleSlotDragLeave(event) {
  event.currentTarget.classList.remove("drag-over");
}

async function handleSlotDrop(event) {
  event.preventDefault();
  if (state.playbackState?.mode === "performance") return;
  const slot = event.currentTarget;
  slot.classList.remove("drag-over");
  const targetIndex = Number(slot.dataset.index);
  const librarySongId = event.dataTransfer.getData("application/x-library-song-id");
  const sourceIndexText = event.dataTransfer.getData("application/x-setlist-index");

  if (librarySongId) {
    try {
      const song = await api(`/api/songs/${encodeURIComponent(librarySongId)}`);
      insertSongAt(targetIndex, setlistSongFromLoadedSong(song));
      state.loadedSong = song;
      state.selectedMetadataSlot = targetIndex + 1;
      await saveCurrentSetlist();
      renderLoadedSong();
      await loadSetMetadata();
    } catch (error) {
      setAlert(`Could not load song for setlist: ${error.message}`);
    }
    return;
  }

  if (sourceIndexText !== "") {
    const sourceIndex = Number(sourceIndexText);
    moveSongTo(sourceIndex, targetIndex);
  }
}

async function clearSetlist() {
  if (state.playbackState?.mode === "performance") return;
  if (!window.confirm("Clear the current setlist?")) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.setlist = Array(6).fill(null);
  state.setlistTransitions = [];
  state.selectedSetlistIndex = null;
  state.selectedMetadataSlot = null;
  state.setMetadata = { slots: [] };
  state.loadedSong = null;
  state.timelineZoom = 1;
  state.timelineZoomSlot = null;
  renderLoadedSong();
  renderSetlist();
  renderSelectedMetadata();
  try {
    await saveCurrentSetlist();
  } catch (error) {
    setAlert(`Clear setlist failed: ${error.message}`);
  }
}

function setlistSongFromLoadedSong(song) {
  return {
    id: song.id,
    title: song.title,
    vendor: song.vendor,
    folderPath: song.folderPath,
    key: song.key || "",
    originalKey: song.key || "",
    selectedKey: canonicalKey(song.key || ""),
    transposeCents: 0,
    padKey: canonicalKey(song.padKey || song.key || ""),
    padKeyOverride: "",
    padFileName: "",
    bpm: song.bpm || null,
    timeSignature: song.timeSignature || "",
    trackCount: song.trackCount || null,
    cacheStatus: song.cacheStatus || "",
    cacheFolder: song.cacheFolder || "",
    cachedTrackCount: song.cachedTrackCount || null,
    cachedAt: song.cachedAt || "",
    readinessState: song.readinessState || "",
    missingStems: song.missingStems || [],
    cachedStems: song.cachedStems || []
  };
}

function insertSongAt(index, song) {
  const next = state.setlist.slice();
  next.splice(index, 0, song);
  state.setlist = trimTrailingEmptySlots(next);
  state.selectedSetlistIndex = index;
  state.selectedMetadataSlot = index + 1;
  renderSetlist();
  scheduleSetlistSave();
}

function moveSongTo(sourceIndex, targetIndex) {
  if (sourceIndex === targetIndex) return;
  const next = state.setlist.slice();
  const [song] = next.splice(sourceIndex, 1);
  if (!song) return;
  next.splice(targetIndex, 0, song);
  state.setlist = trimTrailingEmptySlots(next);
  renderSetlist();
  scheduleSetlistSave();
}

function trimTrailingEmptySlots(slots) {
  const next = slots.slice();
  while (next.length > 6 && next[next.length - 1] === null) {
    next.pop();
  }
  while (next.length < 6) next.push(null);
  return next;
}

function removeSongAt(index) {
  const next = state.setlist.slice();
  next[index] = null;
  state.setlist = trimTrailingEmptySlots(next);
  if (state.selectedSetlistIndex === index) {
    state.selectedSetlistIndex = null;
    state.selectedMetadataSlot = null;
    state.loadedSong = null;
    renderLoadedSong();
  }
  renderSetlist();
  saveCurrentSetlist().catch((error) => {
    setAlert(`Setlist remove failed: ${error.message}`);
  });
}

function setlistMetaText(song) {
  const key = canonicalKey(song.selectedKey || song.key || "") || "--";
  const bpm = song.bpm ? `${song.bpm} BPM` : "-- BPM";
  return `${key} | ${bpm}`;
}

function keyOptions() {
  return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
}

function populatePlaybackKeySelect() {
  if (!els.playbackKeySelect) return;
  els.playbackKeySelect.replaceChildren();
  for (const key of keyOptions()) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    els.playbackKeySelect.append(option);
  }
}

function populatePlaybackPadSelect() {
  if (!els.playbackPadSelect) return;
  els.playbackPadSelect.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto";
  els.playbackPadSelect.append(auto);
  for (const pad of state.padOptions || []) {
    const option = document.createElement("option");
    option.value = pad.fileName || "";
    option.textContent = pad.label || pad.fileName || "";
    els.playbackPadSelect.append(option);
  }
}

function holdPlaybackKeyEditor() {
  state.playbackKeyInteractionUntil = Date.now() + 5000;
}

function playbackKeyEditorHeld() {
  const active = document.activeElement;
  return active === els.playbackKeySelect
    || active === els.playbackPadSelect
    || Date.now() < state.playbackKeyInteractionUntil;
}

function renderPlaybackKeyEditor(selected) {
  if (!els.playbackKeySelect) return;
  const setlistSong = selected?.slot ? state.setlist[Number(selected.slot) - 1] : null;
  const key = canonicalKey(setlistSong?.selectedKey || setlistSong?.key || selected?.tempoMap?.key || "");
  const originalKey = canonicalKey(setlistSong?.originalKey || selected?.tempoMap?.key || key || "");
  const transposeCents = Number(setlistSong?.transposeCents || 0);
  const held = playbackKeyEditorHeld();
  if (!held) {
    els.playbackKeySelect.value = keyOptions().includes(key) ? key : "";
  }
  if (els.playbackPadSelect && !held) {
    const padFileName = setlistSong?.padFileName || "";
    const hasPadFile = !padFileName || [...els.playbackPadSelect.options].some((option) => option.value === padFileName);
    els.playbackPadSelect.value = hasPadFile ? padFileName : "";
  }
  const disabled = !selected || state.playbackState?.mode === "performance";
  if (!held || disabled) {
    els.playbackKeySelect.disabled = disabled;
  }
  if (els.playbackPadSelect && (!held || disabled)) els.playbackPadSelect.disabled = disabled;
  if (els.playbackKeyOriginal) els.playbackKeyOriginal.textContent = `Original: ${originalKey || "--"}`;
  if (els.playbackKeyTranspose) els.playbackKeyTranspose.textContent = `Transpose: ${transposeCents} cents`;
  if (els.playbackPadStatus) {
    const padMode = setlistSong?.padFileName
      ? `Manual: ${setlistSong.padFileName}`
      : `Auto: ${canonicalKey(setlistSong?.padKey || key || "") || "--"}`;
    els.playbackPadStatus.textContent = selected ? `Pad: ${padMode}` : "Pad: select a song";
  }
  if (els.playbackKeyStatus) {
    const padKey = canonicalKey(setlistSong?.padKey || key || "");
    els.playbackKeyStatus.textContent = selected
      ? `Dynamic pad follows ${padKey || "--"}. Confirm set after a key change.`
      : "Select a song to change playback key.";
  }
}

function canonicalKey(value) {
  const normalized = String(value || "").trim().replace(/\u266d/g, "b").replace(/\u266f/g, "#");
  const aliases = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
  return aliases[normalized] || normalized;
}

async function updateSetlistSongKey(index, selectedKey) {
  const song = state.setlist[index];
  if (!song || state.playbackState?.mode === "performance") return;
  try {
    setAlert(`Preparing ${song.title} in ${selectedKey}...`);
    const saved = await api(`/api/setlist/slot/${index + 1}/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: selectedKey })
    });
    state.setlist = saved.slots.map((slot) => slot.songId ? setlistSongFromSlot(slot) : null);
    state.setlistTransitions = normalizeClientTransitions(saved.transitions || state.setlistTransitions);
    await loadPlaybackState();
    await loadCacheReport();
    await loadSetMetadata();
    renderSetlist();
    renderSelectedMetadata();
    renderLoadedSong();
    setAlert(`Prepared ${song.title} in ${selectedKey}. Confirm set before Performance.`);
  } catch (error) {
    setAlert(`Key change failed: ${error.message}`);
    renderSetlist();
  }
}

async function updateSetlistSongBpm(index, selectedBpm) {
  const song = state.setlist[index];
  if (!song || state.playbackState?.mode === "performance") return;
  try {
    setAlert(`Preparing ${song.title} at ${selectedBpm} BPM...`);
    const saved = await api(`/api/setlist/slot/${index + 1}/bpm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bpm: selectedBpm })
    });
    state.setlist = saved.slots.map((slot) => slot.songId ? setlistSongFromSlot(slot) : null);
    state.setlistTransitions = normalizeClientTransitions(saved.transitions || state.setlistTransitions);
    await loadPlaybackState();
    await loadCacheReport();
    await loadSetMetadata();
    renderSetlist();
    renderSelectedMetadata();
    renderLoadedSong();
    setAlert(`Prepared ${song.title} at ${selectedBpm} BPM. Confirm set before Performance.`);
  } catch (error) {
    setAlert(`BPM change failed: ${error.message}`);
    renderSetlist();
    throw error;
  }
}

async function updateSetlistSongPad(index, padFileName) {
  const song = state.setlist[index];
  if (!song || state.playbackState?.mode === "performance") return;
  try {
    const label = padFileName || "Auto";
    setAlert(`Saving pad selection: ${label}...`);
    const saved = await api(`/api/setlist/slot/${index + 1}/pad`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padFileName, auto: !padFileName })
    });
    state.setlist = saved.slots.map((slot) => slot.songId ? setlistSongFromSlot(slot) : null);
    state.setlistTransitions = normalizeClientTransitions(saved.transitions || state.setlistTransitions);
    await loadPlaybackState();
    await loadCacheReport();
    await loadSetMetadata();
    renderSetlist();
    renderSelectedMetadata();
    renderLoadedSong();
    setAlert(`Pad selection saved for ${song.title}. Confirm set before Performance.`);
  } catch (error) {
    setAlert(`Pad selection failed: ${error.message}`);
    renderSelectedMetadata();
  }
}

function renderMixerStrip(selected) {
  if (!els.mixerStrip) return;
  els.mixerStrip.replaceChildren();
  if (!selected) {
    els.mixerStrip.append(emptyState("Select a setlist song to show stems."));
    return;
  }
  const stems = selected.mixer?.stems || [];
  if (!stems.length) {
    els.mixerStrip.append(emptyState("No stems found for selected song."));
    return;
  }
  const locked = false;
  const preset = activeRoutingPreset();
  const summary = document.createElement("div");
  summary.className = "mixer-summary";
  summary.innerHTML = `
    <strong>${escapeHtml(selected.title || "Selected song")}</strong>
    <span>${stems.length} stems | ${escapeHtml(preset?.name || "No routing preset")}</span>
  `;
  els.mixerStrip.append(summary);

  for (const [index, stem] of stems.entries()) {
    const name = stem.name || stem.fileName || "Stem";
    const route = canonicalRoute(stem.routeBus || classifyClientStem(name));
    const volume = clamp(Number(stem.volume ?? 80), 0, 100);
    const faderPosition = mixerFaderPositionFromVolume(volume);
    const canSendToIem = route === "tracks";
    const meterLevel = meterPercentForStem(stem);
    const channel = document.createElement("div");
    channel.className = `mixer-channel route-${route}`;
    channel.innerHTML = `
      <div class="mixer-peak-label">-inf</div>
      <div class="channel-topline">
        <button type="button" class="mute-button ${stem.mute ? "active" : ""}" data-mixer-index="${index}" ${locked ? "disabled" : ""} aria-pressed="${stem.mute ? "true" : "false"}" aria-label="Mute ${escapeAttr(name)} and its IEM send">M</button>
        <button type="button" class="solo-button ${stem.solo ? "active" : ""}" data-mixer-index="${index}" ${locked ? "disabled" : ""} aria-pressed="${stem.solo ? "true" : "false"}" aria-label="Solo ${escapeAttr(name)} and its IEM send">S</button>
        <button type="button" class="iem-button ${stem.iemSend && canSendToIem ? "active" : ""}" data-mixer-index="${index}" ${locked || !canSendToIem ? "disabled" : ""} aria-label="Send ${escapeAttr(name)} to IEM" title="${canSendToIem ? "Send instrument to IEM" : "IEM is instruments only"}">IEM</button>
      </div>
      <div class="mixer-fader-area">
        <div class="meter-track" aria-hidden="true"><div class="meter-fill" data-meter-stem-id="${escapeAttr(stem.id)}" style="height: ${meterLevel}%"></div></div>
        <input type="range" min="0" max="100" value="${escapeAttr(faderPosition)}" orient="vertical" data-mixer-index="${index}" ${locked ? "disabled" : ""} aria-label="${escapeAttr(name)} volume" title="Double-click for 75% output at midpoint">
        <span class="volume-readout" data-volume-readout="${index}">${volume}</span>
      </div>
      <select class="stem-route-select" data-mixer-index="${index}" ${locked ? "disabled" : ""} aria-label="${escapeAttr(name)} bus">
        ${stemRouteOptions(route)}
      </select>
      <strong title="${escapeAttr(name)}">${escapeHtml(cleanStemLabel(name))}</strong>
      <div class="channel-number">${index + 1}</div>
    `;
    channel.querySelector(".mute-button")?.addEventListener("click", toggleStemMute);
    channel.querySelector(".solo-button")?.addEventListener("click", toggleStemSolo);
    channel.querySelector(".iem-button")?.addEventListener("click", toggleStemIemSend);
    channel.querySelector("input")?.addEventListener("input", updateStemVolume);
    channel.querySelector("input")?.addEventListener("dblclick", resetStemFaderToReference);
    channel.querySelector("select")?.addEventListener("change", updateStemRoute);
    els.mixerStrip.append(channel);
  }
}

function meterPercentForStem(stem) {
  const meters = state.mixerMeters?.stems || [];
  const match = meters.find((meter) => meter.id === stem.id);
  if (!match || state.playbackState?.transport !== "playing") return 0;
  return meterDisplayPercent(match.level);
}

function meterDisplayPercent(level) {
  const value = clamp(Number(level || 0), 0, 1);
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  return Math.round(clamp((db + 60) / 66, 0, 1) * 100);
}

async function refreshMixerMeters() {
  if (state.playbackState?.transport !== "playing") {
    if (state.mixerMeters?.active) {
      state.mixerMeters = null;
      updateMixerMeterDisplays();
    }
    return;
  }
  try {
    state.mixerMeters = await api("/api/playback/meters");
    updateMixerMeterDisplays();
  } catch {
    // Meter polling should never interrupt playback controls.
  }
}

function startMixerMeterStream() {
  if (typeof EventSource === "undefined") return;
  if (state.mixerMeterStream) return;
  state.mixerMeterStream = new EventSource("/api/playback/meter-stream");
  state.mixerMeterStream.addEventListener("meters", (event) => {
    try {
      state.mixerMeters = JSON.parse(event.data);
      updateMixerMeterDisplays();
    } catch {
      // Ignore malformed meter packets.
    }
  });
  state.mixerMeterStream.onerror = () => {
    if (state.mixerMeterStream?.readyState === EventSource.CLOSED) {
      state.mixerMeterStream = null;
    }
  };
}

function updateMixerMeterDisplays() {
  if (!els.mixerStrip) return;
  const meterMap = new Map((state.mixerMeters?.stems || []).map((meter) => [meter.id, meter]));
  els.mixerStrip.querySelectorAll("[data-meter-stem-id]").forEach((fill) => {
    const meter = meterMap.get(fill.dataset.meterStemId);
    const level = state.playbackState?.transport === "playing" && meter
      ? meterDisplayPercent(meter.level)
      : 0;
    fill.style.height = `${level}%`;
    fill.classList.toggle("meter-active", level > 0);
  });
}

function updateStemVolume(event) {
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.target.dataset.mixerIndex)];
  if (!stem) return;
  stem.volume = mixerVolumeFromFaderPosition(event.target.value);
  const readout = event.target.closest(".mixer-channel")?.querySelector(".volume-readout");
  if (readout) readout.textContent = String(stem.volume);
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

function resetStemFaderToReference(event) {
  event.preventDefault();
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.currentTarget.dataset.mixerIndex)];
  if (!stem) return;
  event.currentTarget.value = "50";
  stem.volume = 75;
  const readout = event.currentTarget.closest(".mixer-channel")?.querySelector(".volume-readout");
  if (readout) readout.textContent = "75";
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

function mixerVolumeFromFaderPosition(value) {
  const position = clamp(Number(value), 0, 100);
  const volume = position <= 50
    ? position * 1.5
    : 75 + ((position - 50) * 0.5);
  return Math.round(clamp(volume, 0, 100));
}

function mixerFaderPositionFromVolume(value) {
  const volume = clamp(Number(value), 0, 100);
  const position = volume <= 75
    ? volume / 1.5
    : 50 + ((volume - 75) * 2);
  return Math.round(clamp(position, 0, 100));
}

function toggleStemMute(event) {
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.currentTarget.dataset.mixerIndex)];
  if (!stem) return;
  stem.mute = !stem.mute;
  renderMixerStrip(selected);
  renderBusLayer();
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

function toggleStemSolo(event) {
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.currentTarget.dataset.mixerIndex)];
  if (!stem) return;
  stem.solo = !stem.solo;
  renderMixerStrip(selected);
  renderBusLayer();
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

function toggleStemIemSend(event) {
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.currentTarget.dataset.mixerIndex)];
  if (!stem) return;
  if (canonicalRoute(stem.routeBus || stem.role || classifyClientStem(stem.name || stem.fileName)) !== "tracks") return;
  stem.iemSend = !stem.iemSend;
  renderMixerStrip(selected);
  renderBusLayer();
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

function updateStemRoute(event) {
  const selected = selectedMetadata();
  const stem = selected?.mixer?.stems?.[Number(event.target.dataset.mixerIndex)];
  if (!stem) return;
  stem.routeBus = event.target.value;
  if (canonicalRoute(stem.routeBus) !== "tracks") stem.iemSend = false;
  renderMixerStrip(selected);
  renderBusLayer();
  sendLiveMixerUpdate(selected);
  scheduleMixerAutosave();
}

async function sendLiveMixerUpdate(selected) {
  if (!selected?.slot || state.playbackState?.currentSlot !== selected.slot || !["playing", "paused"].includes(state.playbackState?.transport)) return;
  if (state.liveMixerInFlight) {
    state.liveMixerPending = true;
    return;
  }
  state.liveMixerInFlight = true;
  try {
    await api("/api/playback/live-mixer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: selected.slot, mixer: selected.mixer })
    });
  } catch {
    // Live fader moves should never freeze the mixer surface.
  } finally {
    state.liveMixerInFlight = false;
    if (state.liveMixerPending) {
      state.liveMixerPending = false;
      sendLiveMixerUpdate(selectedMetadata());
    }
  }
}

function stemRouteOptions(selectedValue) {
  const selectedRoute = canonicalRoute(selectedValue);
  return ["tracks", "click", "cues", "pads", "dynamicCue"].map((value) => {
    const selected = value === selectedRoute ? "selected" : "";
    return `<option value="${escapeAttr(value)}" ${selected}>${escapeHtml(routeLabel(value))}</option>`;
  }).join("");
}

function canonicalRoute(value) {
  if (value === "music") return "tracks";
  if (value === "cue") return "cues";
  return value;
}

function routeLabel(value) {
  const labels = {
    music: "Tracks",
    tracks: "Tracks",
    click: "Click",
    cue: "Guide",
    cues: "Guide",
    pads: "Pads",
    dynamicCue: "Dynamic Cue",
    iem: "IEM"
  };
  return labels[value] || value;
}

function cleanStemLabel(name) {
  return String(name || "Stem")
    .replace(/\.wav$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function loadSavedMixerHeight() {
  state.mixerPanelHeightMode = state.playbackState?.mode || "edit";
  const key = mixerHeightStorageKey();
  const saved = Number(window.localStorage?.getItem(key) || window.localStorage?.getItem("playbackV2.mixerPanelHeight") || 0);
  state.mixerPanelHeight = saved > 0 ? saved : null;
  applyMixerPanelHeight();
}

function syncMixerHeightForMode() {
  const mode = state.playbackState?.mode || "edit";
  if (state.mixerPanelHeightMode === mode) return;
  state.mixerPanelHeightMode = mode;
  const saved = Number(window.localStorage?.getItem(mixerHeightStorageKey()) || 0);
  state.mixerPanelHeight = saved > 0 ? saved : null;
}

function mixerHeightStorageKey() {
  return state.playbackState?.mode === "performance"
    ? "playbackV2.mixerPanelHeight.performance"
    : "playbackV2.mixerPanelHeight.edit";
}

function defaultMixerPanelHeight() {
  const isPerformance = state.playbackState?.mode === "performance";
  const viewportHeight = window.innerHeight || 800;
  return isPerformance
    ? Math.round(clamp(viewportHeight * 0.38, 320, 540))
    : Math.round(clamp(viewportHeight * 0.24, 170, 230));
}

function mixerPanelHeightBounds() {
  const viewportHeight = window.innerHeight || 800;
  const isPerformance = state.playbackState?.mode === "performance";
  return {
    min: isPerformance ? 220 : 150,
    max: Math.max(240, viewportHeight - 190)
  };
}

function applyMixerPanelHeight() {
  syncMixerHeightForMode();
  const bounds = mixerPanelHeightBounds();
  const height = Math.round(clamp(state.mixerPanelHeight || defaultMixerPanelHeight(), bounds.min, bounds.max));
  document.documentElement.style.setProperty("--mixer-panel-height", `${height}px`);
}

function resetMixerHeightForCurrentMode() {
  state.mixerPanelHeight = null;
  window.localStorage?.removeItem(mixerHeightStorageKey());
  applyMixerPanelHeight();
  setAlert("Mixer height reset.");
}

function beginMixerResize(event) {
  if (state.mixerCollapsed) return;
  event.preventDefault();
  els.mixerResizeHandle.setPointerCapture?.(event.pointerId);
  const onMove = (moveEvent) => {
    const bounds = mixerPanelHeightBounds();
    state.mixerPanelHeight = Math.round(clamp(window.innerHeight - moveEvent.clientY, bounds.min, bounds.max));
    applyMixerPanelHeight();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.localStorage?.setItem(mixerHeightStorageKey(), String(state.mixerPanelHeight || ""));
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function scheduleMixerAutosave() {
  const selected = selectedMetadata();
  if (!selected) return;
  clearTimeout(state.mixerSaveTimer);
  state.mixerSaveTimer = setTimeout(saveSelectedMixer, 250);
}

async function saveSelectedMixer() {
  const selected = selectedMetadata();
  if (!selected) return;
  state.setMetadata = await api(`/api/set-metadata/current/slot/${selected.slot}/mixer`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mixer: selected.mixer })
  });
  renderMetadataSlotOptions();
}

function classifyClientStem(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("click")) return "click";
  if (text.includes("cue") || text.includes("guide")) return "cue";
  if (text.includes("pad")) return "pads";
  return "music";
}

function toggleMixerCollapse() {
  state.mixerCollapsed = !state.mixerCollapsed;
  document.body.classList.toggle("mixer-collapsed", state.mixerCollapsed);
  els.mixerCollapse.textContent = state.mixerCollapsed ? "Expand" : "Collapse";
}

function handleKeyboardShortcuts(event) {
  if (isTextEditingEvent(event)) return;
  if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
    event.preventDefault();
    reloadAppData();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoLastCueMove();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    splitSelectedRegionAtPlayhead();
    return;
  }
  if (event.key === "Escape") {
    closeAddSongModal();
    closeSettingsDrawer();
    hideRegionMenu();
    state.openTransitionFromSlot = null;
    document.querySelectorAll(".transition-tile.editing").forEach((item) => item.classList.remove("editing"));
    state.selectedCueIndex = null;
    renderSelectedMetadata();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selectedCueIndex !== null) {
      event.preventDefault();
      deleteSelectedCue();
      return;
    }
    if (state.selectedRegionIndex !== null) {
      event.preventDefault();
      if (event.key === "Delete" && state.selectedArrangedRegionRange?.blockId) removeSelectedRegionAndCloseGap();
      else deleteSelectedRegion();
      return;
    }
  }
  if (event.key === " ") {
    event.preventDefault();
    sendPlaybackCommand(state.playbackState?.transport === "playing" ? "pause" : "play");
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    const song = state.setlist[index];
    if (song) selectSetlistSong(index, song.id);
  }
}

function isTextEditingEvent(event) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches("input, select, textarea, [contenteditable=\"true\"]")) return true;
  if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea, [contenteditable=\"true\"]")) return true;
  return event.composedPath?.().some((item) => item instanceof HTMLElement && item.matches?.("input, select, textarea, [contenteditable=\"true\"]"));
}

function scheduleSetlistSave() {
  if (state.playbackState?.mode === "performance") return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentSetlist, 250);
}

async function saveCurrentSetlist() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (state.playbackState?.mode === "performance") return;
  if (state.setlistSaveInFlight) {
    state.setlistSavePending = true;
    return;
  }
  state.setlistSaveInFlight = true;
  const slots = state.setlist.map((song, index) => {
    if (!song) return { slot: index + 1, songId: null };
    return {
      slot: index + 1,
      songId: song.id,
      title: song.title,
      vendor: song.vendor,
      folderPath: song.folderPath,
      key: song.key || "",
      originalKey: song.originalKey || song.key || "",
      selectedKey: canonicalKey(song.selectedKey || song.key || ""),
      transposeCents: Number(song.transposeCents || 0),
      padKey: canonicalKey(song.padKey || song.selectedKey || song.key || ""),
      padKeyOverride: canonicalKey(song.padKeyOverride || ""),
      padFileName: song.padFileName || "",
      bpm: song.bpm || null,
      timeSignature: song.timeSignature || "",
      trackCount: song.trackCount || null
    };
  });

  try {
    const saved = await api("/api/setlist/current", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots, transitions: state.setlistTransitions })
    });
    if (!state.setlistSavePending) {
      state.setlist = saved.slots.map((slot) => slot.songId ? setlistSongFromSlot(slot) : null);
      state.setlistTransitions = normalizeClientTransitions(saved.transitions || []);
      state.setlistFingerprint = setFingerprintClient(saved);
      await loadPlaybackState();
      state.playbackSetFingerprint = state.playbackState?.currentFingerprint || "";
      await loadCacheReport();
      await loadSetMetadata();
      renderSetlist();
      renderLoadedSong();
    }
  } finally {
    state.setlistSaveInFlight = false;
    if (state.setlistSavePending) {
      state.setlistSavePending = false;
      await saveCurrentSetlist();
    }
  }
}

function setlistSongFromSlot(slot) {
  return {
    id: slot.songId,
    title: slot.title || "",
    vendor: slot.vendor || "",
    folderPath: slot.folderPath || "",
    key: slot.key || "",
    originalKey: slot.originalKey || slot.key || "",
    selectedKey: canonicalKey(slot.selectedKey || slot.key || ""),
    transposeCents: Number(slot.transposeCents || 0),
    padKey: canonicalKey(slot.padKey || slot.selectedKey || slot.key || ""),
    padKeyOverride: canonicalKey(slot.padKeyOverride || ""),
    padFileName: slot.padFileName || "",
    bpm: slot.bpm || null,
    originalBpm: slot.originalBpm || slot.bpm || null,
    selectedBpm: slot.selectedBpm || slot.bpm || null,
    tempoRatio: Number(slot.tempoRatio || 1),
    bpmOverride: Boolean(slot.bpmOverride),
    timeSignature: slot.timeSignature || "",
    trackCount: slot.trackCount || null,
    cacheStatus: slot.cacheStatus || "",
    cacheFolder: slot.cacheFolder || "",
    cachedTrackCount: slot.cachedTrackCount || null,
    cachedAt: slot.cachedAt || "",
    keyChangeCache: slot.keyChangeCache || null,
    readinessState: slot.readinessState || "",
    missingStems: slot.missingStems || [],
    cachedStems: slot.cachedStems || []
  };
}

function readinessClass(song) {
  const stateValue = song?.readinessState || song?.cacheStatus || "not-cached";
  if (stateValue === "ready" || stateValue === "cached") return "ready";
  if (stateValue === "warning" || stateValue === "cached-with-warnings") return "warning";
  if (stateValue.includes?.("failed") || stateValue === "missing-source") return "failed";
  return "not-cached";
}

function readinessLabel(song) {
  const stateValue = song?.readinessState || song?.cacheStatus || "";
  if (stateValue === "ready" || stateValue === "cached") return "Ready";
  if (stateValue === "warning" || stateValue === "cached-with-warnings") return "Warning";
  if (stateValue.includes?.("failed") || stateValue === "missing-source") return "Failed";
  return "Not cached";
}

function renderTabCounts() {
  const songs = state.library?.songs || [];
  const counts = {
    All: songs.length,
    "Loop Community": songs.filter((song) => song.vendor === "Loop Community").length,
    Multitracks: songs.filter((song) => song.vendor === "Multitracks").length
  };

  for (const tab of els.tabs) {
    const vendor = tab.dataset.vendor;
    tab.textContent = `${vendor} (${counts[vendor] || 0})`;
  }
}

function renderSkippedFolders() {
  const skipped = state.library?.skipped || [];
  els.skippedSummary.textContent = `Skipped Folders (${skipped.length})`;
  els.skippedFolders.replaceChildren();

  if (!skipped.length) {
    const item = document.createElement("div");
    item.className = "skipped-item";
    item.textContent = "No skipped folders.";
    els.skippedFolders.append(item);
    return;
  }

  for (const folder of skipped) {
    const item = document.createElement("div");
    item.className = "skipped-item";
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = folder.folderPath;
    detail.textContent = folder.reason;
    item.append(title, detail);
    els.skippedFolders.append(item);
  }
}

function renderLoadedSong() {
  const { song, setlistSong } = displaySongContext();
  if (!song) {
    els.songTitle.textContent = "None";
    els.songMeta.textContent = "Choose a song from the setlist.";
    els.songDetails.classList.add("hidden");
    els.songDetails.replaceChildren();
    setAlert("");
    return;
  }
  const trackCount = song.trackCount || setlistSong?.trackCount || setlistSong?.cachedTrackCount || 0;
  els.songTitle.textContent = song.title;
  const timeSignature = song.timeSignature || setlistSong?.timeSignature || "--";
  els.songMeta.textContent = `${setlistMetaText(song)} | ${timeSignature} | ${trackCount} WAV file${trackCount === 1 ? "" : "s"}`;
  renderSongDetails(song);

  if (song.duplicateWarnings?.length) {
    setAlert(song.duplicateWarnings.map((warning) => {
      return `${warning.message}: ${warning.paths.join(", ")}`;
    }).join("\n"));
  }

}

function displaySongContext() {
  const visualSlot = playbackVisualSlot();
  const selectedIndex = visualSlot
    ? visualSlot - 1
    : state.selectedSetlistIndex;
  const setlistSong = selectedIndex === null || selectedIndex === undefined ? null : state.setlist[selectedIndex] || null;
  return {
    song: setlistSong || state.loadedSong,
    setlistSong
  };
}

function renderSongDetails(song) {
  const context = displaySongContext();
  const setlistSong = context.setlistSong;
  const selected = selectedMetadata();
  const metadataVersion = selected?.metadataVersion || setlistSong?.metadataVersionInfo || song.metadataVersionInfo || {};
  const details = [
    ["Vendor", song.vendor || setlistSong?.vendor || "--"],
    ["Time Sig", song.timeSignature || setlistSong?.timeSignature || "--"],
    ["WAVs", song.trackCount || setlistSong?.trackCount || "--"],
    ["Metadata", metadataVersionLabel(metadataVersion)],
    ["Analyzed", formatMetadataDate(metadataVersion.analysisUpdatedAt || metadataVersion.analysisCreatedAt)],
    ["Imported", formatMetadataDate(metadataVersion.importedAt)],
    ["Fingerprint", shortFingerprint(metadataVersion.fingerprint)],
    ["Cache", setlistSong?.cacheStatus || "Not prepared"],
    ["Cached WAVs", setlistSong?.cachedTrackCount || "--"],
    ["Readiness", readinessLabel(setlistSong || song)],
    ["Missing Stems", setlistSong?.missingStems?.length || 0],
    ["Warnings", song.duplicateWarnings?.length ? `! ${song.duplicateWarnings.length}` : "Clear"]
  ];
  els.songDetails.replaceChildren();
  for (const [label, value] of details) {
    const item = document.createElement("div");
    item.className = "song-detail";
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    els.songDetails.append(item);
  }
  els.songDetails.classList.remove("hidden");
}

function metadataVersionLabel(value = {}) {
  return value.version ? `Analyzer ${value.version}` : "--";
}

function shortFingerprint(value) {
  const text = String(value || "");
  return text ? text.slice(0, 10) : "--";
}

function formatMetadataDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function filteredSongs() {
  const needle = state.search.trim().toLowerCase();
  return (state.library?.songs || []).filter((song) => {
    const vendorMatch = state.activeVendor === "All" || song.vendor === state.activeVendor;
    const searchMatch = !needle || song.title.toLowerCase().includes(needle);
    return vendorMatch && searchMatch;
  });
}

function setBusy(message) {
  els.status.textContent = message;
  els.refresh.disabled = true;
}

function setAlert(message) {
  els.alert.textContent = message;
  els.alert.classList.toggle("hidden", !message);
}

function titleCase(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeAttr(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtml(value) {
  return escapeAttr(value);
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}


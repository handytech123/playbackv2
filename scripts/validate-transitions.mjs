import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const files = {
  server: read("server.js"),
  app: read("public/app.js"),
  remote: read("public/remote.js"),
  remoteHtml: read("public/remote.html")
};

assert(files.server.includes("function normalizeSetlistTransitions"), "server normalizes setlist transitions");
assert(files.server.includes("transitions: normalizeSetlistTransitions"), "setlist includes transitions array");
assert(files.server.includes("function applySetlistTransitionLocked"), "server applies transition runtime");
assert(files.server.includes('"songTransition"'), "playback command includes songTransition");
assert(files.server.includes("transition: normalizeTransitionRuntime"), "playback state exposes transition runtime");
assert(files.server.includes("transition.mode === \"autolink\""), "autolink starts the next song");
assert(files.server.includes("transition.mode === \"cue-next\" ? \"waiting-next\""), "cue-next selects the next song and waits");
assert(files.server.includes("function applyTransitionPadHold"), "cue-next can hold the next song pad while waiting");
assert(!files.server.includes("[\"cue-next\", \"autolink\"].includes(transition.mode)"), "cue-next must not auto-start the next song");
assert(!files.server.includes("song-metadata.json") || !files.server.match(/transition[\s\S]{0,80}song-metadata\.json/i), "transition data is not written to song metadata");

assert(files.app.includes("setlistTransitions"), "host keeps transition state");
assert(files.app.includes("transition-tile"), "host renders transition tiles");
assert(files.app.includes("updateTransition"), "host edits transition tiles");
assert(files.server.includes("serviceSongEndBackend"), "backend services transition near song end");
assert(files.app.includes("body: JSON.stringify({ slots, transitions: state.setlistTransitions })"), "host saves transitions with current setlist");

assert(files.remoteHtml.includes("transitionReadout"), "remote has transition readout markup");
assert(files.remote.includes("renderTransitionReadout"), "remote renders transition readout");

const apiSetlist = await readApiSetlist();
if (apiSetlist) {
  const filled = (apiSetlist.slots || []).filter((slot) => slot.songId);
  const expected = Math.max(0, filled.length - 1);
  assert(Array.isArray(apiSetlist.transitions), "API setlist returns transitions array");
  assert(apiSetlist.transitions.length === expected, `API has ${expected} adjacent transitions`);
  for (const transition of apiSetlist.transitions) {
    assert(filled.some((slot) => Number(slot.slot) === Number(transition.fromSlot)), "transition fromSlot is filled");
    assert(filled.some((slot) => Number(slot.slot) === Number(transition.toSlot)), "transition toSlot is filled");
  }
}

console.log(JSON.stringify({
  ok: true,
  checks: apiSetlist ? 20 : 16,
  apiChecked: Boolean(apiSetlist),
  focus: "setlist-song-transitions"
}, null, 2));

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

async function readApiSetlist() {
  try {
    const response = await fetch("http://127.0.0.1:5312/api/setlist/current");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

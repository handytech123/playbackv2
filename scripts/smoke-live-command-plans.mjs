const baseUrl = process.env.PLAYBACK_BASE_URL || "http://127.0.0.1:5312";

const state = await api("/api/playback/state").catch(() => null);
if (!state) {
  console.log(JSON.stringify({ ok: true, skipped: "api-unavailable", focus: "live-command-plans" }, null, 2));
  process.exit(0);
}

assert(state.confirmed === true, "current set must be confirmed for live command smoke test");

const metadata = await api("/api/set-metadata/current");
const slot = (metadata.slots || []).find((item) => item.slot && item.regions?.regions?.length);
assert(slot, "at least one setlist song must have regions");

const region = slot.regions.regions[0];
assert(region.id, "smoke region has an id");

const repeat = await command("repeatRegion", {
  slot: slot.slot,
  regionId: region.id,
  regionName: region.name,
  systemAction: true
});

const liveRepeat = repeat.state?.liveRepeat || {};
const plan = liveRepeat.repeatCuePlan;
assert(liveRepeat.regionId === region.id, "repeat command queues the selected region");
assert(Number.isFinite(Number(plan.triggerSeconds)), "repeat cue plan has triggerSeconds");
assert(Number.isFinite(Number(plan.startSeconds)), "repeat cue plan has startSeconds");
assert(Number.isFinite(Number(plan.endSeconds)), "repeat cue plan has endSeconds");
assert(Number(plan.endSeconds) > Number(plan.startSeconds), "repeat cue plan has positive duration");

await command("clearRegionRepeat", { slot: slot.slot, systemAction: true });

console.log(JSON.stringify({
  ok: true,
  focus: "live-command-plans",
  checkedSlot: slot.slot,
  checkedRegion: region.name || region.id
}, null, 2));

async function command(action, payload) {
  return api("/api/playback/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: action, ...payload })
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

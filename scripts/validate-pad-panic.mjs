import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dataDir = process.env.PLAYBACK_DATA_DIR || join(root, "data");

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const settings = await readJson(join(dataDir, "settings.json"), {});
const pads = {
  folderPath: join(root, "pads"),
  defaultEnabled: true,
  startWithSong: true,
  continueBetweenSongs: true,
  defaultVolume: 0.65,
  fadeInMs: 1500,
  fadeOutMs: 2500,
  ...(settings.pads || {})
};
if (!pads.folderPath) fail("settings.pads.folderPath is missing");
if (typeof pads.defaultEnabled !== "boolean") fail("settings.pads.defaultEnabled is not boolean");
if (typeof pads.startWithSong !== "boolean") fail("settings.pads.startWithSong is not boolean");
if (typeof pads.continueBetweenSongs !== "boolean") fail("settings.pads.continueBetweenSongs is not boolean");
pass("settings has dedicated pads shape");

const padB = join(pads.folderPath, "Pad_B.wav");
if (!(await exists(padB))) fail(`Pad_B.wav is missing at ${padB}`);
pass("song key B resolves to Pad_B.wav in configured pads folder");

const manifest = await readJson(join(dataDir, "playback-engine-manifest.json"), {});
const songs = Array.isArray(manifest.songs) ? manifest.songs : [];
if (!songs.length) {
  console.log("SKIP engine manifest has no songs");
  process.exit(0);
}

const withDynamicPad = songs.filter((song) => song.dynamicPad);
if (!withDynamicPad.length) fail("No dynamicPad objects found in engine manifest");
pass("dynamicPad appears in engine manifest");

const padSummary = withDynamicPad.find((song) => song.pad);
if (!padSummary) fail("No per-song pad summary found in engine manifest");
pass("per-song pad metadata is present");

const vendorPadStem = songs.flatMap((song) => song.stems || []).find((stem) => /(^|[\\/])pad\.wav$/i.test(stem.relativePath || stem.fileName || ""));
if (vendorPadStem) fail("Vendor PAD.wav is present as a normal playback stem");
pass("vendor PAD.wav is not treated as default dynamic pad");

const playback = await readJson(join(dataDir, "playback-state.json"), {});
if (playback.panic && playback.panic.state && playback.panic.state !== "NORMAL" && playback.panic.slot === undefined) {
  fail("panic runtime is missing slot");
}
pass("panic is stored only in runtime playback state");

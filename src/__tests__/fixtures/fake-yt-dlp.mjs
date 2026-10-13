#!/usr/bin/env node
// Fake yt-dlp for the studio.reference_fetch tests (argv = [node, this file]): never touches the network.
// Same ids as Studio's fixtures/fake-yt-dlp.mjs, by their start: "ERR" removed, "BOT" YouTube's bot check, "PRIV"
// private, "AGE" age restricted, "LONG" skipped by the duration filter (said on stdout, exit 0); plus "BIG" over
// --max-filesize (stdout, exit 0), "NET" a network error, "SLOW" hangs until killed, "WEBM" a single webm file.
// A download writes <dir>/<id>.mp4 with ffmpeg (`--ffmpeg-location`): 2 s of 320x240 colour, and <id>.info.json when
// --write-info-json is given. FAKE_YTDLP_ARGS_OUT: write the argv received there (JSON) first.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_YTDLP_ARGS_OUT) writeFileSync(process.env.FAKE_YTDLP_ARGS_OUT, JSON.stringify(args));
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const urls = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];

if (args.includes("--version")) {
  process.stdout.write("2026.09.01-fake\n");
  process.exit(0);
}

const id = new URL(urls[0] ?? "https://x/").searchParams.get("v") ?? "";
const fail = (line) => { process.stderr.write(`${line}\n`); process.exit(1); };
if (id.startsWith("BOT")) fail(`ERROR: [youtube] ${id}: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies.`);
if (id.startsWith("ERR")) fail(`ERROR: [youtube] ${id}: Video unavailable`);
if (id.startsWith("PRIV")) fail(`ERROR: [youtube] ${id}: Private video. Sign in if you've been granted access to this video`);
if (id.startsWith("AGE")) fail(`ERROR: [youtube] ${id}: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.`);
if (id.startsWith("NET")) fail(`ERROR: [youtube] ${id}: Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed>`);
if (id.startsWith("LONG")) { process.stdout.write(`[download] Fake video ${id} does not pass filter (${after("--match-filter")}), skipping ..\n`); process.exit(0); }
if (id.startsWith("BIG")) { process.stdout.write(`[download] File is larger than max-filesize (400000000 bytes > ${after("--max-filesize")}). Aborting.\n`); process.exit(0); }
if (id.startsWith("SLOW")) { setInterval(() => {}, 1000); }
else {
  const ext = id.startsWith("WEBM") ? "webm" : "mp4";
  const template = after("-o") ?? `${id}.%(ext)s`;
  if (args.includes("--write-info-json")) {
    writeFileSync(template.replace("%(ext)s", "info.json"), JSON.stringify({ id, title: `Fake video ${id}`, channel: "Fake Channel", duration: 2 }));
  }
  const out = template.replace("%(ext)s", ext);
  const ffmpeg = after("--ffmpeg-location");
  if (!ffmpeg) { writeFileSync(out, "fake-video"); process.exit(0); }
  const codec = ext === "webm" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=2", ...codec, out], { encoding: "utf8" });
  if (r.status !== 0) fail(`ERROR: fake ffmpeg failed: ${r.stderr}`);
  process.exit(0);
}

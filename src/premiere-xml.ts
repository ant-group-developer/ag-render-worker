/**
 * Final Cut Pro 7 XML (`xmeml` version 5) for one episode: the format Adobe Premiere Pro imports as a sequence
 * (File > Import). Premiere cannot read titles/generators from this format, so on-screen texts come as
 * transparent PNGs on V2; chapters become sequence markers.
 *
 * Tracks: V1 the videos back to back, each playing `[inFrame, outFrame)` of its file, with a Cross Dissolve or a
 * Dip to Color Dissolve (black) where the render dissolves or dips; V2 the text overlays; A1 the videos' own sound
 * (linked to V1, at `sourceAudioGainDb`, absent when the episode mutes it); A2 the music (repeated to cover the
 * sequence, as the render loops it; its gain is the Audio Levels value, its fades and the ducking under the narration
 * are level keyframes); A3 the narration, one clip per line.
 *
 * Transitions follow the render (`final-graph.ts` in @harness/core), which never moves a clip: a dissolve starts at
 * the cut and plays the outgoing file's tail after its out point (alignment `start`); a dip to black fades out the
 * last half and in the first half around the cut (alignment `center`). As in FCP7's own export, a clip's `start` or
 * `end` next to a transition is -1, and its in/out are at the edit point.
 *
 * Media paths are RELATIVE to the XML (`media/…`, `overlays/…`): Premiere asks to locate the first missing file and
 * then finds the others in the same folders ("Relink others automatically"). The README in the zip says so.
 */

export interface PremiereFile {
  /** Stable id inside the document, e.g. the asset id. */
  key: string;
  name: string;
  /** Relative path inside the export zip, forward slashes. */
  path: string;
  durationFrames: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface PremiereTransition {
  kind: "dissolve" | "dip_black";
  frames: number;
}

export interface PremiereClip {
  file: PremiereFile;
  startFrame: number;
  /** Frames of the file played, `[inFrame, outFrame)`; default the whole file. */
  inFrame?: number;
  outFrame?: number;
  /** Into the next clip, which starts where this one ends. */
  transitionOut?: PremiereTransition | null;
  /** This clip's own sound is off while others keep theirs (Studio cut 1.1.0, `has_audio: false`): no A1 item. */
  muted?: boolean;
}

/** Ducking of A2 under the narration: `gainDb` below the music level inside each window, ramps after its edges. */
export interface PremiereDuck {
  windows: { startFrame: number; endFrame: number }[];
  gainDb: number;
  attackFrames: number;
  releaseFrames: number;
}

export interface PremiereSequence {
  name: string;
  fps: 25 | 30;
  width: number;
  height: number;
  /** V1 clips in play order. */
  clips: PremiereClip[];
  overlays: { name: string; path: string; startFrame: number; endFrame: number }[];
  /** A2. `fadeInFrames`/`fadeOutFrames` ramp the level from/to silence at the start/end of the sequence. */
  music: { file: PremiereFile; gainDb: number; fadeInFrames?: number; fadeOutFrames?: number; duck?: PremiereDuck | null } | null;
  sourceAudioMuted: boolean;
  /** Level of the A1 clips (0 when absent). */
  sourceAudioGainDb?: number;
  /** A3, at 0 dB as the render mixes it. */
  narration?: PremiereClip[];
  markers: { frame: number; name: string }[];
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** `media/Chợ nổi.mp4` -> `media/Ch%E1%BB%A3%20n%E1%BB%95i.mp4`: pathurl is a URL. */
export function pathUrl(path: string): string {
  return path.split("/").map((p) => encodeURIComponent(p)).join("/");
}

const rate = (fps: number) => `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;

class Xml {
  private readonly lines: string[] = [];
  private depth = 0;
  open(tag: string, attrs = ""): this { this.lines.push(`${"  ".repeat(this.depth)}<${tag}${attrs}>`); this.depth++; return this; }
  close(tag: string): this { this.depth--; this.lines.push(`${"  ".repeat(this.depth)}</${tag}>`); return this; }
  leaf(tag: string, value: string | number): this { this.lines.push(`${"  ".repeat(this.depth)}<${tag}>${typeof value === "string" ? escapeXml(value) : value}</${tag}>`); return this; }
  raw(s: string): this { this.lines.push(`${"  ".repeat(this.depth)}${s}`); return this; }
  toString(): string { return this.lines.join("\n") + "\n"; }
}

const inOf = (c: PremiereClip) => c.inFrame ?? 0;
const outOf = (c: PremiereClip) => c.outFrame ?? c.file.durationFrames;
const endOf = (c: PremiereClip) => c.startFrame + outOf(c) - inOf(c);

/** Sequence frames a transition covers around the cut at `cut`. */
function transitionSpan(t: PremiereTransition, cut: number): { start: number; end: number } {
  const start = t.kind === "dissolve" ? cut : cut - Math.floor(t.frames / 2);
  return { start, end: start + t.frames };
}

export function premiereXml(seq: PremiereSequence): string {
  const total = seq.clips.reduce((end, c) => Math.max(end, endOf(c)), 0);
  const declared = new Set<string>();
  const x = new Xml();
  x.raw(`<?xml version="1.0" encoding="UTF-8"?>`).raw("<!DOCTYPE xmeml>");
  x.open("xmeml", ' version="5"').open("sequence", ' id="sequence-1"');
  x.leaf("name", seq.name).leaf("duration", total).raw(rate(seq.fps));
  x.open("timecode").raw(rate(seq.fps)).leaf("string", "00:00:00:00").leaf("frame", 0).leaf("displayformat", "NDF").close("timecode");
  x.open("media");

  // A <file> is written in full the first time and referenced by id afterwards (FCP7 rule).
  const file = (f: PremiereFile, still = false) => {
    const id = `file-${f.key}`;
    if (declared.has(id)) { x.raw(`<file id="${escapeXml(id)}"/>`); return; }
    declared.add(id);
    x.open("file", ` id="${escapeXml(id)}"`).leaf("name", f.name).leaf("pathurl", pathUrl(f.path)).raw(rate(seq.fps)).leaf("duration", f.durationFrames);
    x.open("media");
    if (f.width > 0) {
      x.open("video").open("samplecharacteristics").raw(rate(seq.fps)).leaf("width", f.width).leaf("height", f.height);
      if (still) x.leaf("anamorphic", "FALSE");
      x.leaf("pixelaspectratio", "square").leaf("fielddominance", "none").close("samplecharacteristics").close("video");
    }
    if (f.hasAudio) x.open("audio").open("samplecharacteristics").leaf("depth", 16).leaf("samplerate", 48000).close("samplecharacteristics").leaf("channelcount", 2).close("audio");
    x.close("media").close("file");
  };

  const clipitem = (id: string, name: string, start: number, end: number, inF: number, outF: number, durationFrames: number, body: () => void) => {
    x.open("clipitem", ` id="${id}"`).leaf("name", name).leaf("enabled", "TRUE").leaf("duration", durationFrames).raw(rate(seq.fps));
    x.leaf("start", start).leaf("end", end).leaf("in", inF).leaf("out", outF);
    body();
    x.close("clipitem");
  };

  const link = (ids: { id: string; mediatype: "video" | "audio"; trackindex: number; clipindex: number }[]) => {
    for (const l of ids) {
      x.open("link").leaf("linkclipref", l.id).leaf("mediatype", l.mediatype).leaf("trackindex", l.trackindex).leaf("clipindex", l.clipindex).close("link");
    }
  };

  // Premiere's "Audio Levels": a linear gain (1 = 0 dB, 3.98109 = +12 dB), optionally keyframed (`when` from the clip start).
  const audioLevels = (gain: number, keyframes: [number, number][] = []) => {
    x.open("filter").open("effect").leaf("name", "Audio Levels").leaf("effectid", "audiolevels").leaf("effectcategory", "audiolevels").leaf("effecttype", "audiolevels").leaf("mediatype", "audio");
    x.open("parameter").leaf("parameterid", "level").leaf("name", "Level").leaf("valuemin", 0).leaf("valuemax", 3.98109).leaf("value", round5(gain));
    for (const [when, value] of keyframes) x.open("keyframe").leaf("when", when).leaf("value", value).close("keyframe");
    x.close("parameter");
    x.close("effect").close("filter");
  };

  const transitionitem = (t: PremiereTransition, cut: number) => {
    const { start, end } = transitionSpan(t, cut);
    const name = t.kind === "dissolve" ? "Cross Dissolve" : "Dip to Color Dissolve";
    x.open("transitionitem").raw(rate(seq.fps)).leaf("start", start).leaf("end", end).leaf("alignment", t.kind === "dissolve" ? "start" : "center");
    x.open("effect").leaf("name", name).leaf("effectid", name).leaf("effectcategory", "Dissolve").leaf("effecttype", "transition").leaf("mediatype", "video");
    if (t.kind === "dissolve") {
      x.leaf("wipecode", 0).leaf("wipeaccuracy", 100).leaf("startratio", 0).leaf("endratio", 1).leaf("reverse", "FALSE");
    } else {
      x.open("parameter").leaf("parameterid", "color").leaf("name", "Color");
      x.open("value").leaf("alpha", 255).leaf("red", 0).leaf("green", 0).leaf("blue", 0).close("value");
      x.close("parameter");
    }
    x.close("effect").close("transitionitem");
  };

  // ---- video
  x.open("video");
  x.open("format").open("samplecharacteristics").raw(rate(seq.fps)).leaf("width", seq.width).leaf("height", seq.height)
    .leaf("pixelaspectratio", "square").leaf("fielddominance", "none").close("samplecharacteristics").close("format");
  x.open("track");
  seq.clips.forEach((c, i) => {
    const withAudio = !seq.sourceAudioMuted && c.file.hasAudio && !c.muted;
    const into = i > 0 ? seq.clips[i - 1]!.transitionOut : null;
    const out = i < seq.clips.length - 1 ? c.transitionOut : null;
    if (into) transitionitem(into, c.startFrame);
    clipitem(`clipitem-v${i + 1}`, c.file.name, into ? -1 : c.startFrame, out ? -1 : endOf(c), inOf(c), outOf(c), c.file.durationFrames, () => {
      file(c.file);
      if (withAudio) link([
        { id: `clipitem-v${i + 1}`, mediatype: "video", trackindex: 1, clipindex: i + 1 },
        { id: `clipitem-a${i + 1}`, mediatype: "audio", trackindex: 1, clipindex: audioIndex(seq, i) },
      ]);
    });
  });
  x.close("track");
  if (seq.overlays.length) {
    x.open("track");
    seq.overlays.forEach((o, i) => {
      const len = Math.max(1, o.endFrame - o.startFrame);
      const f: PremiereFile = { key: `overlay-${i + 1}`, name: o.name, path: o.path, durationFrames: len, width: seq.width, height: seq.height, hasAudio: false };
      clipitem(`clipitem-t${i + 1}`, o.name, o.startFrame, o.startFrame + len, 0, len, len, () => file(f, true));
    });
    x.close("track");
  }
  x.close("video");

  // ---- audio
  x.open("audio").leaf("numOutputChannels", 2);
  x.open("format").open("samplecharacteristics").leaf("depth", 16).leaf("samplerate", 48000).close("samplecharacteristics").close("format");
  x.open("track");
  if (!seq.sourceAudioMuted) {
    seq.clips.forEach((c, i) => {
      if (!c.file.hasAudio || c.muted) return;
      clipitem(`clipitem-a${i + 1}`, c.file.name, c.startFrame, endOf(c), inOf(c), outOf(c), c.file.durationFrames, () => {
        file(c.file);
        x.open("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).close("sourcetrack");
        if (seq.sourceAudioGainDb) audioLevels(10 ** (seq.sourceAudioGainDb / 20));
        link([
          { id: `clipitem-v${i + 1}`, mediatype: "video", trackindex: 1, clipindex: i + 1 },
          { id: `clipitem-a${i + 1}`, mediatype: "audio", trackindex: 1, clipindex: audioIndex(seq, i) },
        ]);
      });
    });
  }
  x.close("track");
  if (seq.music && seq.music.file.durationFrames > 0 && total > 0) {
    const m = seq.music;
    const gain = 10 ** (m.gainDb / 20);
    const fadeIn = m.fadeInFrames ?? 0;
    const fadeOut = m.fadeOutFrames ?? 0;
    const duck = m.duck && m.duck.windows.length ? m.duck : null;
    const duckGain = duck ? 10 ** (duck.gainDb / 20) : 1;
    const attack = Math.max(1, duck?.attackFrames ?? 1);
    const release = Math.max(1, duck?.releaseFrames ?? 1);
    // Ducking factor at frame f: down to `duckGain` over `attack` frames from a window's start, back up over
    // `release` frames after its end.
    const duckAt = (f: number) => {
      let k = 1;
      for (const w of duck?.windows ?? []) {
        if (f < w.startFrame || f > w.endFrame + release) continue;
        const depth = f <= w.endFrame ? Math.min(1, (f - w.startFrame) / attack) : 1 - (f - w.endFrame) / release;
        k = Math.min(k, 1 - (1 - duckGain) * depth);
      }
      return k;
    };
    // Linear level at sequence frame f, as the render's afade in/out around `volume`, ducked under the narration.
    const level = (f: number) => {
      let k = 1;
      if (fadeIn > 0) k = Math.min(k, f / fadeIn);
      if (fadeOut > 0) k = Math.min(k, (total - f) / fadeOut);
      return round5(gain * Math.max(0, k) * duckAt(f));
    };
    // Where the envelope bends: keyframes go there and at each music clip's edges.
    const bends = [
      ...(fadeIn > 0 ? [fadeIn] : []),
      ...(fadeOut > 0 ? [total - fadeOut] : []),
      ...(duck?.windows ?? []).flatMap((w) => [w.startFrame, Math.min(w.endFrame, w.startFrame + attack), w.endFrame, w.endFrame + release]),
    ];
    x.open("track");
    let at = 0;
    let n = 0;
    while (at < total) {
      const len = Math.min(m.file.durationFrames, total - at);
      n++;
      const clipStart = at;
      // Keyframes at the clip's edges and where a fade starts/ends inside it; `when` counts from the clip start (in=0).
      const points = bends.length
        ? [...new Set([clipStart, clipStart + len, ...bends])].filter((f) => f >= clipStart && f <= clipStart + len).sort((a, b) => a - b)
        : [];
      clipitem(`clipitem-m${n}`, m.file.name, at, at + len, 0, len, m.file.durationFrames, () => {
        file(m.file);
        x.open("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).close("sourcetrack");
        if (m.gainDb !== 0 || points.length) audioLevels(gain, points.map((f) => [f - clipStart, level(f)]));
      });
      at += len;
    }
    x.close("track");
  }
  if (seq.narration?.length) {
    x.open("track");
    seq.narration.forEach((n, i) => {
      clipitem(`clipitem-n${i + 1}`, n.file.name, n.startFrame, endOf(n), inOf(n), outOf(n), n.file.durationFrames, () => {
        file(n.file);
        x.open("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).close("sourcetrack");
      });
    });
    x.close("track");
  }
  x.close("audio");
  x.close("media");

  for (const mk of seq.markers) x.open("marker").leaf("name", mk.name).leaf("comment", "").leaf("in", mk.frame).leaf("out", -1).close("marker");
  x.close("sequence").close("xmeml");
  return x.toString();
}

/** Position (1-based) of clip i's audio item on A1: only clips with sound, not muted on their own, have one. */
function audioIndex(seq: PremiereSequence, i: number): number {
  return seq.clips.slice(0, i + 1).filter((c) => c.file.hasAudio && !c.muted).length;
}

function round5(n: number): number { return Math.round(n * 1e5) / 1e5; }

/** `00:01:02,345` */
function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** The composition's caption cues as SubRip, which Premiere imports as a caption track (`captions.srt` in the zip). */
export function captionsSrt(cues: { start: number; end: number; lines: string[] }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join("\n")}\n`).join("\n");
}

export const PREMIERE_README_VI = `Project Adobe Premiere Pro (FCP7 XML)

1. Giải nén toàn bộ file zip vào một thư mục (giữ nguyên các thư mục media/ và overlays/).
2. Mở Premiere Pro > File > Import… > chọn project.xml. Premiere tạo một sequence đúng khung hình, fps và thứ tự video.
3. Nếu Premiere báo thiếu media: bấm "Locate", chọn file tương ứng trong thư mục media/ (hoặc overlays/),
   bật "Relink others automatically" — các file còn lại tự được tìm thấy.
4. Chữ trên hình nằm ở track V2 dạng ảnh PNG trong suốt, không sửa được nội dung chữ trong Premiere.
   Chương (chapter) là các marker trên sequence. Chuyển cảnh nằm trên V1: Cross Dissolve (mờ dần)
   và Dip to Color Dissolve (mờ qua đen).
   Âm thanh: A1 tiếng gốc của video, A2 nhạc nền (mức âm, fade và chỗ nhạc nhỏ đi dưới lời dẫn là keyframe),
   A3 lời dẫn.
5. Nếu có file captions.srt: File > Import… > chọn captions.srt rồi kéo vào sequence để có track phụ đề
   (bản render đốt phụ đề vào hình; trong Premiere bạn tự chỉnh kiểu chữ).
6. Nếu bạn xuất bản proxy 720p: khi dựng xong, relink các clip trong media/ sang file gốc
   (chuột phải clip > Link Media… hoặc Replace Footage) trước khi xuất bản cuối.
`;

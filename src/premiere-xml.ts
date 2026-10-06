/**
 * Final Cut Pro 7 XML (`xmeml` version 5) for one episode: the format Adobe Premiere Pro imports as a sequence
 * (File > Import). Premiere cannot read titles/generators from this format, so on-screen texts come as
 * transparent PNGs on V2; chapters become sequence markers.
 *
 * Tracks: V1 the videos back to back, V2 the text overlays, A1 the videos' own sound (linked to V1, absent when
 * the episode mutes it), A2 the music (repeated to cover the sequence, as the render loops it; its gain is the
 * Audio Levels value and its fades are level keyframes).
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

export interface PremiereSequence {
  name: string;
  fps: 25 | 30;
  width: number;
  height: number;
  /** V1 clips in play order; each plays its whole file. */
  clips: { file: PremiereFile; startFrame: number }[];
  overlays: { name: string; path: string; startFrame: number; endFrame: number }[];
  /** A2. `fadeInFrames`/`fadeOutFrames` ramp the level from/to silence at the start/end of the sequence. */
  music: { file: PremiereFile; gainDb: number; fadeInFrames?: number; fadeOutFrames?: number } | null;
  sourceAudioMuted: boolean;
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

export function premiereXml(seq: PremiereSequence): string {
  const total = seq.clips.reduce((end, c) => Math.max(end, c.startFrame + c.file.durationFrames), 0);
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

  // ---- video
  x.open("video");
  x.open("format").open("samplecharacteristics").raw(rate(seq.fps)).leaf("width", seq.width).leaf("height", seq.height)
    .leaf("pixelaspectratio", "square").leaf("fielddominance", "none").close("samplecharacteristics").close("format");
  x.open("track");
  seq.clips.forEach((c, i) => {
    const withAudio = !seq.sourceAudioMuted && c.file.hasAudio;
    clipitem(`clipitem-v${i + 1}`, c.file.name, c.startFrame, c.startFrame + c.file.durationFrames, 0, c.file.durationFrames, c.file.durationFrames, () => {
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
      if (!c.file.hasAudio) return;
      clipitem(`clipitem-a${i + 1}`, c.file.name, c.startFrame, c.startFrame + c.file.durationFrames, 0, c.file.durationFrames, c.file.durationFrames, () => {
        file(c.file);
        x.open("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).close("sourcetrack");
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
    // Linear level at sequence frame f, as the render's afade in/out around `volume`.
    const level = (f: number) => {
      let k = 1;
      if (fadeIn > 0) k = Math.min(k, f / fadeIn);
      if (fadeOut > 0) k = Math.min(k, (total - f) / fadeOut);
      return round5(gain * Math.max(0, k));
    };
    x.open("track");
    let at = 0;
    let n = 0;
    while (at < total) {
      const len = Math.min(m.file.durationFrames, total - at);
      n++;
      const clipStart = at;
      // Keyframes at the clip's edges and where a fade starts/ends inside it; `when` counts from the clip start (in=0).
      const points = fadeIn > 0 || fadeOut > 0
        ? [...new Set([clipStart, clipStart + len, fadeIn, total - fadeOut])].filter((f) => f >= clipStart && f <= clipStart + len).sort((a, b) => a - b)
        : [];
      clipitem(`clipitem-m${n}`, m.file.name, at, at + len, 0, len, m.file.durationFrames, () => {
        file(m.file);
        x.open("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).close("sourcetrack");
        if (m.gainDb !== 0 || points.length) {
          x.open("filter").open("effect").leaf("name", "Audio Levels").leaf("effectid", "audiolevels").leaf("effectcategory", "audiolevels").leaf("effecttype", "audiolevels").leaf("mediatype", "audio");
          x.open("parameter").leaf("parameterid", "level").leaf("name", "Level").leaf("valuemin", 0).leaf("valuemax", 3.98109).leaf("value", round5(gain));
          for (const f of points) x.open("keyframe").leaf("when", f - clipStart).leaf("value", level(f)).close("keyframe");
          x.close("parameter");
          x.close("effect").close("filter");
        }
      });
      at += len;
    }
    x.close("track");
  }
  x.close("audio");
  x.close("media");

  for (const mk of seq.markers) x.open("marker").leaf("name", mk.name).leaf("comment", "").leaf("in", mk.frame).leaf("out", -1).close("marker");
  x.close("sequence").close("xmeml");
  return x.toString();
}

/** Position (1-based) of clip i's audio item on A1: only clips with sound have one. */
function audioIndex(seq: PremiereSequence, i: number): number {
  return seq.clips.slice(0, i + 1).filter((c) => c.file.hasAudio).length;
}

function round5(n: number): number { return Math.round(n * 1e5) / 1e5; }

export const PREMIERE_README_VI = `Project Adobe Premiere Pro (FCP7 XML)

1. Giải nén toàn bộ file zip vào một thư mục (giữ nguyên các thư mục media/ và overlays/).
2. Mở Premiere Pro > File > Import… > chọn project.xml. Premiere tạo một sequence đúng khung hình, fps và thứ tự video.
3. Nếu Premiere báo thiếu media: bấm "Locate", chọn file tương ứng trong thư mục media/ (hoặc overlays/),
   bật "Relink others automatically" — các file còn lại tự được tìm thấy.
4. Chữ trên hình nằm ở track V2 dạng ảnh PNG trong suốt, không sửa được nội dung chữ trong Premiere.
   Chương (chapter) là các marker trên sequence.
5. Nếu bạn xuất bản proxy 720p: khi dựng xong, relink các clip trong media/ sang file gốc
   (chuột phải clip > Link Media… hoặc Replace Footage) trước khi xuất bản cuối.
`;

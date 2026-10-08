/**
 * Tests: premiere-xml.ts — FCP7 xmeml v5 generator.
 *
 * Covers:
 *   - Well-formed XML (fast-xml-parser)
 *   - secondsToFrames math
 *   - Files declared once then referenced by id
 *   - URL-encoded relative paths
 *   - A1 omits clips without audio; A1 track absent when sourceAudioMuted=true
 *   - Music repeats to cover the sequence; Audio Levels filter only when gain ≠ 0 or the music fades;
 *     fades as level keyframes
 *   - Markers present in output
 *   - escapeXml and pathUrl helpers
 */
import { XMLParser } from 'fast-xml-parser';
import {
  premiereXml,
  secondsToFrames,
  escapeXml,
  pathUrl,
  PREMIERE_README_VI,
  captionsSrt,
  type PremiereFile,
  type PremiereSequence,
} from '../premiere-xml.js';

// ---- Helpers ----

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parse(xml: string): unknown {
  const result = parser.parse(xml);
  expect(result).toBeTruthy();
  return result;
}

function makeFile(overrides: Partial<PremiereFile> = {}): PremiereFile {
  return {
    key: 'file-01',
    name: 'clip.mp4',
    path: 'media/clip.mp4',
    durationFrames: 75,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...overrides,
  };
}

function makeSeq(overrides: Partial<PremiereSequence> = {}): PremiereSequence {
  const f = makeFile();
  return {
    name: 'Test Sequence',
    fps: 25,
    width: 1920,
    height: 1080,
    clips: [{ file: f, startFrame: 0 }],
    overlays: [],
    music: null,
    sourceAudioMuted: false,
    markers: [],
    ...overrides,
  };
}

// ---- secondsToFrames ----

describe('secondsToFrames', () => {
  test('rounds seconds to nearest frame at 25 fps', () => {
    expect(secondsToFrames(1, 25)).toBe(25);
    expect(secondsToFrames(0.04, 25)).toBe(1);
    expect(secondsToFrames(0, 25)).toBe(0);
    expect(secondsToFrames(-1, 25)).toBe(0); // clamps to 0
  });

  test('rounds seconds to nearest frame at 30 fps', () => {
    expect(secondsToFrames(1, 30)).toBe(30);
    expect(secondsToFrames(0.5, 30)).toBe(15);
  });
});

// ---- escapeXml ----

describe('escapeXml', () => {
  test('escapes XML special characters', () => {
    expect(escapeXml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&apos;');
  });

  test('leaves plain text unchanged', () => {
    expect(escapeXml('Hello World 123')).toBe('Hello World 123');
  });
});

// ---- pathUrl ----

describe('pathUrl', () => {
  test('URL-encodes non-ASCII and spaces', () => {
    expect(pathUrl('media/Chợ nổi.mp4')).toBe('media/Ch%E1%BB%A3%20n%E1%BB%95i.mp4');
  });

  test('keeps plain ASCII paths unchanged', () => {
    expect(pathUrl('media/clip.mp4')).toBe('media/clip.mp4');
  });

  test('encodes each path segment independently', () => {
    expect(pathUrl('media/a b/c d.mp4')).toBe('media/a%20b/c%20d.mp4');
  });
});

// ---- Well-formed XML ----

describe('premiereXml: well-formed', () => {
  test('output parses as XML', () => {
    const xml = premiereXml(makeSeq());
    expect(() => parse(xml)).not.toThrow();
  });

  test('has xmeml version=5 root', () => {
    const xml = premiereXml(makeSeq());
    const doc = parse(xml) as Record<string, unknown>;
    const xmeml = doc['xmeml'] as Record<string, unknown>;
    expect(xmeml).toBeTruthy();
    expect(xmeml['@_version']).toBe('5');
  });

  test('sequence has correct name', () => {
    const xml = premiereXml(makeSeq({ name: 'Tập 42' }));
    expect(xml).toContain('<name>Tập 42</name>');
  });
});

// ---- Frame math ----

describe('premiereXml: frame math', () => {
  test('sequence duration equals sum of clip durations', () => {
    const f1 = makeFile({ key: 'f1', name: 'a.mp4', path: 'media/a.mp4', durationFrames: 50 });
    const f2 = makeFile({ key: 'f2', name: 'b.mp4', path: 'media/b.mp4', durationFrames: 75, hasAudio: false });
    const seq = makeSeq({
      clips: [
        { file: f1, startFrame: 0 },
        { file: f2, startFrame: 50 },
      ],
    });
    const xml = premiereXml(seq);
    // Total = 50 + 75 = 125
    expect(xml).toContain('<duration>125</duration>');
  });

  test('clip start and end frames appear in the clipitem', () => {
    const f = makeFile({ durationFrames: 100 });
    const seq = makeSeq({ clips: [{ file: f, startFrame: 0 }] });
    const xml = premiereXml(seq);
    expect(xml).toContain('<start>0</start>');
    expect(xml).toContain('<end>100</end>');
  });
});

// ---- Files declared once, referenced by id ----

describe('premiereXml: file declaration once-and-reference', () => {
  test('first clip declares file with id, second reference uses id-only element', () => {
    const f = makeFile({ key: 'shared-clip' });
    const seq: PremiereSequence = {
      name: 'Dedup test',
      fps: 25,
      width: 1920,
      height: 1080,
      clips: [
        { file: { ...f, key: 'shared-clip' }, startFrame: 0 },
        { file: { ...f, key: 'shared-clip' }, startFrame: 75 },
      ],
      overlays: [],
      music: null,
      sourceAudioMuted: false,
      markers: [],
    };
    const xml = premiereXml(seq);

    // id attribute should appear exactly twice (once full, once as reference)
    const id = 'file-shared-clip';
    const fullDecl = new RegExp(`<file id="${id}"[^/]`, 'g');
    const refDecl = new RegExp(`<file id="${id}"/>`, 'g');

    const fullMatches = xml.match(fullDecl) ?? [];
    const refMatches = xml.match(refDecl) ?? [];

    expect(fullMatches.length).toBe(1);
    expect(refMatches.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- URL-encoded paths ----

describe('premiereXml: URL-encoded paths', () => {
  test('pathurl in xml uses percent-encoded non-ASCII', () => {
    const f = makeFile({ key: 'vn', path: 'media/Chợ nổi.mp4', name: 'Chợ nổi.mp4' });
    const xml = premiereXml(makeSeq({ clips: [{ file: f, startFrame: 0 }] }));
    expect(xml).toContain('<pathurl>media/Ch%E1%BB%A3%20n%E1%BB%95i.mp4</pathurl>');
  });
});

// ---- A1 audio track ----

describe('premiereXml: A1 audio track', () => {
  test('A1 omits a clip that has no audio (no clipitem-a for that clip)', () => {
    const silent = makeFile({ key: 'silent', hasAudio: false });
    const withAudio = makeFile({ key: 'audio', name: 'audio.mp4', path: 'media/audio.mp4', hasAudio: true });
    const seq = makeSeq({
      clips: [
        { file: silent, startFrame: 0 },
        { file: withAudio, startFrame: 75 },
      ],
    });
    const xml = premiereXml(seq);
    // clipitem-a1 would be the audio-clip for the silent clip — should not exist
    expect(xml).not.toContain('id="clipitem-a1"');
    // clipitem-a2 should exist for the audio clip
    expect(xml).toContain('id="clipitem-a2"');
  });

  test('A1 clips carry no Audio Levels filter at the default 0 dB', () => {
    const xml = premiereXml(makeSeq());
    expect(xml).toContain('id="clipitem-a1"');
    expect(xml).not.toContain('<name>Audio Levels</name>');
  });

  test('A1 clips take sourceAudioGainDb as their Audio Levels value', () => {
    const xml = premiereXml(makeSeq({ sourceAudioGainDb: -12 }));
    const a1 = xml.match(/<clipitem id="clipitem-a1">([\s\S]*?)<\/clipitem>/)?.[1] ?? '';
    // -12 dB → 10^(-12/20) = 0.25119
    expect(a1).toContain('<name>Audio Levels</name>');
    expect(a1).toContain('<value>0.25119</value>');
    // The video clip itself has no level filter.
    const v1 = xml.match(/<clipitem id="clipitem-v1">([\s\S]*?)<\/clipitem>/)?.[1] ?? '';
    expect(v1).not.toContain('Audio Levels');
  });

  test('A1 track is absent (no audio clipitems at all) when sourceAudioMuted=true', () => {
    const f = makeFile({ hasAudio: true });
    const seq = makeSeq({ sourceAudioMuted: true, clips: [{ file: f, startFrame: 0 }] });
    const xml = premiereXml(seq);
    // No clipitem-a entries should appear
    expect(xml).not.toContain('clipitem-a');
  });
});

// ---- Music track ----

describe('premiereXml: music track', () => {
  const musicFile: PremiereFile = {
    key: 'music-01',
    name: 'track.mp3',
    path: 'media/music.mp3',
    durationFrames: 50,  // shorter than sequence
    width: 0,
    height: 0,
    hasAudio: true,
  };

  test('music repeats to cover the full sequence (loop)', () => {
    // Sequence is 125 frames, music is 50 frames → needs 3 repetitions to cover
    const f1 = makeFile({ key: 'c1', durationFrames: 75, hasAudio: false });
    const f2 = makeFile({ key: 'c2', name: 'b.mp4', path: 'media/b.mp4', durationFrames: 50, hasAudio: false });
    const seq = makeSeq({
      clips: [
        { file: f1, startFrame: 0 },
        { file: f2, startFrame: 75 },
      ],
      music: { file: musicFile, gainDb: 0 },
      sourceAudioMuted: false,
    });
    const xml = premiereXml(seq);
    // 125 frames / 50 frames per loop = 3 segments
    expect(xml).toContain('id="clipitem-m1"');
    expect(xml).toContain('id="clipitem-m2"');
    expect(xml).toContain('id="clipitem-m3"');
    expect(xml).not.toContain('id="clipitem-m4"');
  });

  test('Audio Levels filter is absent when gainDb === 0', () => {
    const seq = makeSeq({ music: { file: musicFile, gainDb: 0 } });
    const xml = premiereXml(seq);
    expect(xml).not.toContain('<name>Audio Levels</name>');
  });

  test('Audio Levels filter is present when gainDb !== 0', () => {
    const seq = makeSeq({ music: { file: musicFile, gainDb: -6 } });
    const xml = premiereXml(seq);
    expect(xml).toContain('<name>Audio Levels</name>');
    expect(xml).toContain('<effectid>audiolevels</effectid>');
  });

  test('gain value in Audio Levels is rounded to 5 decimal places', () => {
    const seq = makeSeq({ music: { file: musicFile, gainDb: -6 } });
    const xml = premiereXml(seq);
    // -6 dB → linear = 10^(-6/20) = 0.50119..., rounded to 5dp = 0.50119
    expect(xml).toContain('<value>0.50119</value>');
  });

  test('no level keyframes when the music has no fades', () => {
    const xml = premiereXml(makeSeq({ music: { file: musicFile, gainDb: -6 } }));
    expect(xml).not.toContain('<keyframe>');
  });

  test('fades become Audio Levels keyframes across the repeated music clips', () => {
    // Sequence 125 frames, music 50 frames → m1 [0,50), m2 [50,100), m3 [100,125).
    // -18 dB = 0.12589; fade-in 25 frames from 0, fade-out 50 frames ending at 125 (starts at 75, inside m2).
    const f1 = makeFile({ key: 'c1', durationFrames: 75, hasAudio: false });
    const f2 = makeFile({ key: 'c2', name: 'b.mp4', path: 'media/b.mp4', durationFrames: 50, hasAudio: false });
    const xml = premiereXml(makeSeq({
      clips: [{ file: f1, startFrame: 0 }, { file: f2, startFrame: 75 }],
      music: { file: musicFile, gainDb: -18, fadeInFrames: 25, fadeOutFrames: 50 },
    }));
    expect(() => parse(xml)).not.toThrow();
    // `when` counts from the clip's start (every music clip has in=0).
    expect(keyframes(xml, 'clipitem-m1')).toEqual([[0, 0], [25, 0.12589], [50, 0.12589]]);
    expect(keyframes(xml, 'clipitem-m2')).toEqual([[0, 0.12589], [25, 0.12589], [50, 0.06295]]);
    expect(keyframes(xml, 'clipitem-m3')).toEqual([[0, 0.06295], [25, 0]]);
  });

  test('a fade at 0 dB still writes the Audio Levels filter', () => {
    const xml = premiereXml(makeSeq({ music: { file: musicFile, gainDb: 0, fadeInFrames: 10, fadeOutFrames: 0 } }));
    expect(xml).toContain('<name>Audio Levels</name>');
    expect(keyframes(xml, 'clipitem-m1')).toEqual([[0, 0], [10, 1], [50, 1]]);
  });
});

/** [when, value] of the level keyframes inside one clipitem. */
function keyframes(xml: string, clipId: string): [number, number][] {
  const body = xml.match(new RegExp(`<clipitem id="${clipId}">([\\s\\S]*?)</clipitem>`))?.[1] ?? '';
  return [...body.matchAll(/<keyframe>\s*<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>\s*<\/keyframe>/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
}

// ---- Markers ----

describe('premiereXml: markers', () => {
  test('markers appear in the XML', () => {
    const seq = makeSeq({
      markers: [
        { frame: 0, name: 'Intro' },
        { frame: 50, name: 'Main event' },
      ],
    });
    const xml = premiereXml(seq);
    expect(xml).toContain('<name>Intro</name>');
    expect(xml).toContain('<in>0</in>');
    expect(xml).toContain('<name>Main event</name>');
    expect(xml).toContain('<in>50</in>');
  });

  test('no markers when markers array is empty', () => {
    const xml = premiereXml(makeSeq({ markers: [] }));
    expect(xml).not.toContain('<marker>');
  });
});

// ---- Overlays (V2) ----

describe('premiereXml: overlays track', () => {
  test('overlay clips appear on V2 with correct frames', () => {
    const seq = makeSeq({
      overlays: [
        { name: 'T001.png', path: 'overlays/T001.png', startFrame: 10, endFrame: 35 },
      ],
    });
    const xml = premiereXml(seq);
    expect(xml).toContain('clipitem-t1');
    expect(xml).toContain('<start>10</start>');
  });

  test('no V2 track when overlays is empty', () => {
    const xml = premiereXml(makeSeq({ overlays: [] }));
    expect(xml).not.toContain('clipitem-t');
  });
});

// ---- Trimmed clips and transitions (timeline v4) ----

/** The direct children of one clipitem/transitionitem, by tag. */
function item(xml: string, tag: 'clipitem' | 'transitionitem', id?: string): Record<string, string> {
  const re = id ? new RegExp(`<${tag} id="${id}">([\\s\\S]*?)</${tag}>`) : new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const body = xml.match(re)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^ {12}<(\w+)>([^<]*)<\/\1>/gm)) out[m[1]!] ??= m[2]!;
  return out;
}

describe('premiereXml: trimmed clips', () => {
  // One 250-frame file cut into two shots: [10, 30) and [100, 160).
  const f = makeFile({ key: 'src', durationFrames: 250 });
  const clips = [
    { file: f, startFrame: 0, inFrame: 10, outFrame: 30 },
    { file: f, startFrame: 20, inFrame: 100, outFrame: 160 },
  ];

  test('each clip plays its in/out of the file, placed back to back', () => {
    const xml = premiereXml(makeSeq({ clips }));
    expect(() => parse(xml)).not.toThrow();
    expect(item(xml, 'clipitem', 'clipitem-v1')).toMatchObject({ start: '0', end: '20', in: '10', out: '30', duration: '250' });
    expect(item(xml, 'clipitem', 'clipitem-v2')).toMatchObject({ start: '20', end: '80', in: '100', out: '160', duration: '250' });
    // Sequence length is the sum of the shots, not of the files.
    expect(xml).toMatch(/<sequence id="sequence-1">\s*<name>Test Sequence<\/name>\s*<duration>80<\/duration>/);
  });

  test('the file is declared once with its full length', () => {
    const xml = premiereXml(makeSeq({ clips }));
    expect(xml.match(/<file id="file-src">/g)).toHaveLength(1);
    expect(xml).toMatch(/<file id="file-src">\s*<name>clip.mp4<\/name>\s*<pathurl>media\/clip.mp4<\/pathurl>\s*<rate>[\s\S]*?<\/rate>\s*<duration>250<\/duration>/);
  });

  test('A1 follows the trimmed V1 clips', () => {
    const xml = premiereXml(makeSeq({ clips }));
    expect(item(xml, 'clipitem', 'clipitem-a2')).toMatchObject({ start: '20', end: '80', in: '100', out: '160' });
  });
});

describe('premiereXml: transitions', () => {
  const f1 = makeFile({ key: 'a', name: 'a.mp4', path: 'media/a.mp4', durationFrames: 250 });
  const f2 = makeFile({ key: 'b', name: 'b.mp4', path: 'media/b.mp4', durationFrames: 250 });

  test('a dissolve starts at the cut, uses the outgoing tail, and leaves both clips where they are', () => {
    const xml = premiereXml(makeSeq({
      clips: [
        { file: f1, startFrame: 0, inFrame: 10, outFrame: 60, transitionOut: { kind: 'dissolve', frames: 10 } },
        { file: f2, startFrame: 50, inFrame: 0, outFrame: 40 },
      ],
    }));
    expect(() => parse(xml)).not.toThrow();
    // FCP7: start/end next to a transition are -1, in/out stay at the edit point.
    expect(item(xml, 'clipitem', 'clipitem-v1')).toMatchObject({ start: '0', end: '-1', in: '10', out: '60' });
    expect(item(xml, 'clipitem', 'clipitem-v2')).toMatchObject({ start: '-1', end: '90', in: '0', out: '40' });
    expect(item(xml, 'transitionitem')).toMatchObject({ start: '50', end: '60', alignment: 'start' });
    expect(xml).toContain('<effectid>Cross Dissolve</effectid>');
    // Between the two clips on V1.
    expect(xml.indexOf('<transitionitem>')).toBeGreaterThan(xml.indexOf('id="clipitem-v1"'));
    expect(xml.indexOf('<transitionitem>')).toBeLessThan(xml.indexOf('id="clipitem-v2"'));
    // A1 keeps plain positions.
    expect(item(xml, 'clipitem', 'clipitem-a1')).toMatchObject({ start: '0', end: '50' });
    expect(item(xml, 'clipitem', 'clipitem-a2')).toMatchObject({ start: '50', end: '90' });
  });

  test('a dip to black is centred on the cut and is black', () => {
    const xml = premiereXml(makeSeq({
      clips: [
        { file: f1, startFrame: 0, inFrame: 0, outFrame: 50, transitionOut: { kind: 'dip_black', frames: 10 } },
        { file: f2, startFrame: 50, inFrame: 20, outFrame: 70 },
      ],
    }));
    expect(() => parse(xml)).not.toThrow();
    expect(item(xml, 'transitionitem')).toMatchObject({ start: '45', end: '55', alignment: 'center' });
    expect(xml).toContain('<effectid>Dip to Color Dissolve</effectid>');
    expect(xml).toMatch(/<parameterid>color<\/parameterid>[\s\S]*?<alpha>255<\/alpha>\s*<red>0<\/red>\s*<green>0<\/green>\s*<blue>0<\/blue>/);
  });

  test('a transition on the last clip is ignored', () => {
    const xml = premiereXml(makeSeq({ clips: [{ file: f1, startFrame: 0, outFrame: 50, transitionOut: { kind: 'dissolve', frames: 10 } }] }));
    expect(xml).not.toContain('<transitionitem>');
    expect(item(xml, 'clipitem', 'clipitem-v1')).toMatchObject({ start: '0', end: '50' });
  });

  test('cuts write no transition', () => {
    const xml = premiereXml(makeSeq({ clips: [{ file: f1, startFrame: 0, outFrame: 50 }, { file: f2, startFrame: 50, outFrame: 50 }] }));
    expect(xml).not.toContain('<transitionitem>');
    expect(xml).not.toContain('<end>-1</end>');
  });
});

describe('premiereXml: narration (A3)', () => {
  const voice = (n: number, durationFrames: number): PremiereFile =>
    ({ key: `voice-L00${n}`, name: `voice-L00${n}.wav`, path: `media/voice-L00${n}.wav`, durationFrames, width: 0, height: 0, hasAudio: true });

  test('one clip per line at its start, playing the whole WAV, on the track after the music', () => {
    const musicFile = makeFile({ key: 'm', name: 'music.mp3', path: 'media/music.mp3', durationFrames: 500, width: 0, height: 0 });
    const xml = premiereXml(makeSeq({
      sourceAudioMuted: true,
      music: { file: musicFile, gainDb: -18 },
      narration: [{ file: voice(1, 40), startFrame: 8 }, { file: voice(2, 20), startFrame: 60 }],
    }));
    expect(() => parse(xml)).not.toThrow();
    expect(item(xml, 'clipitem', 'clipitem-n1')).toMatchObject({ start: '8', end: '48', in: '0', out: '40', duration: '40' });
    expect(item(xml, 'clipitem', 'clipitem-n2')).toMatchObject({ start: '60', end: '80' });
    expect(xml).not.toMatch(/clipitem-n1[\s\S]*Audio Levels[\s\S]*clipitem-n2/);
    // Tracks in <audio>: A1 (empty, muted), A2 music, A3 narration.
    const audio = xml.slice(xml.indexOf('<audio>\n'));
    const tracks = audio.split('<track>').slice(1);
    expect(tracks).toHaveLength(3);
    expect(tracks[1]).toContain('clipitem-m1');
    expect(tracks[2]).toContain('clipitem-n1');
  });

  test('no narration track without lines', () => {
    const xml = premiereXml(makeSeq({ narration: [] }));
    expect(xml).not.toContain('clipitem-n');
  });
});

describe('premiereXml: music ducking', () => {
  const musicFile: PremiereFile = { key: 'm', name: 'music.mp3', path: 'media/music.mp3', durationFrames: 200, width: 0, height: 0, hasAudio: true };

  test('the music drops by duck.gainDb under each window, with attack and release ramps', () => {
    // Sequence 100 frames; window [20, 50], -6 dB (0.50119), attack 5, release 10.
    const xml = premiereXml(makeSeq({
      clips: [{ file: makeFile({ durationFrames: 100, hasAudio: false }), startFrame: 0 }],
      music: { file: musicFile, gainDb: 0, duck: { windows: [{ startFrame: 20, endFrame: 50 }], gainDb: -6, attackFrames: 5, releaseFrames: 10 } },
    }));
    expect(keyframes(xml, 'clipitem-m1')).toEqual([[0, 1], [20, 1], [25, 0.50119], [50, 0.50119], [60, 1], [100, 1]]);
  });

  test('ducking multiplies the music level and its fades', () => {
    // -18 dB = 0.12589, fade-in 10; window [5, 30] at -6 dB: at frame 10 the fade is done and the duck is full.
    const xml = premiereXml(makeSeq({
      clips: [{ file: makeFile({ durationFrames: 100, hasAudio: false }), startFrame: 0 }],
      music: { file: musicFile, gainDb: -18, fadeInFrames: 10, duck: { windows: [{ startFrame: 5, endFrame: 30 }], gainDb: -6, attackFrames: 5, releaseFrames: 5 } },
    }));
    const kf = new Map(keyframes(xml, 'clipitem-m1'));
    expect(kf.get(10)).toBe(0.0631); // 0.12589 × 0.50119
    expect(kf.get(35)).toBe(0.12589);
  });

  test('no keyframes for empty windows', () => {
    const xml = premiereXml(makeSeq({ music: { file: musicFile, gainDb: -6, duck: { windows: [], gainDb: -8, attackFrames: 5, releaseFrames: 12 } } }));
    expect(xml).not.toContain('<keyframe>');
  });
});

describe('captionsSrt', () => {
  test('numbers the cues and writes SubRip times', () => {
    expect(captionsSrt([
      { start: 0.3, end: 2.05, lines: ['Chợ nổi Cái Răng', 'họp từ sáng sớm'] },
      { start: 3661.5, end: 3663, lines: ['Một dòng'] },
    ])).toBe('1\n00:00:00,300 --> 00:00:02,050\nChợ nổi Cái Răng\nhọp từ sáng sớm\n\n2\n01:01:01,500 --> 01:01:03,000\nMột dòng\n');
  });

  test('empty for no cues', () => {
    expect(captionsSrt([])).toBe('');
  });
});

// ---- PREMIERE_README_VI ----

describe('PREMIERE_README_VI', () => {
  test('contains expected Vietnamese instructions', () => {
    expect(PREMIERE_README_VI).toContain('File > Import');
    expect(PREMIERE_README_VI).toContain('project.xml');
    expect(PREMIERE_README_VI).toContain('Relink others automatically');
  });
});

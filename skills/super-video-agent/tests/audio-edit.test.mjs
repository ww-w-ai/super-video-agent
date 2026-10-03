import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectQuiet, editPcm, finishEdit, applyAudioEdits } from '../scripts/lib/audio-edit.mjs';
import { decodeMonoPcm } from '../scripts/lib/audio-analysis.mjs';
import { writeWavMono16, quietestSample } from '../scripts/voice/line-edit.mjs';

const CLI = fileURLToPath(new URL('../scripts/audio-edit.mjs', import.meta.url));
const RATE = 48000;
const pcm = () => Float32Array.from([.5, .5, 0, 0, 0, 0, .25, .25, 0, 0]);
const words = [{ w: 'one', start: 0, end: .2 }, { w: 'two', start: .6, end: .8 }];
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sva-audio-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tone(rate = RATE, seconds = 1) {
  return Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => {
    const time = i / rate;
    return (time >= .2 && time < .6) || time >= seconds - .2 ? 0 : Math.round(10000 * Math.sin(2 * Math.PI * 440 * time));
  });
}

function setup(t) {
  const dir = temp(t), input = path.join(dir, 'input.wav'), edits = path.join(dir, 'edits.json');
  writeWavMono16(input, tone(), RATE);
  fs.writeFileSync(edits, JSON.stringify({ pauses: [{ start: .2, end: .6, duration: .1 }], padStartSec: .05, padEndSec: .05 }));
  return { dir, input, edits, output: path.join(dir, 'new.wav') };
}

function cli(args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('explicit contraction preserves unedited samples and shifts words; expansion and edge padding also map', () => {
  const input = pcm();
  const shrunk = finishEdit(editPcm(input, 10, { pauses: [{ start: .2, end: .6, duration: .2 }] }, words));
  assert.deepEqual([...shrunk.samples], [.5, .5, 0, 0, .25, .25, 0, 0]);
  near(shrunk.report.words[1].start, .4);
  near(shrunk.report.words[1].end, .6);
  assert.deepEqual([...input], [...pcm()]);
  const grown = finishEdit(editPcm(input, 10, { pauses: [{ start: .2, end: .6, duration: .7 }], padStartSec: .1, padEndSec: .2 }, words));
  assert.equal(grown.samples.length, 16);
  assert.deepEqual([...grown.samples.slice(10, 12)], [.25, .25]);
  near(grown.report.words[1].start, 1);
  near(grown.report.words[1].end, 1.2);
  assert.deepEqual([...grown.samples.slice(-4)], [0, 0, 0, 0]);
});

test('multiple pause edits and words crossing a quiet interval retain continuous mapped times', () => {
  const result = finishEdit(editPcm(pcm(), 10, { pauses: [{ start: .8, end: 1, duration: .4 }, { start: .2, end: .6, duration: 0 }] }, [{ w: 'whole', start: 0, end: .8 }]));
  assert.deepEqual([...result.samples], [.5, .5, .25, .25, 0, 0, 0, 0]);
  assert.deepEqual(result.report.words, [{ w: 'whole', start: 0, end: .4 }]);
});

test('quiet detection is advisory and reuses quietestSample; a transient blocks an explicit edit', () => {
  const samples = new Float32Array(1000);
  samples[500] = .01;
  const report = inspectQuiet(samples, 1000);
  assert.equal(report.advisory, true);
  assert.ok(report.candidates.length);
  const candidate = report.candidates[0];
  assert.equal(candidate.quietestPoint, quietestSample(samples, 1000, candidate.start, candidate.end) / 1000);
  assert.throws(() => editPcm(samples, 1000, { pauses: [{ start: .4, end: .6, duration: .1 }] }), /nonquiet/);
});

test('invalid edits reject nonfinite, overlap, out-of-range, unknown fields, and speech damage', () => {
  for (const edits of [
    { tempo: NaN }, { tempo: 0 }, { tempo: 3 }, { padStartSec: Infinity }, { padEndSec: -1 },
    { pauses: [{ start: .2, end: .6, duration: NaN }] },
    { pauses: [{ start: .2, end: 1.1, duration: 0 }] },
    { pauses: [{ start: .2, end: .6, duration: 0 }, { start: .5999, end: .8, duration: 0 }] },
    { pauses: [{ start: 0, end: .3, duration: 0 }] }, { pause: [] },
  ]) assert.throws(() => editPcm(pcm(), 10, edits));
  assert.throws(() => editPcm(Float32Array.of(NaN), 10, {}), /nonfinite/);
  assert.throws(() => editPcm(pcm(), 10, {}, [{ w: 'a', start: .1, end: Infinity }]), /finite/);
  assert.throws(() => editPcm(pcm(), 10, {}, [{ w: 'a', start: 0, end: .2 }, { w: 'b', start: .1, end: .3 }]), /nonoverlapping/);
});

test('a removed pause may not silently collapse an attached word', () => {
  assert.throws(() => editPcm(pcm(), 10, { pauses: [{ start: .2, end: .6, duration: 0 }] }, [{ w: 'bad alignment', start: .3, end: .5 }]), /collapses word/);
});

test('injected tempo mapping keeps final padding seconds and rejects a too-short adapter result', async () => {
  const result = await applyAudioEdits({ samples: pcm(), sampleRate: 10, edits: { tempo: 2, padStartSec: .2, padEndSec: .1 }, words },
    { tempoPcm: async (samples, rate, tempo) => { assert.equal(rate, 10); assert.equal(tempo, 2); return samples.filter((_, i) => i % 2 === 0); } });
  assert.equal(result.samples.length, 8);
  near(result.report.words[1].start, .5);
  near(result.report.words[1].end, .6);
  await assert.rejects(() => applyAudioEdits({ samples: pcm(), sampleRate: 10, edits: { tempo: 2 }, words }, { tempoPcm: async () => Float32Array.of(0) }), /before a mapped word/);
});

test('CLI real WAV contraction produces a new 48k mono WAV, correct words, and identical retained speech', async (t) => {
  const f = setup(t), before = fs.readFileSync(f.input), sidecar = path.join(f.dir, 'words.json');
  fs.writeFileSync(sidecar, JSON.stringify({ words: [{ w: 'first', start: .05, end: .15 }, { w: 'second', start: .65, end: .75 }] }));
  cli([f.input, '--edits', f.edits, '--out', f.output, '--words', sidecar]);
  const decoded = await decodeMonoPcm(f.output, RATE), original = await decodeMonoPcm(f.input, RATE);
  assert.equal(decoded.length, Math.round(.8 * RATE));
  assert.deepEqual([...decoded.slice(2400, 12000)], [...original.slice(0, 9600)]);
  assert.deepEqual([...decoded.slice(16800, 26400)], [...original.slice(28800, 38400)]);
  const report = JSON.parse(fs.readFileSync(`${f.output}.json`));
  near(report.words[1].start, .4); near(report.words[1].end, .5);
  assert.deepEqual(fs.readFileSync(f.input), before);
});

test('CLI inspect writes no files; invalid speech edit fails before output reservation', (t) => {
  const f = setup(t), before = fs.readdirSync(f.dir);
  const report = JSON.parse(cli([f.input, '--inspect']));
  assert.ok(report.candidates.some((p) => p.start <= .2 && p.end >= .6));
  assert.deepEqual(fs.readdirSync(f.dir), before);
  fs.writeFileSync(f.edits, JSON.stringify({ pauses: [{ start: 0, end: .1, duration: 0 }] }));
  assert.throws(() => cli([f.input, '--edits', f.edits, '--out', f.output]), /nonquiet/);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.existsSync(`${f.output}.json`), false);
});

test('CLI rejects input/output and sidecar aliases including symlinks, hardlinks, and shared destination', (t) => {
  const f = setup(t), link = path.join(f.dir, 'link.wav'), hard = path.join(f.dir, 'hard.wav');
  fs.symlinkSync(f.input, link); fs.linkSync(f.input, hard);
  for (const output of [f.input, link, hard]) assert.throws(() => cli([f.input, '--edits', f.edits, '--out', output]), /aliases an input/);
  assert.throws(() => cli([f.input, '--edits', f.edits, '--out', f.output, '--report', f.edits]), /aliases an input/);
  assert.throws(() => cli([f.input, '--edits', f.edits, '--out', f.output, '--report', f.output]), /paths alias/);
  const wordsPath = path.join(f.dir, 'words.json'); fs.writeFileSync(wordsPath, '{"words":[]}');
  assert.throws(() => cli([f.input, '--edits', f.edits, '--out', f.output, '--words', wordsPath, '--report', wordsPath]), /aliases an input/);
  assert.equal(fs.existsSync(f.output), false);
});

test('CLI real atempo changes duration and word times while preserving tone pitch', async (t) => {
  const f = setup(t), source = tone(RATE, 2), wordFile = path.join(f.dir, 'words.json');
  writeWavMono16(f.input, source, RATE);
  fs.writeFileSync(f.edits, JSON.stringify({ tempo: 1.25, padStartSec: .1, padEndSec: .1 }));
  fs.writeFileSync(wordFile, JSON.stringify({ words: [{ w: 'tone', start: .7, end: 1.7 }] }));
  cli([f.input, '--edits', f.edits, '--out', f.output, '--words', wordFile]);
  const report = JSON.parse(fs.readFileSync(`${f.output}.json`));
  near(report.words[0].start, .66); near(report.words[0].end, 1.46);
  near(report.outputDurationSec, 1.8, .05);
  const samples = await decodeMonoPcm(f.output, RATE), from = Math.round(.7 * RATE), to = Math.round(1.2 * RATE);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
  near(crossings / .5, 440, 6);
});

test('CLI expands an explicit quiet span and applies slow tempo with final padding', async (t) => {
  const f = setup(t), wordFile = path.join(f.dir, 'words.json');
  fs.writeFileSync(f.edits, JSON.stringify({ pauses: [{ start: .2, end: .6, duration: .6 }], tempo: .8, padStartSec: .05, padEndSec: .1 }));
  fs.writeFileSync(wordFile, JSON.stringify({ words: [{ w: 'later', start: .65, end: .75 }] }));
  cli([f.input, '--edits', f.edits, '--out', f.output, '--words', wordFile]);
  const report = JSON.parse(fs.readFileSync(`${f.output}.json`));
  near(report.words[0].start, 1.1125); near(report.words[0].end, 1.2375);
  near(report.outputDurationSec, 1.65, .06);
  const samples = await decodeMonoPcm(f.output, RATE);
  assert.ok(samples.slice(Math.round(.4 * RATE), Math.round(.9 * RATE)).every((v) => v === 0));
  assert.ok(samples.slice(-Math.round(.1 * RATE)).every((v) => v === 0));
});

#!/usr/bin/env node
/** Provider-independent local WAV editing. Never calls a voice provider or loads a model. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { abs, parseArgs } from './lib/cli.mjs';
import { run } from './lib/ffmpeg.mjs';
import { decodeMonoPcm } from './lib/audio-analysis.mjs';
import { inspectQuiet, applyAudioEdits, spliceSpan } from './lib/audio-edit.mjs';

const RATE = 48000;
const HELP = `Usage:
  node audio-edit.mjs input.wav --inspect
  node audio-edit.mjs input.wav --edits edits.json --out new.wav [--words words.json] [--report new.json]

  node audio-edit.mjs input.wav --splice take.wav --at 12.5 --out new.wav [--report new.json]

--splice: replace only the span starting at --at (seconds) with take.wav, which must already be the
span's length (mono WAV). 20 ms equal-power crossfade at each edge; the output has exactly the
input's sample count, so nothing after the span moves. The span must end inside the input.

Edits: {"pauses":[{"start":0.4,"end":0.8,"duration":0.2}],"padStartSec":0,"padEndSec":0,"tempo":1}
Pause times are input-relative seconds. Padding is final seconds after tempo.
Words: {"words":[{"w":"hello","start":0.1,"end":0.3}]}
Outputs must be new files. Default report: <out>.json. --inspect writes only JSON to stdout.
`;

function required(flags, name) {
  if (typeof flags[name] !== 'string' || !flags[name]) throw new Error(`--${name} needs a path`);
  return abs(flags[name]);
}

function configFrom(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) return { help: true };
  for (const key of Object.keys(flags)) {
    if (!['inspect', 'edits', 'out', 'words', 'report', 'splice', 'at'].includes(key)) throw new Error(`unknown flag: --${key}`);
  }
  if (positional.length !== 1) throw new Error('one input WAV is required; use --help');
  const input = abs(positional[0]);
  if (flags.inspect !== undefined) {
    if (flags.inspect !== true || Object.keys(flags).length !== 1) throw new Error('--inspect cannot be combined with edit/output flags');
    return { input, inspect: true };
  }
  const output = required(flags, 'out');
  if (path.extname(output).toLowerCase() !== '.wav') throw new Error('--out must end in .wav');
  const report = flags.report === undefined ? `${output}.json` : required(flags, 'report');
  if (flags.splice !== undefined) return spliceConfig(flags, { input, output, report });
  if (flags.at !== undefined) throw new Error('--at belongs to --splice');
  return { input, output, edits: required(flags, 'edits'),
    words: flags.words === undefined ? null : required(flags, 'words'), report };
}

function spliceConfig(flags, base) {
  for (const key of ['edits', 'words']) if (flags[key] !== undefined) throw new Error(`--splice cannot be combined with --${key}`);
  const at = typeof flags.at === 'string' ? Number(flags.at) : NaN;
  if (!Number.isFinite(at) || at < 0) throw new Error('--splice needs --at <start seconds>');
  return { ...base, splice: required(flags, 'splice'), at };
}

function identity(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  return { dev: stat.dev, ino: stat.ino, real: fs.realpathSync(file) };
}

function prospectivePath(file) {
  return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
}

function validateDestinations(config) {
  const sources = [config.input, config.edits, config.words, config.splice].filter(Boolean).map(identity);
  const outputs = [config.output, config.report];
  if (prospectivePath(outputs[0]) === prospectivePath(outputs[1])) throw new Error('audio and report paths alias');
  for (const file of outputs) {
    try {
      fs.lstatSync(file);
      try {
        const target = identity(file);
        if (sources.some((s) => s.real === target.real || (s.dev === target.dev && s.ino === target.ino))) {
          throw new Error(`output aliases an input: ${file}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      throw new Error(`output already exists: ${file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function probeInput(file) {
  identity(file);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const info = JSON.parse(stdout.toString());
  const streams = info.streams.filter((s) => s.codec_type === 'audio');
  if (info.format?.format_name !== 'wav' || streams.length !== 1 || streams[0].channels !== 1) {
    throw new Error('input must be a mono WAV with one audio stream');
  }
}

function pcmBytes(samples) {
  const buffer = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) buffer.writeFloatLE(samples[i], i * 4);
  return buffer;
}

async function convertPcm(samples, sampleRate, outputArgs) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(sampleRate),
    '-ac', '1', '-i', 'pipe:0', ...outputArgs, 'pipe:1'], { input: pcmBytes(samples) });
}

async function tempoPcm(samples, sampleRate, tempo) {
  const { stdout } = await convertPcm(samples, sampleRate, ['-af', `atempo=${tempo}`, '-f', 'f32le']);
  const output = new Float32Array(stdout.length / 4);
  for (let i = 0; i < output.length; i++) output[i] = stdout.readFloatLE(i * 4);
  return output;
}

function removeReservation(entry) {
  fs.closeSync(entry.fd);
  try {
    const current = fs.lstatSync(entry.file);
    if (current.dev === entry.stat.dev && current.ino === entry.stat.ino) fs.unlinkSync(entry.file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeNewPair(output, wav, reportFile, report) {
  const reserved = [];
  try {
    for (const file of [output, reportFile]) {
      const fd = fs.openSync(file, 'wx');
      reserved.push({ file, fd, stat: fs.fstatSync(fd) });
    }
    fs.writeFileSync(reserved[0].fd, wav);
    fs.writeFileSync(reserved[1].fd, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    for (const entry of reserved) removeReservation(entry);
    throw error;
  }
  for (const entry of reserved) fs.closeSync(entry.fd);
}

/** --splice: replace one span of the input with a same-length take; the output keeps the input's exact length. */
async function runSplice(config, samples) {
  await probeInput(config.splice);
  const replacement = await decodeMonoPcm(config.splice, RATE);
  const { samples: spliced, report: spliceReport } = spliceSpan(samples, replacement, Math.round(config.at * RATE), RATE);
  const { stdout: wav } = await convertPcm(spliced, RATE, ['-c:a', 'pcm_f32le', '-f', 'wav']);
  const report = { ...spliceReport, input: config.input, replacement: config.splice, output: config.output };
  validateDestinations(config);
  writeNewPair(config.output, wav, config.report, report);
  process.stdout.write(`${JSON.stringify({ output: config.output, report: config.report, samples: spliced.length, durationSec: spliced.length / RATE })}\n`);
  return report;
}

/** Run the CLI; returns the report for local integration tests and callers. */
export async function main(argv = process.argv.slice(2)) {
  const config = configFrom(argv);
  if (config.help) { process.stdout.write(HELP); return null; }
  if (!config.inspect) validateDestinations(config);
  await probeInput(config.input);
  const samples = await decodeMonoPcm(config.input, RATE);
  if (config.inspect) {
    const report = inspectQuiet(samples, RATE);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (config.splice) return runSplice(config, samples);
  const edits = JSON.parse(fs.readFileSync(config.edits, 'utf8'));
  const sidecar = config.words ? JSON.parse(fs.readFileSync(config.words, 'utf8')) : { words: [] };
  if (!sidecar || !Array.isArray(sidecar.words)) throw new Error('word sidecar must contain a words array');
  const edited = await applyAudioEdits({ samples, sampleRate: RATE, edits, words: sidecar.words }, { tempoPcm });
  const { stdout: wav } = await convertPcm(edited.samples, RATE, ['-c:a', 'pcm_f32le', '-f', 'wav']);
  const report = { ...edited.report, input: config.input, output: config.output };
  validateDestinations(config);
  writeNewPair(config.output, wav, config.report, report);
  process.stdout.write(`${JSON.stringify({ output: config.output, report: config.report, durationSec: report.outputDurationSec })}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
}

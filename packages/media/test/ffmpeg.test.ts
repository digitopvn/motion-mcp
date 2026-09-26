import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectBlack,
  extractFrame,
  finishMp4,
  parseBlackDetect,
  parseProbeJson,
  parseRational,
  probe,
  tileImages,
} from "../src/ffmpeg.ts";

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status === 0;

describe("ffmpeg parsers", () => {
  it("parses rationals", () => {
    expect(parseRational("30/1")).toBe(30);
    expect(parseRational("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRational("0/0")).toBe(0);
    expect(parseRational(undefined)).toBe(0);
  });

  it("normalizes ffprobe json", () => {
    const p = parseProbeJson(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30/1",
            pix_fmt: "yuv420p",
          },
          { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
        ],
        format: { duration: "3.000000", size: "1234" },
      }),
    );
    expect(p).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 3,
      codec: "h264",
      hasAudio: true,
    });
    expect(p.audioSampleRate).toBe(48000);
  });

  it("rejects probes without video", () => {
    expect(() => parseProbeJson(JSON.stringify({ streams: [{ codec_type: "audio" }] }))).toThrow(/no video/);
    expect(() => parseProbeJson("not json")).toThrow(/invalid JSON/);
  });

  it("parses blackdetect output", () => {
    const segs = parseBlackDetect(
      "[blackdetect @ 0x1] black_start:0 black_end:1.0 black_duration:1.0\nnoise\n[blackdetect @ 0x1] black_start:2.5 black_end:3 black_duration:0.5",
    );
    expect(segs).toEqual([
      { start: 0, end: 1, duration: 1 },
      { start: 2.5, end: 3, duration: 0.5 },
    ]);
  });
});

describe.skipIf(!hasFfmpeg)("ffmpeg integration", () => {
  let dir: string;
  let source: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "motion-ffmpeg-"));
    source = join(dir, "source.mp4");
    // 1 s black followed by 1 s test pattern, with a sine tone, encoded as raw-ish mpeg4.
    const r = spawnSync(
      ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:r=25:d=1",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=640x360:r=25:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=2",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-c:v",
        "mpeg4",
        "-c:a",
        "aac",
        source,
      ],
      { windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr?.toString()}`);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("probes a video", async () => {
    const p = await probe(source);
    expect(p).toMatchObject({ width: 640, height: 360, fps: 25, hasAudio: true });
    expect(p.duration).toBeCloseTo(2, 0);
  });

  it("finishes to H.264/yuv420p/AAC 48k with optional downscale", async () => {
    const out = join(dir, "finished.mp4");
    const p = await finishMp4(source, out, { maxHeight: 180 });
    expect(p).toMatchObject({ codec: "h264", pixFmt: "yuv420p", width: 320, height: 180, hasAudio: true });
    expect(p.audioSampleRate).toBe(48000);
  });

  it("extracts frames and tiles them into a contact sheet", async () => {
    const a = await extractFrame(source, 0.5, join(dir, "a.png"));
    const b = await extractFrame(source, 1.5, join(dir, "b.png"));
    const sheet = await tileImages([a, b, b], join(dir, "sheet.png"), {
      columns: 2,
      tileWidth: 320,
      gap: 10,
    });
    const p = await probe(sheet);
    expect(p.width).toBe(2 * 320 + 3 * 10);
    expect(p.height).toBe(2 * 180 + 3 * 10);
  });

  it("detects the black lead-in", async () => {
    const segs = await detectBlack(source, { minDuration: 0.5 });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBeCloseTo(1, 1);
  });

  it("rejects invalid frame times", async () => {
    await expect(extractFrame(source, -1, join(dir, "x.png"))).rejects.toThrow(/invalid frame time/);
  });
});

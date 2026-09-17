import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, sceneDuration, sourceTime } from "../src/timeline.ts";
import { newClip, newScene } from "../src/types.ts";
import type { Asset } from "../src/types.ts";

const audio = { id: "voice", duration: 10, kind: "voice" } as Asset;
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("outgoing transitions overlap adjacent scenes, bounded by half of each duration", () => {
  const first = {
    ...newScene(),
    duration: 4,
    transition: { type: "fade" as const, duration: 3 },
  };
  const second = {
    ...newScene(),
    duration: 2,
    transition: { type: "slide_left" as const, duration: 2 },
  };
  const third = { ...newScene(), duration: 3 };
  const timeline = buildTimeline({ scenes: [first, second, third] }, []);
  assert.deepEqual(
    timeline.map(({ start, end, overlap }) => ({ start, end, overlap })),
    [
      { start: 0, end: 4, overlap: 0 },
      { start: 3, end: 5, overlap: 1 },
      { start: 4, end: 7, overlap: 1 },
    ],
  );
});

test("preview and 30fps export use the same scene and transition frame grid", () => {
  const first = {
    ...newScene(),
    duration: 0.15,
    transition: { type: "fade" as const, duration: 0.1 },
  };
  const second = { ...newScene(), duration: 0.15 };
  const timeline = buildTimeline({ scenes: [first, second] }, []);
  close(timeline[0].duration, 5 / 30);
  close(timeline[1].overlap, 2 / 30);
  close(timeline[1].start, 3 / 30);
  close(timeline[1].end, 8 / 30);
});

test("automatic duration incorporates trim, speed, offset, and does not become infinite when looping", () => {
  const item = {
    ...newScene(),
    duration_mode: "voice" as const,
    voice_id: "voice",
    voice: {
      ...newClip(),
      trim_start: 2,
      trim_end: 8,
      speed: 2,
      offset: 0.5,
      loop: true,
    },
  };
  close(sceneDuration(item, [audio]), 3.5);
  close(
    sceneDuration({ ...item, voice: { ...item.voice, trim_end: null } }, [
      audio,
    ]),
    4.5,
  );
});

test("source time respects offset, half-open trim ending, speed and trimmed-range loops", () => {
  const clip = {
    ...newClip(),
    trim_start: 2,
    trim_end: 6,
    speed: 2,
    offset: 1,
  };
  assert.deepEqual(sourceTime(clip, audio, 0.5), { time: 2, active: false });
  assert.deepEqual(sourceTime(clip, audio, 1), { time: 2, active: true });
  assert.deepEqual(sourceTime(clip, audio, 2), { time: 4, active: true });
  assert.equal(sourceTime(clip, audio, 3).active, false);
  assert.deepEqual(sourceTime({ ...clip, loop: true }, audio, 3.25), {
    time: 2.5,
    active: true,
  });
});

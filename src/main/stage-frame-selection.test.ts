import { expect, it, vi } from 'vitest';
import { selectStageFrames } from './stage-frame-selection';
import { ScheduledSplitInference, splitRequests } from './split-inference';
import type { VideoFrame } from '../shared/video-contract';
import type { UnifiedInferenceRequest } from './unified-inference-request';

const frames: VideoFrame[] = [1000, 2000, 3000, 4000, 5000].map((observedAt) => ({
  observedAt,
  sourceId: 'camera',
  width: 1280,
  height: 720,
  dataUrl: 'data:image/jpeg;base64,AAAA',
}));
const stage = (strategy: 'uniform' | 'latest', maxFrames: number) => ({
  maxFrames,
  windowMs: 5000,
  strategy,
  maxWidth: 640,
  maxHeight: 360,
});

it('uses independent chronological temporal selections without resynthesizing timestamps', () => {
  expect(selectStageFrames(frames, 5000, stage('uniform', 3), 8).map((f) => f.observedAt)).toEqual([
    1000, 3000, 5000,
  ]);
  expect(selectStageFrames(frames, 5000, stage('latest', 2), 8).map((f) => f.observedAt)).toEqual([
    4000, 5000,
  ]);
  expect(selectStageFrames(frames, 5000, stage('latest', 4), 1).map((f) => f.observedAt)).toEqual([
    5000,
  ]);
});

it('rejects Hybrid image transmission when Chat lacks image capability', async () => {
  const scheduled = new ScheduledSplitInference();
  scheduled.configureHybrid(2);
  const vision = {
    capabilities: { images: true },
    complete: vi.fn(async () => ({
      raw: {},
      normalized: { sceneState: '', events: [], messages: [] },
    })),
  };
  const chat = {
    capabilities: { images: false },
    complete: vi.fn(async () => ({
      raw: {},
      normalized: { events: [], messages: [] },
    })),
  };
  await expect(
    scheduled.execute(
      {
        context: 'test',
        cycle: 1,
        frames,
        boundary: { fromSequence: 0, throughSequence: 0, fromMs: 1000, throughMs: 5000 },
      },
      { vision, chat },
      new AbortController().signal,
      undefined,
      {},
      {
        execution: 'asynchronous',
        visionIntervalMs: 100,
        chatIntervalMs: 100,
        maximumWaitMs: 0,
        maximumAgeMs: 3000,
        strictWait: false,
      },
      () => 5000,
    ),
  ).rejects.toThrow(/Chat model does not accept Hybrid image/);
  expect(chat.complete).not.toHaveBeenCalled();
});

it('submits stage-specific resized frames while preserving timestamps', async () => {
  const scheduled = new ScheduledSplitInference();
  scheduled.configureHybrid(2);
  const resize = vi.fn((frame: VideoFrame, width: number, height: number) => ({
    ...frame,
    width,
    height,
  }));
  scheduled.configureFrameResizer(resize);
  const vision = {
    capabilities: { images: true },
    complete: vi.fn(async (_request: UnifiedInferenceRequest) => ({
      raw: {},
      normalized: { sceneState: '', events: [], messages: [] },
    })),
  };
  const chat = {
    capabilities: { images: true },
    complete: vi.fn(async (_request: UnifiedInferenceRequest) => ({
      raw: {},
      normalized: { events: [], messages: [] },
    })),
  };
  const profile = {
    observer: { frameSampling: { ...stage('uniform', 3), maxWidth: 960, maxHeight: 540 } },
    chat: { frameSampling: { ...stage('latest', 2), maxWidth: 640, maxHeight: 360 } },
  };
  await scheduled.execute(
    {
      context: 'Race',
      cycle: 1,
      frames,
      chatFrames: frames,
      boundary: { fromSequence: 0, throughSequence: 1, fromMs: 1000, throughMs: 5000 },
      videoWindow: { fromMs: 1000, throughMs: 5000, truncated: false },
    },
    { vision, chat },
    new AbortController().signal,
    undefined,
    profile,
    {
      execution: 'sequential',
      strictWait: true,
      visionIntervalMs: 100,
      chatIntervalMs: 100,
      maximumWaitMs: 1000,
      maximumAgeMs: 10000,
    },
    () => 5000,
  );
  const visionRequest = vi.mocked(vision.complete).mock.calls[0][0];
  const chatRequest = vi.mocked(chat.complete).mock.calls[0][0];
  expect(
    visionRequest.content.filter((part) => part.type === 'image').map((part) => part.observedAt),
  ).toEqual([1000, 3000, 5000]);
  expect(
    chatRequest.content.filter((part) => part.type === 'image').map((part) => part.observedAt),
  ).toEqual([4000, 5000]);
  expect(resize.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [960, 540],
    [960, 540],
    [960, 540],
    [640, 360],
    [640, 360],
  ]);
});

it('never enlarges thumbnails to fake a higher-resolution source', () => {
  const thumbnails = frames.map((frame) => ({ ...frame, width: 320, height: 180 }));
  expect(selectStageFrames(thumbnails, 5000, stage('latest', 2), 2)).toEqual([]);
});

it('strict Split keeps Chat text-only while Hybrid includes timestamped chronological images', () => {
  const input = {
    context: 'Race',
    cycle: 1,
    frames,
    boundary: { fromSequence: 0, throughSequence: 1, fromMs: 1000, throughMs: 5000 },
    videoWindow: { fromMs: 1000, throughMs: 5000, truncated: false },
  };
  const strict = splitRequests(input).chat([], []);
  expect(strict.content.filter((part) => part.type === 'image')).toHaveLength(0);
  const hybrid = splitRequests({
    ...input,
    chatFrames: selectStageFrames(frames, 5000, stage('latest', 2), 2),
  }).chat([], []);
  expect(
    hybrid.content.filter((part) => part.type === 'image').map((part) => part.observedAt),
  ).toEqual([4000, 5000]);
  expect(hybrid.content[0]).toMatchObject({ type: 'text' });
});

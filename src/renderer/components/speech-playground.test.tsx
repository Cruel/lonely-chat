// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpeechPlayground } from './speech-playground';
import type { DesktopAPI } from '../../shared/chat-contract';
import type { SpeechTestStart, SpeechTestSnapshot } from '../../shared/speech-playground-contract';

const idle: SpeechTestSnapshot = {
  revision: 0,
  phase: 'idle',
  mode: null,
  sourceId: null,
  label: null,
  pending: 0,
  segments: [],
  error: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.lonelyChat;
});

it('routes uploaded synthetic audio through separate speech IPC without publishing Simulation chat', async () => {
  const samples = new Float32Array(16000).fill(0.1);
  const decoded = {
    sampleRate: 16000,
    length: samples.length,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      decodeAudioData = vi.fn(async () => decoded);
      close = close;
    },
  );
  const start = vi.fn(async (_request: SpeechTestStart) => ({
    ...idle,
    phase: 'ready' as const,
  }));
  const submit = vi.fn(async (_samples: Float32Array, _backpressure?: boolean) => idle);
  const finish = vi.fn(async () => idle);
  const stop = vi.fn(async () => idle);
  const chat = vi.fn();
  window.lonelyChat = {
    getSpeechTestStatus: async () => idle,
    onSpeechTestChange: () => () => {},
    startSpeechTest: start,
    submitSpeechTestPcm: submit,
    finishSpeechTest: finish,
    stopSpeechTest: stop,
    publishSample: chat,
  } as unknown as DesktopAPI;
  render(<SpeechPlayground simulationActive={false} />);
  const file = new File(['audio'], 'sample.wav', { type: 'audio/wav' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(8) });
  fireEvent.change(screen.getByLabelText('Audio file'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Start speech test' }));
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  expect(start).toHaveBeenCalledWith({
    mode: 'live-equivalent',
    sourceId: 'file',
    label: 'sample.wav',
    sampleRate: 16000,
  });
  expect(submit).toHaveBeenCalledTimes(10);
  expect(submit.mock.calls[0][0]).toBeInstanceOf(Float32Array);
  expect(submit.mock.calls.every((call) => call[1] === true)).toBe(true);
  await waitFor(() => expect(stop).toHaveBeenCalled());
  expect(chat).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it('disables starting during Simulation and surfaces native Whisper errors', async () => {
  const fail = vi.fn(async () => {
    throw new Error('whisper.cpp failed: no model');
  });
  window.lonelyChat = {
    getSpeechTestStatus: async () => idle,
    onSpeechTestChange: () => () => {},
    startSpeechTest: fail,
    stopSpeechTest: async () => idle,
  } as unknown as DesktopAPI;
  vi.stubGlobal(
    'AudioContext',
    class {
      decodeAudioData = async () => ({
        sampleRate: 16000,
        length: 16000,
        duration: 1,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(16000),
      });
      close = async () => {};
    },
  );
  const ui = render(<SpeechPlayground simulationActive={true} />);
  const file = new File(['audio'], 'sample.wav', { type: 'audio/wav' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(8) });
  fireEvent.change(screen.getByLabelText('Audio file'), { target: { files: [file] } });
  expect(screen.getByRole('button', { name: 'Start speech test' }).hasAttribute('disabled')).toBe(
    true,
  );
  ui.rerender(<SpeechPlayground simulationActive={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start speech test' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'whisper.cpp failed: no model',
  );
  expect(fail).toHaveBeenCalledOnce();
});

import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { NativeSpeech } from './native-speech';
import {
  SpeechFrameReader,
  SPEECH_INIT,
  SPEECH_READY,
  SPEECH_RESULT,
  speechFrame,
} from './speech-protocol';

const fixture = `
let bytes=Buffer.alloc(0);
process.stdin.on('data',(chunk)=>{
  bytes=Buffer.concat([bytes,chunk]);
  while(bytes.length>=4){
    const size=bytes.readUInt32LE(0);
    if(bytes.length<4+size)return;
    const op=bytes[4];
    bytes=bytes.subarray(size+4);
    const text=Buffer.from(op===1?'':'hello from test fixture');
    const out=Buffer.alloc(5+text.length);
    out.writeUInt32LE(text.length+1);out[4]=op===1?0x81:0x82;text.copy(out,5);
    process.stdout.write(out.subarray(0,2));
    process.stdout.write(out.subarray(2));
  }
});
`;

describe('native speech IPC and worker lifecycle', () => {
  it('parses arbitrarily split frames, rejects impossible lengths and truncated replies', () => {
    const bytes = speechFrame(SPEECH_READY);
    const reader = new SpeechFrameReader();
    expect(reader.push(bytes.subarray(0, 2))).toEqual([]);
    expect(reader.push(bytes.subarray(2))).toEqual([
      { opcode: SPEECH_READY, data: Buffer.alloc(0) },
    ]);
    reader.finish();
    expect(() => reader.push(Buffer.from([0, 0, 0, 0]))).toThrow(/size/);
    const short = new SpeechFrameReader();
    short.push(bytes.subarray(0, 3));
    expect(() => short.finish()).toThrow(/Truncated/);
    expect(speechFrame(SPEECH_INIT, Buffer.from('x'))).toHaveLength(6);
    expect(speechFrame(SPEECH_RESULT, Buffer.from('test'))[4]).toBe(SPEECH_RESULT);
  });

  it('readies a framed worker, transcribes deterministic PCM and stops without accepting late input', async () => {
    const launched = vi.fn(
      (
        command: string,
        _args: readonly string[],
        options: import('node:child_process').SpawnOptions,
      ) => spawn(command, ['-e', fixture], options),
    );
    const speech = new NativeSpeech({
      executable: process.execPath,
      resolveModel: async () => '/fixture/ggml-base.en.bin',
      launch: launched,
    });
    expect(speech.snapshot().phase).toBe('stopped');
    await speech.start();
    expect(speech.snapshot().phase).toBe('ready');
    expect(await speech.transcribe(new Float32Array(16000).fill(0.2))).toBe(
      'hello from test fixture',
    );
    expect(launched).toHaveBeenCalledTimes(1);
    await speech.shutdown();
    speech.stop();
    expect(speech.snapshot().phase).toBe('stopped');
    await expect(speech.transcribe(new Float32Array(20))).rejects.toThrow(/segment/);
  });

  it('ignores late binary stdout from a retired worker after restart', async () => {
    const children: import('node:child_process').ChildProcess[] = [];
    const speech = new NativeSpeech({
      executable: process.execPath,
      resolveModel: async () => '/fixture/ggml-base.en.bin',
      launch: (command, _args, options) => {
        const child = spawn(
          command,
          [
            '-e',
            fixture
              .replace(
                'process.stdout.write(out.subarray(0,2));',
                'setTimeout(()=>process.stdout.write(out.subarray(0,2)),40);',
              )
              .replace(
                'process.stdout.write(out.subarray(2));',
                'setTimeout(()=>process.stdout.write(out.subarray(2)),40);',
              ),
          ],
          options,
        );
        children.push(child);
        return child;
      },
    });
    await speech.start();
    await speech.shutdown();
    await speech.start();
    const pending = speech.transcribe(new Float32Array(1600));
    await new Promise((resolve) => setTimeout(resolve, 1));
    children[0].stdout?.emit('data', speechFrame(SPEECH_RESULT, Buffer.from('stale data')));
    await expect(pending).resolves.toBe('hello from test fixture');
    await speech.shutdown();
  });

  it('rejects invalid samples without communicating untrusted input', async () => {
    const speech = new NativeSpeech({
      executable: process.execPath,
      resolveModel: async () => 'fixture',
    });
    await expect(speech.transcribe(new Float32Array([Number.NaN]))).rejects.toThrow(/segment/);
    await expect(speech.transcribe(new Float32Array(1600).fill(2))).rejects.toThrow(/finite/);
  });
});

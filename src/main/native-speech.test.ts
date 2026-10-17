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
    await speech.start();
    expect(await speech.transcribe(new Float32Array(16000).fill(0.2))).toBe(
      'hello from test fixture',
    );
    expect(launched).toHaveBeenCalledTimes(1);
    speech.stop();
    await expect(speech.transcribe(new Float32Array(20))).rejects.toThrow(/segment/);
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

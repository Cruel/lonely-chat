/** Length-prefixed little-endian binary IPC. Never place arbitrary model paths in shell commands. */
export const MAX_SPEECH_FRAME = 16_000 * 4 * 30 + 32;
export const SPEECH_INIT = 1;
export const SPEECH_TRANSCRIBE = 2;
export const SPEECH_READY = 0x81;
export const SPEECH_RESULT = 0x82;
export const SPEECH_ERROR = 0xff;

export function speechFrame(opcode: number, data: Uint8Array = new Uint8Array()): Buffer {
  if (
    !Number.isInteger(opcode) ||
    opcode < 0 ||
    opcode > 255 ||
    data.byteLength + 1 > MAX_SPEECH_FRAME
  ) {
    throw new Error('Invalid speech IPC frame.');
  }
  const frame = Buffer.allocUnsafe(5 + data.byteLength);
  frame.writeUInt32LE(data.byteLength + 1, 0);
  frame[4] = opcode;
  Buffer.from(data).copy(frame, 5);
  return frame;
}

export class SpeechFrameReader {
  private bytes = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ opcode: number; data: Buffer }> {
    // A frame can arrive in arbitrarily sized stdout chunks.
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const replies: Array<{ opcode: number; data: Buffer }> = [];
    while (this.bytes.length >= 4) {
      const size = this.bytes.readUInt32LE(0);
      if (size < 1 || size > MAX_SPEECH_FRAME) throw new Error('Invalid native speech frame size.');
      if (this.bytes.length < size + 4) break;
      replies.push({ opcode: this.bytes[4], data: this.bytes.subarray(5, 4 + size) });
      this.bytes = this.bytes.subarray(4 + size);
    }
    return replies;
  }

  finish(): void {
    if (this.bytes.length !== 0) throw new Error('Truncated native speech IPC frame.');
  }
}

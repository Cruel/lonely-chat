/**
 * Inspect untrusted portable JPEG blobs without allocating decoded image surfaces.
 * Enforce a complete marker stream, a frame header, bounded encoded dimensions,
 * and the end-of-image marker. This intentionally does not replace the decoder;
 * it prevents arbitrary bytes and forged tiny dimension claims from entering archives.
 */
export function inspectJpeg(bytes: Buffer): { width: number; height: number } {
  const invalid = (): never => {
    throw new Error('Invalid imported JPEG structure or dimensions.');
  };
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let position = 2;
  let width = 0;
  let height = 0;
  let hasScan = false;
  let scanning = false;
  let scanData = false;
  while (position < bytes.length) {
    if (scanning && bytes[position] !== 0xff) {
      position++;
      scanData = true;
      continue;
    }
    if (bytes[position++] !== 0xff) invalid();
    while (position < bytes.length && bytes[position] === 0xff) position++;
    if (position >= bytes.length) invalid();
    const marker = bytes[position++];
    if (scanning && marker === 0x00) {
      scanData = true; // Entropy-coded literal FF byte.
      continue;
    }
    if (scanning && marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0xd9) {
      if (!hasScan || !scanData || !width || !height || position !== bytes.length) invalid();
      return { width, height };
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    scanning = false;
    if (position + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) invalid();
    const payload = position + 2;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (width || length < 11 || bytes[payload] !== 8) invalid();
      height = bytes.readUInt16BE(payload + 1);
      width = bytes.readUInt16BE(payload + 3);
      const components = bytes[payload + 5];
      if (
        width < 1 ||
        height < 1 ||
        width > 640 ||
        height > 360 ||
        components < 1 ||
        components > 4 ||
        length !== 8 + 3 * components
      )
        invalid();
    }
    if (marker === 0xda) {
      if (!width || !height || length < 6) invalid();
      hasScan = true;
      scanning = true;
    }
    position += length;
  }
  return invalid();
}

import { MAX_SIMULATION_FRAME_DATA_URL } from '../shared/video-contract';

/** Resize a decoded video frame to a maximum box, preserving aspect ratio without upscaling.
 * If JPEG output is too large for the recording/IPC contract, retry at lower resolution.
 */
export function captureSimulationFrame(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): { width: number; height: number; dataUrl: string } {
  if (![width, height, maxWidth, maxHeight].every((value) => Number.isFinite(value) && value > 0))
    throw new Error('Video capture dimensions are unavailable.');
  let scale = Math.min(1, maxWidth / width, maxHeight / height);
  for (let attempt = 0; attempt < 16; attempt++) {
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
    if (dataUrl.length <= MAX_SIMULATION_FRAME_DATA_URL)
      return { width: canvas.width, height: canvas.height, dataUrl };
    if (canvas.width === 1 && canvas.height === 1) break;
    scale *= 0.7;
  }
  throw new Error('Captured JPEG exceeds the permitted size even after downscaling.');
}

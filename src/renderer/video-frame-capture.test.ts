// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { captureSimulationFrame } from './video-frame-capture';

const source = {} as CanvasImageSource;

function surface(encoded: () => string = () => 'data:image/jpeg;base64,/9j/') {
  const canvas = {
    width: 0,
    height: 0,
    toDataURL: vi.fn(encoded),
  } as unknown as HTMLCanvasElement;
  const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  return { canvas, context };
}

it('fits 4K video into the requested bounds without stretching or upscaling', () => {
  const { canvas, context } = surface();
  expect(captureSimulationFrame(source, 3840, 2160, 960, 540, canvas, context)).toMatchObject({
    width: 960,
    height: 540,
  });
  expect(context.drawImage).toHaveBeenLastCalledWith(source, 0, 0, 960, 540);
  expect(captureSimulationFrame(source, 1080, 1920, 1280, 720, canvas, context)).toMatchObject({
    width: 405,
    height: 720,
  });
  expect(captureSimulationFrame(source, 160, 90, 1920, 1080, canvas, context)).toMatchObject({
    width: 160,
    height: 90,
  });
});

it('progressively reduces dimensions when encoded JPEG would exceed the safe transport budget', () => {
  let attempts = 0;
  const { canvas, context } = surface(() =>
    ++attempts === 1 ? 'x'.repeat(2_700_001) : 'data:image/jpeg;base64,/9j/',
  );
  expect(captureSimulationFrame(source, 1920, 1080, 1920, 1080, canvas, context)).toMatchObject({
    width: 1344,
    height: 756,
  });
  expect(context.drawImage).toHaveBeenCalledTimes(2);
  expect(canvas.toDataURL).toHaveBeenCalledTimes(2);
});

it('refuses invalid capture dimensions instead of submitting invalid frames', () => {
  const { canvas, context } = surface();
  expect(() => captureSimulationFrame(source, 0, 1080, 640, 360, canvas, context)).toThrow(
    /dimensions/,
  );
  expect(() => captureSimulationFrame(source, 1920, 1080, NaN, 360, canvas, context)).toThrow(
    /dimensions/,
  );
});

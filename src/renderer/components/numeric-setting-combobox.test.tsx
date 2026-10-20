// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { NumericSettingCombobox } from './numeric-setting-combobox';

afterEach(cleanup);

it('accepts a custom fractional-second setting on blur and a preset through the list', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <NumericSettingCombobox
      id="cycle"
      title="Inference cycle"
      name="cycleIntervalMs"
      value={3000}
      options={[1500, 3000, 5000]}
      unit="seconds"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'Inference cycle' });
  await user.clear(combo);
  await user.type(combo, '2.7');
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenCalledWith(2700);
  rerender(
    <NumericSettingCombobox
      id="cycle"
      title="Inference cycle"
      name="cycleIntervalMs"
      value={2700}
      options={[1500, 3000, 5000]}
      unit="seconds"
      disabled={false}
      onChange={onChange}
    />,
  );
  expect(combo).toHaveProperty('value', '2.7');
  await user.click(combo);
  await user.click(await screen.findByRole('option', { name: '5 seconds' }));
  expect(onChange).toHaveBeenLastCalledWith(5000);
});

it('rejects invalid or out-of-range text rather than saving it', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <NumericSettingCombobox
      id="timeout"
      title="Inference timeout"
      name="inferenceTimeoutMs"
      value={600000}
      options={[30000, 600000]}
      unit="seconds"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'Inference timeout' });
  for (const invalid of ['0', '9', '3601', 'oops', '1e2', '12.5']) {
    await user.clear(combo);
    await user.type(combo, invalid);
    fireEvent.blur(combo);
    expect(combo.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
  }
  await user.clear(combo);
  await user.type(combo, '180');
  fireEvent.keyDown(combo, { key: 'Enter', code: 'Enter' });
  expect(onChange).toHaveBeenCalledWith(180000);
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
});

it('accepts a 64k context window and advertises the 262k configuration ceiling', async () => {
  const onChange = vi.fn();
  render(
    <NumericSettingCombobox
      id="context"
      title="Context tokens (at next load)"
      name="contextTokens"
      value={16384}
      options={[16384, 32768, 65536, 131072, 262144]}
      unit="entries"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'Context tokens (at next load)' });
  fireEvent.change(combo, { target: { value: '65536' } });
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenCalledWith(65536);
  expect(screen.getByText(/262144 entries/)).toBeTruthy();
  fireEvent.change(combo, { target: { value: '262400' } });
  fireEvent.blur(combo);
  expect(combo.getAttribute('aria-invalid')).toBe('true');
});

it('allows arbitrary in-range context sizes above the presets and retains committed custom values', async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, setValue] = useState(16384);
    return (
      <NumericSettingCombobox
        id="custom-context"
        title="Context tokens"
        name="contextTokens"
        value={value}
        options={[2048, 4096, 8192, 16384]}
        unit="entries"
        disabled={false}
        onChange={setValue}
      />
    );
  }
  render(<Harness />);
  const combo = screen.getByRole('combobox', { name: 'Context tokens' });
  await user.clear(combo);
  await user.type(combo, '42000');
  await user.keyboard('{Enter}');
  expect(combo).toHaveProperty('value', '42000');
  await user.clear(combo);
  await user.type(combo, '65001');
  fireEvent.blur(combo);
  expect(combo).toHaveProperty('value', '65001');
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
  await user.clear(combo);
  await user.type(combo, '262145');
  fireEvent.blur(combo);
  expect(combo.getAttribute('aria-invalid')).toBe('true');
});

it('keeps minimum custom context tokens visible and valid after Enter, blur, and re-focus', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(16384);
    return (
      <NumericSettingCombobox
        id="context-512"
        title="Context tokens (at next load)"
        name="contextTokens"
        value={value}
        options={[2048, 4096, 8192, 16384, 32768, 65536]}
        unit="entries"
        disabled={false}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  const combo = screen.getByRole('combobox', { name: 'Context tokens (at next load)' });
  await user.clear(combo);
  await user.type(combo, '512');
  await user.keyboard('{Enter}');
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenLastCalledWith(512);
  expect(combo).toHaveProperty('value', '512');
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
  await user.click(combo);
  fireEvent.blur(combo);
  expect(combo).toHaveProperty('value', '512');
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
});

it('retains a custom value after blur and supports reopening the preset list', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(16384);
    return (
      <NumericSettingCombobox
        id="context-custom-blur"
        title="Context tokens"
        name="contextTokens"
        value={value}
        options={[2048, 4096, 8192, 16384]}
        unit="entries"
        disabled={false}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  const combo = screen.getByRole('combobox', { name: 'Context tokens' });
  await user.clear(combo);
  await user.type(combo, '512');
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenCalledWith(512);
  expect(combo).toHaveProperty('value', '512');
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
  await user.click(combo);
  fireEvent.blur(combo);
  expect(combo).toHaveProperty('value', '512');
});

it('treats a persisted custom value as selected when reopening its combobox', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(
    <NumericSettingCombobox
      id="persisted-context"
      title="Persisted context"
      name="contextTokens"
      value={16384}
      options={[2048, 4096, 8192, 16384]}
      unit="entries"
      disabled={false}
      onChange={onChange}
    />,
  );
  rerender(
    <NumericSettingCombobox
      id="persisted-context"
      title="Persisted context"
      name="contextTokens"
      value={512}
      options={[2048, 4096, 8192, 16384]}
      unit="entries"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'Persisted context' });
  expect(combo).toHaveProperty('value', '512');
  await user.click(combo);
  const custom = await screen.findByRole('option', { name: '512 entries' });
  expect(custom.getAttribute('aria-selected')).toBe('true');
  fireEvent.blur(combo);
  expect(combo).toHaveProperty('value', '512');
  expect(combo.getAttribute('aria-invalid')).not.toBe('true');
  expect(onChange).not.toHaveBeenCalled();
});

it('accepts the shared visual token cap, including 0 for model default', () => {
  const onChange = vi.fn();
  render(
    <NumericSettingCombobox
      id="image-cap"
      title="Max visual tokens per image"
      name="imageMaxTokens"
      value={0}
      options={[0, 16, 32, 64, 128, 256, 512, 1024]}
      unit="entries"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'Max visual tokens per image' });
  fireEvent.change(combo, { target: { value: '128' } });
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenCalledWith(128);
  fireEvent.change(combo, { target: { value: '8193' } });
  fireEvent.blur(combo);
  expect(combo.getAttribute('aria-invalid')).toBe('true');
});

it('accepts custom Simulation capture width/height values independently of presets', () => {
  const onWidth = vi.fn();
  const onHeight = vi.fn();
  render(
    <>
      <NumericSettingCombobox
        id="width"
        title="Maximum captured frame width"
        name="videoCaptureMaxWidth"
        value={320}
        options={[320, 640, 1280, 1920]}
        unit="entries"
        disabled={false}
        onChange={onWidth}
      />
      <NumericSettingCombobox
        id="height"
        title="Maximum captured frame height"
        name="videoCaptureMaxHeight"
        value={180}
        options={[180, 360, 720, 1080]}
        unit="entries"
        disabled={false}
        onChange={onHeight}
      />
    </>,
  );
  const width = screen.getByRole('combobox', { name: 'Maximum captured frame width' });
  const height = screen.getByRole('combobox', { name: 'Maximum captured frame height' });
  fireEvent.change(width, { target: { value: '1001' } });
  fireEvent.blur(width);
  fireEvent.change(height, { target: { value: '579' } });
  fireEvent.blur(height);
  expect(onWidth).toHaveBeenCalledWith(1001);
  expect(onHeight).toHaveBeenCalledWith(579);
  fireEvent.change(width, { target: { value: '1921' } });
  fireEvent.blur(width);
  expect(width.getAttribute('aria-invalid')).toBe('true');
});

it('accepts custom integer history counts but rejects fractions', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <NumericSettingCombobox
      id="count"
      title="History entry limit"
      name="historyMaxCount"
      value={32}
      options={[16, 32, 64]}
      unit="entries"
      disabled={false}
      onChange={onChange}
    />,
  );
  const combo = screen.getByRole('combobox', { name: 'History entry limit' });
  await user.clear(combo);
  await user.type(combo, '45.5');
  fireEvent.blur(combo);
  expect(onChange).not.toHaveBeenCalled();
  await user.clear(combo);
  await user.type(combo, '45');
  fireEvent.blur(combo);
  expect(onChange).toHaveBeenCalledWith(45);
});

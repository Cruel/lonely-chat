// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

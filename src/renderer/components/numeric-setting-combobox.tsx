import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  NUMERIC_PREFERENCE_LIMITS,
  validNumericPreference,
  type NumericPreference,
} from '../../shared/session-contract';

interface NumericSettingComboboxProps {
  id: string;
  title: string;
  name: NumericPreference;
  value: number;
  options: readonly number[];
  unit: 'seconds' | 'entries';
  disabled: boolean;
  onChange: (value: number) => void;
}

export function NumericSettingCombobox({
  id,
  title,
  name,
  value,
  options,
  unit,
  disabled,
  onChange,
}: NumericSettingComboboxProps) {
  const divisor = unit === 'seconds' ? 1000 : 1;
  const format = (number: number) => String(number / divisor);
  const [draft, setDraft] = useState(format(value));
  const [error, setError] = useState(false);
  const { min, max } = NUMERIC_PREFERENCE_LIMITS[name];

  useEffect(() => {
    setDraft(format(value));
    setError(false);
  }, [value, divisor]);

  const commit = (text: string) => {
    const normalized = text.trim();
    // Do not accept coercions such as empty strings, exponents, hex, NaN or infinity.
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
      setError(true);
      return;
    }
    const next = Number(normalized) * divisor;
    if (!validNumericPreference(name, next)) {
      setError(true);
      return;
    }
    setDraft(format(next));
    setError(false);
    if (next !== value) onChange(next);
  };

  const choices = options.map((option) => format(option));
  const minLabel = format(min);
  const maxLabel = format(max);

  return (
    <div>
      <Label htmlFor={id} className="text-sm text-zinc-200">
        {title}
      </Label>
      <Combobox
        items={choices}
        value={choices.includes(format(value)) ? format(value) : null}
        inputValue={draft}
        onInputValueChange={(next) => {
          setDraft(next);
          setError(false);
        }}
        onValueChange={(selected) => {
          if (selected !== null) commit(selected);
        }}
      >
        <ComboboxInput
          id={id}
          className="mt-2 w-full"
          disabled={disabled}
          aria-invalid={error || undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          onBlur={() => {
            if (draft !== format(value)) commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(draft);
          }}
        />
        <ComboboxContent>
          <ComboboxList>
            {choices.map((choice) => (
              <ComboboxItem key={choice} value={choice}>
                {choice} {unit}
              </ComboboxItem>
            ))}
          </ComboboxList>
          <ComboboxEmpty>Enter a custom value</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      <p id={`${id}-hint`} className={`mt-1 text-xs ${error ? 'text-rose-300' : 'text-zinc-500'}`}>
        {error
          ? `Enter a valid value between ${minLabel} and ${maxLabel} ${unit}.`
          : `${minLabel}–${maxLabel} ${unit} · choose a preset or enter a custom value`}
      </p>
    </div>
  );
}

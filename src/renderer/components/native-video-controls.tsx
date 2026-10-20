import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  NATIVE_VIDEO_LIMITS,
  type NativeVideoPreferences,
} from '../../shared/video-tools-contract';

const fields = [
  { key: 'fps', label: 'Video FPS', suffix: 'frames/s' },
  { key: 'timestampIntervalMs', label: 'Timestamp interval', suffix: 'ms' },
  { key: 'maxClipSizeMiB', label: 'Max clip size', suffix: 'MiB' },
  { key: 'maxClipDurationSeconds', label: 'Max clip duration', suffix: 'seconds' },
] as const;

/** Shared controls: global native-video defaults and optional Playground overrides. */
export function NativeVideoControls({
  value,
  onChange,
  disabled = false,
  prefix,
}: {
  readonly value: NativeVideoPreferences;
  readonly onChange: (value: NativeVideoPreferences) => void;
  readonly disabled?: boolean;
  readonly prefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map(({ key, label, suffix }) => (
        <div key={key}>
          <Label htmlFor={prefix + '-' + key}>
            {label} ({suffix})
          </Label>
          <Input
            id={prefix + '-' + key}
            type="number"
            className="mt-1"
            min={NATIVE_VIDEO_LIMITS[key].min}
            max={NATIVE_VIDEO_LIMITS[key].max}
            step={NATIVE_VIDEO_LIMITS[key].step}
            value={value[key]}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                [key]: event.target.value === '' ? NaN : Number(event.target.value),
              })
            }
          />
        </div>
      ))}
    </div>
  );
}

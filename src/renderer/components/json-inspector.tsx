import { useState } from 'react';
import { Button } from '@/components/ui/button';

function printable(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json === undefined ? String(value) : json;
}

function jsonPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`;
}

function SyntaxJson({ value }: { value: unknown }) {
  const source = printable(value);
  const tokens =
    /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g;
  const fragments: React.ReactNode[] = [];
  let previous = 0;
  for (const match of source.matchAll(tokens)) {
    const index = match.index;
    if (index > previous) fragments.push(source.slice(previous, index));
    const color = match[1]
      ? 'text-sky-300'
      : match[2]
        ? 'text-emerald-300'
        : match[3]
          ? 'text-amber-300'
          : 'text-violet-300';
    fragments.push(
      <span key={index} className={color}>
        {match[0]}
      </span>,
    );
    previous = index + match[0].length;
  }
  fragments.push(source.slice(previous));
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-3 font-mono text-xs">
      {fragments}
    </pre>
  );
}

function copy(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

function TreeNode({
  label,
  value,
  path,
  depth,
}: {
  label: string;
  value: unknown;
  path: string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const nested = value !== null && typeof value === 'object';
  const elements = nested ? Object.entries(value as Record<string, unknown>) : [];
  const preview = Array.isArray(value) ? `Array(${elements.length})` : `Object(${elements.length})`;
  const controls = (
    <span className="ml-2 inline-flex gap-1 align-middle">
      <Button
        aria-label={`Copy path ${path}`}
        type="button"
        size="xs"
        variant="ghost"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copy(path);
        }}
      >
        Path
      </Button>
      <Button
        aria-label={`Copy value ${path}`}
        type="button"
        size="xs"
        variant="ghost"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copy(printable(value));
        }}
      >
        Value
      </Button>
    </span>
  );
  if (!nested)
    return (
      <div className="min-w-0 break-all py-0.5">
        <span className="text-sky-300">{label}</span>:{' '}
        <span className="text-emerald-300">{printable(value)}</span>
        {controls}
      </div>
    );
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="min-w-0 border-l border-border/70 pl-3"
    >
      <summary className="cursor-pointer py-0.5">
        <span className="text-sky-300">{label}</span>{' '}
        <span className="text-zinc-400">{preview}</span>
        {controls}
      </summary>
      <div className="pl-1">
        {elements.map(([key, item]) => (
          <TreeNode
            key={key}
            label={key}
            value={item}
            path={jsonPath(path, Array.isArray(value) ? Number(key) : key)}
            depth={depth + 1}
          />
        ))}
        {elements.length === 0 && <span className="text-zinc-500">Empty</span>}
      </div>
    </details>
  );
}

/** Shared read-only diagnostic viewer. Mutations are kept in the Playground raw editor. */
export function JsonInspector({ value, title }: { value: unknown; title: string }) {
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  return (
    <section aria-label={title} className="min-w-0 rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        <div className="flex gap-1">
          <Button
            size="xs"
            variant={mode === 'tree' ? 'secondary' : 'ghost'}
            onClick={() => setMode('tree')}
          >
            Tree
          </Button>
          <Button
            size="xs"
            variant={mode === 'raw' ? 'secondary' : 'ghost'}
            onClick={() => setMode('raw')}
          >
            Raw JSON
          </Button>
        </div>
      </div>
      {mode === 'tree' ? (
        <div className="max-h-[32rem] overflow-auto font-mono text-xs">
          <TreeNode label="$" value={value} path="$" depth={0} />
        </div>
      ) : (
        <SyntaxJson value={value} />
      )}
    </section>
  );
}

import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelDiscoveryResult } from '../../shared/model-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

export type ProjectorChoice =
  | { kind: 'none' }
  | { kind: 'bundled' }
  | { kind: 'repo'; id: string }
  | { kind: 'installed'; id: string }
  | { kind: 'remote'; source: string; id: string };

function choiceKey(choice: ProjectorChoice | null): string | null {
  if (!choice) return null;
  return choice.kind === 'none' || choice.kind === 'bundled'
    ? choice.kind
    : `${choice.kind}:${choice.id}`;
}

export function ProjectorPicker({
  discovery,
  selectedModelId,
  targetInstalledId,
  bundledProjectorId,
  manager,
  value,
  onChange,
}: {
  discovery: ModelDiscoveryResult | null;
  selectedModelId: string;
  targetInstalledId?: string;
  bundledProjectorId?: string | null;
  manager: ModelManagerSnapshot | null;
  value: ProjectorChoice | null;
  onChange: (value: ProjectorChoice) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [remoteSource, setRemoteSource] = useState('');
  const [remoteResult, setRemoteResult] = useState<ModelDiscoveryResult | null>(null);
  const [remoteError, setRemoteError] = useState('');
  const [loading, setLoading] = useState(false);
  const [queriedSource, setQueriedSource] = useState('');
  const detected =
    discovery?.projectors.filter(
      (item) =>
        item.id !== selectedModelId &&
        (discovery.candidates
          .find((candidate) => candidate.id === selectedModelId)
          ?.compatibleProjectorIds.includes(item.id) ??
          true),
    ) ?? [];
  const siblingIds = new Set(detected.map((item) => item.id));
  const siblings = discovery
    ? [
        ...discovery.projectors.filter((item) => !siblingIds.has(item.id)),
        ...discovery.candidates.filter(
          (item) => item.role === 'vision-language' && item.id !== selectedModelId,
        ),
      ]
    : [];
  const availableInstalled = (manager?.installations ?? []).filter(
    (entry) =>
      entry.role === 'vision-language' &&
      entry.projectorId === null &&
      entry.id !== targetInstalledId &&
      (manager?.projectorAssignments?.[entry.id] ?? null) === null,
  );

  const choices: { key: string; label: string; choice: ProjectorChoice }[] = [
    { key: 'none', label: 'No projector (text-only)', choice: { kind: 'none' } },
    ...(bundledProjectorId
      ? [
          {
            key: 'bundled',
            label: `Bundled: ${bundledProjectorId}`,
            choice: { kind: 'bundled' as const },
          },
        ]
      : []),
    ...detected.map((item) => ({
      key: `repo:${item.id}`,
      label: `Detected: ${item.id}`,
      choice: { kind: 'repo' as const, id: item.id },
    })),
    ...(expanded
      ? [
          ...siblings.map((item) => ({
            key: `repo:${item.id}`,
            label: `Same repository: ${item.id}`,
            choice: { kind: 'repo' as const, id: item.id },
          })),
          ...availableInstalled.map((entry) => ({
            key: `installed:${entry.id}`,
            label: `Installed: ${entry.repo} / ${entry.candidateId}`,
            choice: { kind: 'installed' as const, id: entry.id },
          })),
          ...(remoteResult && queriedSource === remoteSource
            ? [
                ...remoteResult.projectors,
                ...remoteResult.candidates.filter((item) => item.role === 'vision-language'),
              ].map((item) => ({
                key: `remote:${item.id}`,
                label: `Hugging Face: ${item.id}`,
                choice: { kind: 'remote' as const, id: item.id, source: remoteSource },
              }))
            : []),
        ]
      : []),
  ];
  // Retain the selected custom/installed option even when the advanced section is collapsed.
  if (value && !choices.some((item) => item.key === choiceKey(value))) {
    choices.push({
      key: choiceKey(value)!,
      label:
        value.kind === 'remote'
          ? `Hugging Face: ${value.id}`
          : value.kind === 'installed'
            ? `Installed: ${value.id}`
            : value.kind === 'repo'
              ? `Same repository: ${value.id}`
              : 'Selected projector',
      choice: value,
    });
  }

  async function lookupRemote() {
    setLoading(true);
    setRemoteError('');
    setRemoteResult(null);
    setQueriedSource('');
    try {
      const result = await window.lonelyChat!.discoverModels(remoteSource);
      setRemoteResult(result);
      setQueriedSource(remoteSource);
    } catch (error) {
      setRemoteError(
        error instanceof Error ? error.message : 'Could not discover projector files.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={targetInstalledId ? `projector-${targetInstalledId}` : 'model-projector'}>
        Vision projector candidate (verified when native inference starts)
      </Label>
      <Select
        items={choices.map((item) => ({ value: item.key, label: item.label }))}
        value={choiceKey(value)}
        onValueChange={(key) => {
          const chosen = choices.find((item) => item.key === key);
          if (chosen) onChange(chosen.choice);
        }}
      >
        <SelectTrigger
          id={targetInstalledId ? `projector-${targetInstalledId}` : 'model-projector'}
          className="h-9 w-full min-w-0 text-sm"
        >
          <SelectValue placeholder="Choose a projector…" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((item) => (
            <SelectItem key={item.key} value={item.key} title={item.label}>
              <span className="block max-w-[70ch] truncate">{item.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>
        <Plus size={14} /> {expanded ? 'Hide additional models' : 'Add Projector Model…'}
      </Button>
      {expanded && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Choose any other GGUF from this repository, a locally installed GGUF without its own
            projector, or a GGUF from another public Hugging Face repository.
          </p>
          <Label
            htmlFor={
              targetInstalledId ? `projector-source-${targetInstalledId}` : 'projector-source'
            }
          >
            Other Hugging Face repository or file URL
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={targetInstalledId ? `projector-source-${targetInstalledId}` : 'projector-source'}
              value={remoteSource}
              onChange={(event) => {
                setRemoteSource(event.target.value);
                setRemoteResult(null);
              }}
              placeholder="owner/repo or Hugging Face GGUF URL"
              className="h-9 min-w-0 flex-1"
            />
            <Button
              variant="outline"
              disabled={loading || !remoteSource.trim()}
              onClick={() => void lookupRemote()}
            >
              <Search size={14} /> {loading ? 'Searching…' : 'Find GGUFs'}
            </Button>
          </div>
          {remoteError && (
            <p role="alert" className="text-xs text-destructive">
              {remoteError}
            </p>
          )}
          {remoteResult && (
            <p className="text-xs text-muted-foreground">
              Found{' '}
              {remoteResult.candidates.filter((item) => item.role === 'vision-language').length +
                remoteResult.projectors.length}{' '}
              GGUF artifacts. Select one above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

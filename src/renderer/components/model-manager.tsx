import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Download, Search, FolderOpen, Trash2, Square, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelDiscoveryResult, ModelCandidate } from '../../shared/model-contract';
import type { ModelManagerSnapshot } from '../../shared/model-install-contract';

function bytes(value: number | null): string {
  if (value === null) return 'Size unknown';
  if (value < 1024) return `${value} B`;
  const unit = value < 1024 ** 2 ? 'KiB' : value < 1024 ** 3 ? 'MiB' : 'GiB';
  const divisor = unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3;
  return `${(value / divisor).toFixed(1)} ${unit}`;
}

function modelLabel(candidate: ModelCandidate): string {
  return `${candidate.id} · ${bytes(candidate.sizeBytes)}`;
}

export function ModelManager() {
  const [source, setSource] = useState('');
  const [discovery, setDiscovery] = useState<ModelDiscoveryResult | null>(null);
  const [discoveredInput, setDiscoveredInput] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedProjector, setSelectedProjector] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manager, setManager] = useState<ModelManagerSnapshot | null>(null);
  const [managementError, setManagementError] = useState('');
  const [managementBusy, setManagementBusy] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const api = window.lonelyChat;
    if (!api) return;
    let live = true;
    let receivedEvent = false;
    const unsubscribe = api.onModelsChange((snapshot) => {
      receivedEvent = true;
      if (live) setManager(snapshot);
    });
    void api
      .getModelsSnapshot()
      .then((snapshot) => {
        if (live && !receivedEvent) setManager(snapshot);
      })
      .catch((error: unknown) => {
        if (live)
          setManagementError(
            error instanceof Error ? error.message : 'Unable to load installed models.',
          );
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  async function manage(action: () => Promise<ModelManagerSnapshot>) {
    if (managementBusy) return;
    setManagementBusy(true);
    setManagementError('');
    try {
      const snapshot = await action();
      setManager(snapshot);
    } catch (failure) {
      setManagementError(failure instanceof Error ? failure.message : 'Model operation failed.');
    } finally {
      setManagementBusy(false);
    }
  }

  const isDownloading = manager?.progress.phase !== 'idle' && !!manager;

  const selected = discovery?.candidates.find((candidate) => candidate.id === selectedId);
  const projectors =
    selected?.compatibleProjectorIds.map((id) => {
      const projector = discovery?.projectors.find((item) => item.id === id);
      return { value: id, label: `${id} · ${bytes(projector?.sizeBytes ?? null)}` };
    }) ?? [];
  const needsProjector = selected?.role === 'vision-language' && projectors.length > 1;
  const modelOptions =
    discovery?.candidates.map((candidate) => ({
      value: candidate.id,
      label: modelLabel(candidate),
    })) ?? [];
  const projectorOptions = [{ value: 'none', label: 'No projector (text-only)' }, ...projectors];
  // A warning belongs to the currently selected model. Do not repeat it for every quantization.
  const warnings =
    discovery?.warnings.filter(
      (warning) => !warning.startsWith('Select a projector explicitly for '),
    ) ?? [];

  function pickCandidate(candidate: ModelCandidate, explicitProjector?: string | null) {
    setSelectedId(candidate.id);
    setSelectedProjector(
      explicitProjector && candidate.compatibleProjectorIds.includes(explicitProjector)
        ? explicitProjector
        : (candidate.suggestedProjectorId ?? ''),
    );
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const current = ++request.current;
    setBusy(true);
    setError('');
    setDiscovery(null);
    setDiscoveredInput('');
    setSelectedId('');
    setSelectedProjector('');
    try {
      if (!window.lonelyChat)
        throw new Error('Model discovery is only available in the desktop app.');
      const result = await window.lonelyChat.discoverModels(source);
      if (request.current !== current) return;
      setDiscovery(result);
      setDiscoveredInput(source);
      const chosen = result.candidates.find((item) => item.id === result.preselectedCandidateId);
      if (chosen) pickCandidate(chosen, result.preselectedProjectorId);
      else if (result.preselectedProjectorId) setSelectedProjector(result.preselectedProjectorId);
    } catch (failure) {
      if (request.current === current) {
        setError(failure instanceof Error ? failure.message : 'Hugging Face discovery failed.');
      }
    } finally {
      if (request.current === current) setBusy(false);
    }
  }

  return (
    <Card role="region" aria-labelledby="model-manager-heading" className="gap-0">
      <CardHeader>
        <CardTitle id="model-manager-heading" className="flex items-center gap-2 text-base">
          <Download size={18} className="text-violet-300" />
          Hugging Face model discovery
        </CardTitle>
        <CardDescription className="text-sm leading-6">
          Browse and install GGUF vision/language weights or native whisper.cpp speech models.
          Installed models remain local and can be activated without restarting the app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={(event) => void search(event)} className="space-y-3">
          <Label htmlFor="model-source">Repository or file URL</Label>
          <Input
            id="model-source"
            autoComplete="off"
            spellCheck={false}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="owner/repo or https://huggingface.co/owner/repo"
            className="h-9"
          />
          <Button type="submit" size="lg" disabled={busy || !source.trim() || !window.lonelyChat}>
            <Search size={15} /> {busy ? 'Discovering…' : 'Discover files'}
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Discovery failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {discovery && (
          <div className="space-y-4 border-t border-border pt-4">
            <div>
              <p className="font-medium text-foreground">{discovery.repo}</p>
              <p className="text-xs text-muted-foreground">
                Revision: {discovery.revision} ·{' '}
                {discovery.role === 'mixed'
                  ? 'Vision/language and speech'
                  : discovery.role === 'vision-language'
                    ? 'GGUF vision/language'
                    : 'Native speech'}{' '}
                · {discovery.candidates.length} candidate(s)
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-candidate">Choose model weights</Label>
              <Select
                items={modelOptions}
                value={selectedId || null}
                onValueChange={(id) => {
                  const candidate = discovery.candidates.find((item) => item.id === id);
                  if (candidate) pickCandidate(candidate);
                }}
              >
                <SelectTrigger id="model-candidate" className="h-9 w-full min-w-0 text-sm">
                  <SelectValue placeholder="Choose model weights…" />
                </SelectTrigger>
                <SelectContent>
                  {discovery.candidates.map((candidate) => (
                    <SelectItem
                      key={candidate.id}
                      value={candidate.id}
                      title={modelLabel(candidate)}
                    >
                      <span className="block max-w-[70ch] truncate">{modelLabel(candidate)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selected && (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  {selected.role === 'speech-to-text'
                    ? 'Speech-to-text · whisper.cpp'
                    : 'GGUF · vision/language'}
                  {selected.quantization ? ` · ${selected.quantization}` : ''}
                  {' · '}
                  {bytes(selected.sizeBytes)}
                  {selected.files.length > 1 ? ` · ${selected.files.length} shards` : ''}
                </p>
                <p className="break-all">{selected.files.map((file) => file.path).join(', ')}</p>
              </div>
            )}

            {selected?.role === 'vision-language' && projectors.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="model-projector">Vision projector companion</Label>
                <Select
                  items={projectorOptions}
                  value={selectedProjector || null}
                  onValueChange={(projector) => setSelectedProjector(projector ?? '')}
                >
                  <SelectTrigger id="model-projector" className="h-9 w-full min-w-0 text-sm">
                    <SelectValue placeholder="Choose a projector…" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectors.map((projector) => (
                      <SelectItem
                        key={projector.value}
                        value={projector.value}
                        title={projector.label}
                      >
                        <span className="block max-w-[70ch] truncate">{projector.label}</span>
                      </SelectItem>
                    ))}
                    <SelectItem value="none">No projector (text-only)</SelectItem>
                  </SelectContent>
                </Select>
                {projectors.length > 1 && !selectedProjector && (
                  <p className="text-xs text-amber-300">
                    Several companions are available. Select one explicitly.
                  </p>
                )}
              </div>
            )}

            {discovery.preselectedProjectorId && !selected && (
              <p className="text-xs text-amber-300">
                Projector {discovery.preselectedProjectorId} is preselected; choose its matching
                model above.
              </p>
            )}

            {selected && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="lg"
                  disabled={
                    !manager ||
                    isDownloading ||
                    managementBusy ||
                    source !== discoveredInput ||
                    (needsProjector && !selectedProjector)
                  }
                  onClick={() =>
                    void manage(() =>
                      window.lonelyChat!.installModel({
                        source: discoveredInput,
                        candidateId: selected.id,
                        projectorId:
                          selectedProjector === 'none' ? 'none' : selectedProjector || null,
                      }),
                    )
                  }
                >
                  <Download size={15} /> Install selected model
                </Button>
                {needsProjector && !selectedProjector && (
                  <span className="text-xs text-amber-300">
                    Choose a projector or text-only before installing.
                  </span>
                )}
              </div>
            )}

            {selected && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Selected {selected.files.length} model file(s) · {bytes(selected.sizeBytes)}
                {selectedProjector && selectedProjector !== 'none'
                  ? ` · projector: ${selectedProjector}`
                  : ''}
                . Installation is managed locally; runtime compatibility is checked when native
                inference is integrated.
              </p>
            )}

            {warnings.length > 0 && (
              <Alert className="border-amber-500/30 text-amber-200">
                <AlertTriangle size={16} aria-hidden="true" />
                <AlertTitle>Discovery notes</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="font-semibold text-foreground">Model storage</Label>
            <Button
              variant="outline"
              disabled={
                !manager || isDownloading || managementBusy || !!manager.installations.length
              }
              onClick={() => void manage(() => window.lonelyChat!.chooseModelDirectory())}
            >
              <FolderOpen size={15} /> Choose folder
            </Button>
          </div>
          <p className="break-all text-xs text-muted-foreground">
            {manager?.storageDirectory ?? 'Loading model storage…'}
          </p>
          {manager && manager.installations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Remove installed models before changing the storage folder.
            </p>
          )}
          {manager && isDownloading && (
            <div className="space-y-2" role="status" aria-live="polite">
              <p className="text-xs text-foreground">
                {manager.progress.phase === 'verifying'
                  ? 'Verifying model files…'
                  : `Downloading ${manager.progress.file ?? 'model files…'}`}
              </p>
              <progress
                className="h-2 w-full accent-violet-500"
                value={manager.progress.receivedBytes}
                max={manager.progress.totalBytes ?? undefined}
              />
              <p className="text-xs text-muted-foreground">
                {bytes(manager.progress.receivedBytes)} / {bytes(manager.progress.totalBytes)}
              </p>
              <Button
                variant="outline"
                onClick={() => void window.lonelyChat?.cancelModelDownload()}
              >
                <Square size={14} /> Cancel download
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-semibold">Installed models</p>
          {manager?.installations.length === 0 && (
            <p className="text-xs text-muted-foreground">No installed models yet.</p>
          )}
          {manager?.installations.map((entry) => {
            const active = manager.active[entry.role] === entry.id;
            return (
              <div key={entry.id} className="space-y-2 rounded-md border border-border p-3">
                <p className="break-all text-xs font-medium text-foreground">
                  {entry.repo} · {entry.candidateId}
                </p>
                <p className="text-xs text-muted-foreground">
                  {entry.role === 'speech-to-text' ? 'Speech-to-text' : 'Vision/language'} ·{' '}
                  {bytes(entry.files.reduce((sum, file) => sum + file.sizeBytes, 0))}
                  {entry.projectorId ? ` · projector: ${entry.projectorId}` : ' · no projector'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={active ? 'secondary' : 'default'}
                    disabled={isDownloading || managementBusy}
                    onClick={() =>
                      void manage(() =>
                        window.lonelyChat!.activateModel(entry.role, active ? null : entry.id),
                      )
                    }
                  >
                    {active ? (
                      <>
                        <Check size={14} /> Deactivate
                      </>
                    ) : (
                      'Activate'
                    )}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isDownloading || managementBusy}
                    onClick={() => void manage(() => window.lonelyChat!.removeModel(entry.id))}
                  >
                    <Trash2 size={14} /> Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {managementError && (
          <Alert variant="destructive">
            <AlertTitle>Model management error</AlertTitle>
            <AlertDescription>{managementError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

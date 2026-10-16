import { useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Download, Search } from 'lucide-react';
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
  const [selectedId, setSelectedId] = useState('');
  const [selectedProjector, setSelectedProjector] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const selected = discovery?.candidates.find((candidate) => candidate.id === selectedId);
  const projectors =
    selected?.compatibleProjectorIds.map((id) => {
      const projector = discovery?.projectors.find((item) => item.id === id);
      return { value: id, label: `${id} · ${bytes(projector?.sizeBytes ?? null)}` };
    }) ?? [];
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
    setSelectedId('');
    setSelectedProjector('');
    try {
      if (!window.lonelyChat)
        throw new Error('Model discovery is only available in the desktop app.');
      const result = await window.lonelyChat.discoverModels(source);
      if (request.current !== current) return;
      setDiscovery(result);
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
          Browse GGUF vision/language weights and native whisper.cpp speech models. Choose an
          artifact and any required projector; downloads arrive in a later milestone.
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
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Selected {selected.files.length} model file(s) · {bytes(selected.sizeBytes)}
                {selectedProjector && selectedProjector !== 'none'
                  ? ` · projector: ${selectedProjector}`
                  : ''}
                . Discovery only; model runtime compatibility must be checked before installation.
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
      </CardContent>
    </Card>
  );
}

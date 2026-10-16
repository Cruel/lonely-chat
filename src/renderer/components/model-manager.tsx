import { useRef, useState, type FormEvent } from 'react';
import { Download, Search } from 'lucide-react';
import { Button } from './ui/button';
import type { ModelDiscoveryResult, ModelCandidate } from '../../shared/model-contract';

function bytes(value: number | null): string {
  if (value === null) return 'Size unknown';
  if (value < 1024) return `${value} B`;
  const unit = value < 1024 ** 2 ? 'KiB' : value < 1024 ** 3 ? 'MiB' : 'GiB';
  const divisor = unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3;
  return `${(value / divisor).toFixed(1)} ${unit}`;
}

export function ModelManager() {
  const [source, setSource] = useState('');
  const [discovery, setDiscovery] = useState<ModelDiscoveryResult | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [selectedProjector, setSelectedProjector] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const selected: ModelCandidate | undefined = discovery?.candidates.find(
    (candidate) => candidate.id === selectedId,
  );

  function pickCandidate(candidate: ModelCandidate, result = discovery) {
    setSelectedId(candidate.id);
    const direct = result?.preselectedProjectorId;
    setSelectedProjector(
      direct && candidate.compatibleProjectorIds.includes(direct)
        ? direct
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
      if (chosen) pickCandidate(chosen, result);
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
    <section
      aria-labelledby="model-manager-heading"
      className="rounded-xl border border-zinc-800 bg-[#1b1b24] p-5"
    >
      <h3 id="model-manager-heading" className="flex items-center gap-2 font-medium">
        <Download size={18} className="text-violet-300" /> Hugging Face model discovery
      </h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Browse GGUF vision/language weights and native whisper.cpp speech models. Choose an artifact
        and any required projector; downloads arrive in a later milestone.
      </p>
      <form onSubmit={(event) => void search(event)} className="mt-4 space-y-3">
        <label htmlFor="model-source" className="block text-sm font-medium text-zinc-200">
          Repository or file URL
        </label>
        <input
          id="model-source"
          autoComplete="off"
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="owner/repo or https://huggingface.co/owner/repo"
          className="w-full rounded-md border border-zinc-700 bg-[#111116] px-3 py-2 text-sm text-zinc-100 outline-none focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-400/30"
        />
        <Button type="submit" disabled={busy || !source.trim() || !window.lonelyChat}>
          <Search size={15} /> {busy ? 'Discovering…' : 'Discover files'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-300">
          {error}
        </p>
      )}
      {discovery && (
        <div className="mt-5 space-y-4 border-t border-zinc-800 pt-4">
          <div>
            <p className="font-medium text-zinc-100">{discovery.repo}</p>
            <p className="text-xs text-zinc-400">
              Revision: {discovery.revision} ·{' '}
              {discovery.role === 'mixed'
                ? 'Vision/language and speech'
                : discovery.role === 'vision-language'
                  ? 'GGUF vision/language'
                  : 'Native speech'}{' '}
              · {discovery.candidates.length} candidate(s)
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-zinc-200">Choose model weights</legend>
            {discovery.candidates.map((candidate) => (
              <label
                key={candidate.id}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
                  candidate.id === selectedId
                    ? 'border-violet-500 bg-violet-500/10'
                    : 'border-zinc-700 bg-[#111116]'
                }`}
              >
                <input
                  type="radio"
                  name="model-candidate"
                  value={candidate.id}
                  checked={selectedId === candidate.id}
                  onChange={() => pickCandidate(candidate)}
                  className="mt-1 accent-violet-400"
                />
                <span className="min-w-0">
                  <span className="block break-all font-medium text-zinc-100">{candidate.id}</span>
                  <span className="mt-1 block text-xs text-zinc-400">
                    {candidate.role === 'speech-to-text'
                      ? 'Speech-to-text · whisper.cpp'
                      : 'GGUF · vision/language'}
                    {candidate.quantization ? ` · ${candidate.quantization}` : ''}
                    {' · '}
                    {bytes(candidate.sizeBytes)}
                    {candidate.files.length > 1 ? ` · ${candidate.files.length} shards` : ''}
                  </span>
                  {candidate.files.length > 1 && (
                    <span className="mt-1 block text-xs text-zinc-500">
                      {candidate.files.map((file) => file.path).join(', ')}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          {selected?.role === 'vision-language' && selected.compatibleProjectorIds.length > 0 && (
            <div>
              <label htmlFor="model-projector" className="block text-sm font-medium text-zinc-200">
                Vision projector companion
              </label>
              <select
                id="model-projector"
                value={selectedProjector}
                onChange={(event) => setSelectedProjector(event.target.value)}
                className="mt-2 w-full rounded-md border border-zinc-700 bg-[#111116] px-3 py-2 text-sm text-zinc-100"
              >
                <option value="">Choose a projector…</option>
                {selected.compatibleProjectorIds.map((id) => {
                  const projector = discovery.projectors.find((item) => item.id === id);
                  return (
                    <option key={id} value={id}>
                      {id} · {bytes(projector?.sizeBytes ?? null)}
                    </option>
                  );
                })}
                <option value="none">No projector (text-only)</option>
              </select>
              {selected.compatibleProjectorIds.length > 1 && selectedProjector === '' && (
                <p className="mt-2 text-xs text-amber-300">
                  Several companions are available. Select one explicitly.
                </p>
              )}
            </div>
          )}
          {discovery.preselectedProjectorId && !selected && (
            <p className="text-sm text-amber-300">
              Projector {discovery.preselectedProjectorId} is preselected; choose its matching model
              above.
            </p>
          )}
          {selected && (
            <p className="text-xs text-zinc-400" aria-live="polite">
              Selected {selected.files.length} model file(s) · {bytes(selected.sizeBytes)}
              {selectedProjector && selectedProjector !== 'none'
                ? ` · projector: ${selectedProjector}`
                : ''}
              . Discovery only; model runtime compatibility must be checked before installation.
            </p>
          )}
          {discovery.warnings.length > 0 && (
            <div className="space-y-1 text-xs text-amber-300">
              {discovery.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

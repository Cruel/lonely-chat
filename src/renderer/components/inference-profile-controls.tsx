import { useEffect, useState } from 'react';
import type {
  InferenceProfile,
  InferenceProfileValues,
  InferenceRole,
  InferenceTopology,
  ProfileModelReference,
} from '../../shared/inference-profile-contract';
import type { RemoteCatalog } from '../../shared/remote-inference-contract';
import { resolveStageContext, resolveStageTemplate, DEFAULT_CHAT_PROMPT, DEFAULT_VISION_PROMPT } from '../../main/stage-context';

interface Props {
  selectedId: string;
  selectedRevision: number | null;
  onSelect: (profile: InferenceProfile | null) => void;
  remoteCatalog: RemoteCatalog;
  disabled: boolean;
}

const required: Record<InferenceTopology, InferenceRole[]> = {
  unified: ['unified'],
  split: ['observer', 'chat'],
  hybrid: ['observer', 'chat'],
};

export function InferenceProfileControls({
  selectedId,
  selectedRevision,
  onSelect,
  remoteCatalog,
  disabled,
}: Props) {
  const [profiles, setProfiles] = useState<InferenceProfile[]>([]);
  const [revisions, setRevisions] = useState<InferenceProfile[]>([]);
  const [localModels, setLocalModels] = useState<{ id: string; name: string }[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState('');
  const [topology, setTopology] = useState<InferenceTopology>('unified');
  const [roles, setRoles] = useState<InferenceProfileValues['roles']>({});
  const [defaults, setDefaults] = useState('{}');
  const [showStagePreview, setShowStagePreview] = useState(false);
  const stagePreview = (() => {
    try {
      const parsed = JSON.parse(defaults) as InferenceProfileValues['stageDefaults'];
      return required[topology].map((role) => {
        const stage = parsed[role];
        const sample = resolveStageContext({
          context: 'Example stream narrative', cycle: 1,
          boundary: { fromSequence: 0, throughSequence: 1, fromMs: 0, throughMs: 1000 },
          frames: role === 'observer' ? [{
            sourceId: 'example-camera', observedAt: 1000, width: 320, height: 180, dataUrl: 'data:image/jpeg;base64,'
          }] : [],
          recentEvents: [{ kind: 'reaction', summary: 'An example event', observedAt: 900 }],
          observations: [{ source: 'vision', kind: 'visual', description: 'Example scene', observedAt: 950 }],
        }, stage);
        return {
          role,
          exampleOnly: true,
          instructions: resolveStageTemplate(stage?.systemPrompt ??
            (role === 'observer' ? DEFAULT_VISION_PROMPT : DEFAULT_CHAT_PROMPT), sample.data),
          userText: resolveStageTemplate(stage?.userPrompt ?? '{{context}}', sample.data),
          includedContext: sample.data,
          omissions: sample.omitted,
          contextCharacters: sample.characters,
          responseTokenLimit: stage?.maxResponseTokens ?? 2048,
          mediaReferences: role === 'observer' ? [{ sourceId: 'example-camera', observedAt: 1000, type: 'image' }] : [],
          visionOutput: role === 'observer' ? stage?.visionOutput ?? 'both' : undefined,
        };
      });
    } catch {
      return null;
    }
  })();
  const [contextDefaults, setContextDefaults] = useState('{}');
  const [execution, setExecution] = useState<'sequential' | 'asynchronous'>('sequential');
  const [hybridMaxImages, setHybridMaxImages] = useState(0);
  const [scheduling, setScheduling] = useState({
    visionIntervalMs: 1500,
    chatIntervalMs: 1500,
    maximumWaitMs: 10000,
    maximumAgeMs: 30000,
    strictWait: true,
    warmIdleMs: 0,
  });
  const loadScheduling = (architecture: InferenceProfileValues['architecture']) =>
    setScheduling({
      visionIntervalMs: architecture?.visionIntervalMs ?? 1500,
      chatIntervalMs: architecture?.chatIntervalMs ?? 1500,
      maximumWaitMs: architecture?.maximumWaitMs ?? 10000,
      maximumAgeMs: architecture?.maximumAgeMs ?? 30000,
      strictWait: architecture?.strictWait ?? architecture?.execution !== 'asynchronous',
      warmIdleMs: architecture?.warmIdleMs ?? 0,
    });
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const api = window.lonelyChat;
    if (!api) return;
    const [items, models] = await Promise.all([
      api.listInferenceProfiles(),
      api.getModelsSnapshot(),
    ]);
    setProfiles(items);
    setLocalModels(
      models.installations
        .filter((item) => !item.projectorOnly && item.role === 'vision-language')
        .map((item) => ({ id: item.id, name: item.repo })),
    );
  };
  useEffect(() => {
    void reload().catch((reason: unknown) => setError(String(reason)));
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setRevisions([]);
      return;
    }
    void window.lonelyChat
      ?.listInferenceProfileRevisions(selectedId)
      .then(setRevisions)
      .catch((reason: unknown) => setError(String(reason)));
  }, [selectedId, profiles]);

  useEffect(() => {
    const selected = revisions.find((p) => p.id === selectedId && p.revision === selectedRevision);
    if (!selected) return;
    setName(selected.name);
    setTopology(selected.values.topology);
    setRoles(selected.values.roles);
    setDefaults(JSON.stringify(selected.values.stageDefaults, null, 2));
    setContextDefaults(JSON.stringify(selected.values.contextDefaults ?? {}, null, 2));
    setExecution(selected.values.architecture?.execution ?? 'sequential');
    setHybridMaxImages(selected.values.architecture?.hybridMaxImages ?? 0);
    loadScheduling(selected.values.architecture);
  }, [selectedId, selectedRevision, revisions]);

  const load = (profile: InferenceProfile | null) => {
    onSelect(profile);
    if (profile) {
      setName(profile.name);
      setTopology(profile.values.topology);
      setRoles(profile.values.roles);
      setDefaults(JSON.stringify(profile.values.stageDefaults, null, 2));
      setContextDefaults(JSON.stringify(profile.values.contextDefaults ?? {}, null, 2));
      setExecution(profile.values.architecture?.execution ?? 'sequential');
      setHybridMaxImages(profile.values.architecture?.hybridMaxImages ?? 0);
      loadScheduling(profile.values.architecture);
    }
  };
  const save = async () => {
    setError(null);
    try {
      const api = window.lonelyChat!;
      const values: InferenceProfileValues = {
        topology,
        roles: Object.fromEntries(required[topology].map((role) => [role, roles[role]])),
        stageDefaults: JSON.parse(defaults) as InferenceProfileValues['stageDefaults'],
        architecture: {
          execution,
          hybridMaxImages: topology === 'hybrid' ? hybridMaxImages : 0,
          ...scheduling,
        },
        contextDefaults: JSON.parse(contextDefaults) as InferenceProfileValues['contextDefaults'],
      };
      const result = await api.saveInferenceProfile({
        ...(selectedId ? { id: selectedId } : {}),
        name,
        values,
      });
      await reload();
      load(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const remove = async () => {
    if (!selectedId || !window.confirm('Delete this Inference Profile and all its revisions?'))
      return;
    setError(null);
    try {
      await window.lonelyChat!.deleteInferenceProfile(selectedId);
      load(null);
      await reload();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const models: { key: string; label: string; ref: ProfileModelReference }[] = [
    ...localModels.map((item) => ({
      key: `local:${item.id}`,
      label: `Local · ${item.name}`,
      ref: { kind: 'local' as const, modelId: item.id },
    })),
    ...remoteCatalog.models.map((item) => ({
      key: `remote:${item.id}`,
      label: `Remote · ${item.name}`,
      ref: { kind: 'remote' as const, modelId: item.id },
    })),
  ];
  return (
    <section className="mt-4 space-y-2 text-sm">
      <label htmlFor="inference-profile" className="block text-zinc-200">
        Inference Profile
      </label>
      <select
        id="inference-profile"
        disabled={disabled}
        value={selectedId}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
        onChange={(event) => load(profiles.find((item) => item.id === event.target.value) ?? null)}
      >
        <option value="">Manual provider settings</option>
        {profiles.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · revision {item.revision}
          </option>
        ))}
      </select>
      {selectedId && (
        <label className="block text-zinc-400">
          Revision
          <select
            disabled={disabled}
            value={selectedRevision ?? ''}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
            onChange={(event) =>
              load(revisions.find((p) => p.revision === Number(event.target.value)) ?? null)
            }
          >
            {revisions.map((p) => (
              <option key={p.revision} value={p.revision}>
                {p.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="text-sky-400 underline"
        onClick={() => setAdvanced(!advanced)}
      >
        {advanced ? 'Hide profile editor' : 'Advanced: edit inference profiles'}
      </button>
      {advanced && (
        <div className="space-y-2 rounded-md border border-zinc-700 p-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSelect(null);
              setName('');
              setTopology('unified');
              setRoles({});
              setDefaults('{}');
              setContextDefaults('{}');
              setExecution('sequential');
              setHybridMaxImages(0);
              loadScheduling(undefined);
            }}
            className="rounded border border-zinc-600 px-2 py-1"
          >
            New profile
          </button>
          <label className="block">
            Name
            <input
              aria-label="Profile name"
              disabled={disabled}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
            />
          </label>
          <label className="block">
            Architecture
            <select
              aria-label="Profile topology"
              disabled={disabled}
              value={topology}
              onChange={(e) => setTopology(e.target.value as InferenceTopology)}
              className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
            >
              <option value="unified">Unified</option>
              <option value="split">Split (Vision → Chat)</option>
              <option value="hybrid">Hybrid (role-based, staged)</option>
            </select>
          </label>
          {topology !== 'unified' && (
            <label className="block">
              Stage execution
              <select
                aria-label="Stage execution"
                disabled={disabled}
                value={execution}
                onChange={(e) => {
                  setExecution(e.target.value as typeof execution);
                  setScheduling((current) => ({
                    ...current,
                    strictWait: e.target.value === 'sequential',
                  }));
                }}
                className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
              >
                <option value="sequential">Sequential</option>
                <option value="asynchronous">Asynchronous</option>
              </select>
            </label>
          )}
          {topology === 'split' && (
            <div className="space-y-2 rounded border border-zinc-700 p-2">
              {(
                [
                  ['visionIntervalMs', 'Vision minimum interval (ms)'],
                  ['chatIntervalMs', 'Chat minimum interval (ms)'],
                  ['maximumWaitMs', 'Maximum Vision wait (ms)'],
                  ['maximumAgeMs', 'Completed Vision maximum age (ms)'],
                  ['warmIdleMs', 'Local worker warm retention after Stop (ms)'],
                ] as const
              ).map(([key, label]) => (
                <label className="block" key={key}>
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    min={0}
                    max={600000}
                    disabled={disabled}
                    value={scheduling[key]}
                    onChange={(e) =>
                      setScheduling((current) => ({
                        ...current,
                        [key]: Number(e.target.value),
                      }))
                    }
                    className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
                  />
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input
                  aria-label="Strict Vision wait"
                  type="checkbox"
                  disabled={disabled}
                  checked={scheduling.strictWait}
                  onChange={(e) =>
                    setScheduling((current) => ({
                      ...current,
                      strictWait: e.target.checked,
                    }))
                  }
                />
                Require eligible Vision result before Chat
              </label>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  void window.lonelyChat
                    ?.unloadLocalModels()
                    .catch((reason: unknown) => setError(String(reason)));
                }}
                className="rounded border border-zinc-600 px-2 py-1"
              >
                Unload idle local models
              </button>
              <p className="text-xs text-zinc-400">
                Local models share GPU execution. Worker retention applies only after Stop; use
                Unload to release idle model memory immediately.
              </p>
            </div>
          )}
          {topology === 'hybrid' && (
            <label className="block">
              Maximum chat images
              <input
                aria-label="Maximum chat images"
                disabled={disabled}
                type="number"
                min={0}
                max={24}
                value={hybridMaxImages}
                onChange={(e) => setHybridMaxImages(Number(e.target.value))}
                className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
              />
            </label>
          )}
          {required[topology].map((role) => (
            <label key={role} className="block capitalize">
              {role} model
              <select
                aria-label={`${role} model`}
                disabled={disabled}
                value={roles[role] ? `${roles[role].kind}:${roles[role].modelId}` : ''}
                onChange={(e) =>
                  setRoles((current) => ({
                    ...current,
                    [role]: models.find((m) => m.key === e.target.value)?.ref,
                  }))
                }
                className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
              >
                <option value="">Choose a Model Configuration</option>
                {models.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="block">
            Context defaults (JSON; prompt presets override matching values)
            <textarea
              aria-label="Profile context defaults"
              disabled={disabled}
              value={contextDefaults}
              onChange={(e) => setContextDefaults(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2 font-mono"
              rows={2}
            />
          </label>
          <label className="block">
            Stage defaults by role (JSON: settings, systemPrompt, userPrompt, contextPolicy, maxResponseTokens, visionOutput, visionOptionalFields; no credentials)
            <textarea
              aria-label="Profile stage defaults"
              disabled={disabled}
              value={defaults}
              onChange={(e) => setDefaults(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2 font-mono"
              rows={3}
            />
          </label>
          {topology !== 'unified' && (
            <div className="space-y-2 rounded border border-zinc-700 p-2">
              <p className="text-xs text-zinc-400">
                Prompt variables: {'{{context}}'}, {'{{cycle}}'}, {'{{events}}'},
                {' {{transcripts}}'}, {' {{chat}}'}, {' {{scene}}'},
                {' {{observations}}'}, {' {{narrative}}'}. Unknown variables are rejected.
                Context policy: maxAgeMs, maxCount, maxCharacters and sources (events, transcripts,
                chat, scene, observations, narrative). maxResponseTokens: 128–8192. Vision output:
                scene, events or both; optional fields: confidence, notes. Previous model interpretations are context,
                not direct captured evidence. Required instructions and structured response schema
                remain separate from the bounded context. Oldest history is omitted first.
              </p>
              <div className="flex gap-2">
                <button type="button" disabled={disabled} className="rounded border border-zinc-600 px-2 py-1"
                  onClick={() => {
                    try {
                      const stages = JSON.parse(defaults) as InferenceProfileValues['stageDefaults'];
                      for (const role of required[topology]) {
                        stages[role] = { ...stages[role], systemPrompt: undefined, userPrompt: undefined };
                      }
                      setDefaults(JSON.stringify(stages, null, 2));
                    } catch { setError('Invalid stage JSON.'); }
                  }}>
                  Restore default prompts
                </button>
                <button type="button" onClick={() => setShowStagePreview((value) => !value)}
                  className="rounded border border-zinc-600 px-2 py-1">
                  {showStagePreview ? 'Hide stage preview' : 'Preview stage configuration'}
                </button>
              </div>
              {showStagePreview && <pre aria-label="Stage request preview" className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                {stagePreview ? JSON.stringify(stagePreview, null, 2) : 'Invalid stage JSON.'}
              </pre>}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void save()}
              className="rounded border border-zinc-600 px-3 py-1"
            >
              Save revision
            </button>
            <button
              type="button"
              disabled={disabled || !selectedId}
              onClick={() => void remove()}
              className="rounded border border-zinc-600 px-3 py-1"
            >
              Delete profile
            </button>
          </div>
          {topology !== 'unified' && (
            <p className="text-zinc-400">
              Strict Split runs Vision first with ordered timestamped frames. Its validated scene
              description and Events are passed to Chat as text only; Chat receives no raw images.
              Remote Vision requires explicit image-transmission permission in its Model
              Configuration. Hybrid and asynchronous scheduling are configured here but require
              their later executors.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

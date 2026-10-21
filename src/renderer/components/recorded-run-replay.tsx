import { useState } from 'react';
import { Button } from './ui/button';
import { JsonInspector } from './json-inspector';
import type { RecordedRun } from '../../shared/recorded-scenario-contract';
import type { InferenceProfile } from '../../shared/inference-profile-contract';
import type { ReplayedStage, RunReplay, RunChatComparison } from '../../shared/run-replay-contract';

function stamp(time: number | null): string {
  return time === null ? 'not recorded' : new Date(time).toISOString();
}

/** Offline evidence inspection and isolated Chat comparison. Never writes desktop Chat or overlay. */
export function RecordedRunReplay({
  run,
  active,
  onFullReinfer,
}: {
  readonly run: RecordedRun;
  readonly active: boolean;
  readonly onFullReinfer: () => void;
}) {
  const [replay, setReplay] = useState<RunReplay | null>(null);
  const [profiles, setProfiles] = useState<InferenceProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [stageId, setStageId] = useState('');
  const [allowRemoteText, setAllowRemoteText] = useState(false);
  const [comparison, setComparison] = useState<RunChatComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage: ReplayedStage | undefined = replay?.stages.find((item) => item.id === stageId);
  const chats =
    replay?.stages.filter(
      (item) =>
        item.role === 'chat' &&
        (item.stage === 'accepted' || item.stage === 'scheduled') &&
        item.accepted !== null &&
        !item.incomplete,
    ) ?? [];
  const eligibleProfiles = profiles.filter(
    (item) => item.values.topology !== 'unified' && item.values.roles.chat,
  );
  const selectedProfile = eligibleProfiles.find((item) => item.id === profileId);
  const remoteChat = selectedProfile?.values.roles.chat?.kind === 'remote';

  async function load() {
    if (busy || !window.lonelyChat?.replayRecordedRun || !window.lonelyChat.listInferenceProfiles)
      return;
    setBusy(true);
    setError(null);
    try {
      const [result, available] = await Promise.all([
        window.lonelyChat.replayRecordedRun(run.id),
        window.lonelyChat.listInferenceProfiles(),
      ]);
      setReplay(result);
      setProfiles(available);
      setStageId(
        result.stages.find((item) => item.role === 'chat')?.id ?? result.stages[0]?.id ?? '',
      );
      const selectable = available.filter(
        (item) => item.values.topology !== 'unified' && item.values.roles.chat,
      );
      setProfileId(selectable[0]?.id ?? '');
      setComparison(null);
      setAllowRemoteText(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function compare() {
    if (!stage || !selectedProfile || busy || !window.lonelyChat?.reinferRecordedChat) return;
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      const result = await window.lonelyChat.reinferRecordedChat(
        run.id,
        stage.id,
        selectedProfile.id,
        allowRemoteText,
      );
      setComparison(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={`Replay Run ${run.name}`}
      className="mt-3 space-y-3 border-t border-border pt-3"
    >
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="secondary" disabled={active || busy} onClick={() => void load()}>
          {busy ? 'Working…' : 'Inspect saved stages (no inference)'}
        </Button>
        <Button size="xs" variant="outline" disabled={active} onClick={onFullReinfer}>
          Load frozen settings for full reinference
        </Button>
      </div>
      <p className="text-xs text-zinc-400">
        Offline replay shows only captured accepted stage results and actual publication evidence.
        Full reinference restarts recorded playback with the selected source media. Neither replay
        nor a Chat-only comparison publishes to the overlay.
      </p>
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
      {replay && (
        <div className="space-y-3">
          {replay.warning && (
            <p role="status" className="text-amber-300">
              {replay.warning}
            </p>
          )}
          <p>
            Archived stages: {replay.stages.length} · original Run: {replay.status}
          </p>
          {!replay.stages.length && (
            <p>Enable Compact or Exact recording on future Runs to retain stage evidence.</p>
          )}
          <div className="max-h-48 overflow-y-auto space-y-1">
            {replay.stages.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`w-full rounded p-2 text-left hover:bg-zinc-800 ${item.id === stageId ? 'bg-zinc-800' : ''}`}
                onClick={() => {
                  setStageId(item.id);
                  setComparison(null);
                }}
              >
                {item.role} · cycle {item.cycle} · {item.stage} · {item.modelId ?? 'no model'}
                <span className="block text-zinc-400">
                  Observation {stamp(item.observedAt)} · available {stamp(item.availableAt)}
                </span>
              </button>
            ))}
          </div>
          {stage && (
            <div className="space-y-2">
              <p className="font-medium">
                Saved {stage.role} evidence · {stage.id}
              </p>
              <p className="text-zinc-400">
                Seed {stage.seed} · profile revision {stage.profileRevision ?? 'unknown'} · request{' '}
                {stage.requestProvenance} · recorded dependencies {stage.dependsOn.length}
              </p>
              <JsonInspector
                title="Stage dependencies and source frames"
                value={{ dependsOn: stage.dependsOn, sourceFrameIds: stage.sourceFrameIds }}
              />
              <JsonInspector title="Events consumed by this attempt" value={stage.consumedEvents} />
              <JsonInspector
                title="Originally accepted output (not regenerated)"
                value={stage.accepted}
              />
              <JsonInspector title="Scene interpretation" value={stage.sceneState} />
              <JsonInspector title="Scheduled output" value={stage.scheduled} />
              <JsonInspector
                title="Actually presented messages and closure"
                value={{ messages: stage.presented, closed: stage.presentationClosed }}
              />
              <JsonInspector
                title="Usage and failure"
                value={{ usage: stage.usage, error: stage.error }}
              />
            </div>
          )}
          {chats.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="font-medium">Chat-only reinference from saved Vision</p>
              <p className="text-zinc-400">
                Rebuild Chat with its archived text context, original Observation times, consumed
                Events and seed. Vision is not invoked. Raw frames are not sent. Select an accepted
                Chat stage above and a current Split/Hybrid profile.
              </p>
              <label className="block">
                Comparison profile
                <select
                  aria-label="Replay comparison profile"
                  className="mt-1 w-full rounded border border-zinc-600 bg-zinc-900 p-2"
                  value={profileId}
                  onChange={(event) => {
                    setProfileId(event.target.value);
                    setAllowRemoteText(false);
                    setComparison(null);
                  }}
                >
                  {eligibleProfiles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · revision {item.revision} · {item.values.roles.chat?.kind}
                    </option>
                  ))}
                </select>
              </label>
              {remoteChat && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowRemoteText}
                    onChange={(event) => setAllowRemoteText(event.target.checked)}
                  />
                  I authorize sending archived private text context, Events and transcripts to this
                  remote Chat provider.
                </label>
              )}
              <Button
                size="xs"
                disabled={
                  active ||
                  busy ||
                  !stage ||
                  stage.role !== 'chat' ||
                  !chats.some((item) => item.id === stage.id) ||
                  !selectedProfile ||
                  (remoteChat && !allowRemoteText)
                }
                onClick={() => void compare()}
              >
                Rerun Chat only (private)
              </Button>
            </div>
          )}
          {comparison && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="font-medium">Archived Chat vs new Chat</p>
              <p className="text-zinc-400">
                Model changed: {String(comparison.changes.model)} · profile revision changed:
                {String(comparison.changes.profileRevision)} · output changed:
                {String(comparison.changes.output)}.
                {comparison.changes.possibleSamplingVariation
                  ? ' Same model, seed and profile revision: variation may reflect nondeterministic sampling or provider behavior.'
                  : ' Differences may reflect model, prompt, context or configuration changes; a shared seed alone does not prove determinism.'}
              </p>
              {comparison.experiment.error && <p role="alert">{comparison.experiment.error}</p>}
              <JsonInspector title="Original accepted Chat" value={comparison.original.accepted} />
              <JsonInspector
                title="New Chat experiment evidence"
                value={comparison.experiment.stages}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

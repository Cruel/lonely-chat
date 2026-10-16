import { describe, expect, it } from 'vitest';
import { InferenceHistory } from './inference-history';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const now = 1_700_000_000_000;

describe('bounded inference context and observation boundaries', () => {
  it('reconstructs bounded chat/event/transcript history and only unacknowledged observations', () => {
    const history = new InferenceHistory(DEFAULT_PREFERENCES);
    history.reset(now);
    history.recordObservation(
      { kind: 'visual', source: 'camera', description: 'opening map', observedAt: now },
      now,
    );
    history.recordTranscript({ source: 'streamer mic', text: 'hello there', observedAt: now }, now);
    const first = history.snapshot('a game', 1, now + 50, 3000, []);
    expect(first.boundary).toMatchObject({
      fromSequence: 0,
      throughSequence: 2,
      fromMs: now,
      throughMs: now + 50,
    });
    expect(first.observations?.map((item) => item.description)).toEqual(['opening map']);
    expect(first.recentTranscripts?.map((item) => item.source)).toEqual(['streamer mic']);
    expect(first.roster?.length).toBe(3);
    history.recordObservation(
      { kind: 'audio', source: 'game audio', description: 'gunshot', observedAt: now + 100 },
      now + 100,
    );
    expect(first.observations?.map((item) => item.description)).toEqual(['opening map']);
    history.acknowledge(first.boundary);
    history.commitEvents(
      [{ kind: 'reaction', summary: 'saw the map', observedAt: now + 50 }],
      now + 100,
    );
    const second = history.snapshot('a game', 2, now + 200, 3000, [
      { id: 'chat-1', author: 'pixelpilot', color: '#ffffff', text: 'map!', presentedAt: now + 60 },
    ]);
    expect(second.boundary).toMatchObject({
      fromSequence: 2,
      throughSequence: 3,
      fromMs: now + 50,
    });
    expect(second.observations?.map((item) => item.description)).toEqual(['gunshot']);
    expect(second.recentTranscripts?.map((item) => item.text)).toEqual(['hello there']);
    expect(second.recentEvents?.[0].summary).toBe('saw the map');
    expect(second.recentChat?.map((item) => item.text)).toEqual(['map!']);
    history.acknowledge(second.boundary);
    expect(history.snapshot('a game', 3, now + 300, 3000, []).observations).toEqual([]);
  });

  it('applies both count and age limits and reports discarded unacknowledged inputs', () => {
    const history = new InferenceHistory({ historyMaxCount: 16, historyMaxAgeMs: 30000 });
    history.reset(now);
    for (let n = 0; n < 20; n++) {
      history.recordObservation(
        { kind: 'visual', source: 'screen', description: String(n), observedAt: now + n },
        now + n,
      );
    }
    expect(history.droppedObservations).toBe(4);
    const first = history.snapshot('stream', 1, now + 20, 3000, []);
    expect(first.observations?.map((item) => item.description)).toEqual(
      Array.from({ length: 16 }, (_, i) => String(i + 4)),
    );
    history.commitEvents(
      Array.from({ length: 20 }, (_, i) => ({
        kind: 'context' as const,
        summary: String(i),
        observedAt: now + i,
      })),
      now + 20,
    );
    expect(history.recentEvents(now + 20)).toHaveLength(16);
    expect(history.snapshot('stream', 2, now + 30050, 3000, []).observations).toEqual([]);
    expect(history.recentEvents(now + 30050)).toHaveLength(0);
    expect(history.droppedObservations).toBe(20);
  });

  it('rejects impossible timestamps, invalid kinds and invalid acknowledgement boundaries', () => {
    const history = new InferenceHistory(DEFAULT_PREFERENCES);
    history.reset(now);
    expect(() =>
      history.recordObservation(
        { source: 'x', kind: 'visual', description: 'x', observedAt: now + 10000 },
        now,
      ),
    ).toThrow();
    expect(() =>
      history.recordTranscript({ source: '', text: 'private', observedAt: now }, now),
    ).toThrow();
    expect(() =>
      history.acknowledge({ fromSequence: 9, throughSequence: 10, fromMs: now, throughMs: now }),
    ).toThrow();
  });
});

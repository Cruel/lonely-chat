/** Track selection is available only when Chromium exposes HTMLMediaElement.audioTracks.
 * Otherwise a supported soundtrack is captured as one mixed source. */
interface SelectableAudioTrack {
  enabled: boolean;
  label?: string;
  language?: string;
}

type TrackAwareElement = HTMLMediaElement & {
  audioTracks?: { length: number; [index: number]: SelectableAudioTrack };
  captureStream?: () => MediaStream;
};

export interface EmbeddedTrackChoice {
  index: number;
  label: string;
}

export function inspectEmbeddedAudio(element: HTMLMediaElement): {
  tracks: EmbeddedTrackChoice[] | null;
  error: string | null;
} {
  const media = element as TrackAwareElement;
  if (media.audioTracks?.length) {
    const tracks = Array.from({ length: media.audioTracks.length }, (_, index) => {
      const track = media.audioTracks![index];
      return {
        index,
        label: track.label?.trim() || track.language?.trim() || `Audio track ${index + 1}`,
      };
    });
    return { tracks, error: null };
  }
  if (typeof media.captureStream === 'function') {
    try {
      if (!media.captureStream().getAudioTracks().length)
        return { tracks: null, error: 'This video has no accessible embedded audio soundtrack.' };
      return { tracks: null, error: null };
    } catch {
      return { tracks: null, error: 'Chromium cannot access this video soundtrack.' };
    }
  }
  // A decoder that explicitly exposes an empty track list has no selectable audio.
  if (media.audioTracks)
    return { tracks: null, error: 'This video has no accessible embedded audio tracks.' };
  // No track enumeration: Chromium may decode a mixed soundtrack but cannot split it.
  return { tracks: null, error: null };
}

export function selectEmbeddedAudioTrack(element: HTMLMediaElement, index: number | null): void {
  if (index === null) return;
  const tracks = (element as TrackAwareElement).audioTracks;
  if (!tracks || !tracks[index])
    throw new Error('The selected embedded audio track is unavailable in this decoder.');
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
}

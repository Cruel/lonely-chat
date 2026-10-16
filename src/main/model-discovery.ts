import type {
  ModelCandidate,
  ModelDiscoveryResult,
  ModelFile,
  ModelProjector,
} from '../shared/model-contract';

const HUB = 'https://huggingface.co';
const REPO_PART = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT = /(?:^|[-_.])((?:IQ\d_[A-Z0-9]+)|(?:Q\d(?:_[A-Z0-9]+)+)|(?:BF16|F16|F32))(?:$|[-_.])/i;
const MAX_PAGES = 200;

export interface HuggingFaceInput {
  readonly repo: string;
  readonly revision: string;
  readonly file: string | null;
}

function safeSegments(path: string): boolean {
  return (
    path.length > 0 &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !part.includes('\\') &&
          [...part].every((character) => character.charCodeAt(0) >= 32),
      )
  );
}

function decodePathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error('Invalid URL encoding in Hugging Face path.');
  }
  if (!safeSegments(decoded)) throw new Error('Invalid Hugging Face path segment.');
  return decoded;
}

/** Accept model repository identifiers and unambiguous HTTPS model web URLs only. */
export function parseHuggingFaceInput(value: unknown): HuggingFaceInput {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new Error('Enter a Hugging Face owner/repository or model URL (up to 2048 characters).');
  }
  const input = value.trim();
  if (
    !input.includes('://') &&
    !input.startsWith('http') &&
    !input.includes('?') &&
    !input.includes('#')
  ) {
    const parts = input.split('/');
    if (
      parts.length === 2 &&
      parts.every((part) => REPO_PART.test(part)) &&
      !['datasets', 'spaces', 'collections', 'api'].includes(parts[0].toLowerCase())
    ) {
      return { repo: input, revision: 'main', file: null };
    }
  }
  let url: URL;
  try {
    url = new URL(
      /^(?:huggingface\.co|www\.huggingface\.co|hf\.co)\//i.test(input)
        ? `https://${input}`
        : input,
    );
  } catch {
    throw new Error('Use owner/repository or an HTTPS URL from huggingface.co (or hf.co).');
  }
  if (url.protocol !== 'https:') throw new Error('Hugging Face URLs must use HTTPS.');
  if (
    !['huggingface.co', 'www.huggingface.co', 'hf.co'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Only public model URLs on huggingface.co or hf.co are supported.');
  }
  const urlParts = url.pathname.split('/').filter(Boolean).map(decodePathSegment);
  const parts = urlParts[0] === 'models' ? urlParts.slice(1) : urlParts;
  if (
    parts.length < 2 ||
    !parts.slice(0, 2).every((part) => REPO_PART.test(part)) ||
    ['datasets', 'spaces', 'collections', 'api'].includes(parts[0].toLowerCase())
  ) {
    throw new Error('Expected a Hugging Face model repository path: /owner/repository.');
  }
  const repo = parts.slice(0, 2).join('/');
  if (parts.length === 2) return { repo, revision: 'main', file: null };
  const action = parts[2];
  if (!['tree', 'blob', 'resolve', 'raw'].includes(action)) {
    throw new Error(
      'Unsupported Hugging Face URL path. Use a model repository, tree, blob or resolve URL.',
    );
  }
  if (!parts[3]) throw new Error('A Hugging Face file or tree URL needs a revision.');
  const revision = parts[3];
  if (!safeSegments(revision)) throw new Error('Invalid Hugging Face revision.');
  if (action === 'tree') return { repo, revision, file: null };
  // A percent-encoded slash inside a file segment must not escape the repository path.
  const fileSegments = parts.slice(4);
  if (fileSegments.length === 0 || fileSegments.some((part) => part.includes('/'))) {
    throw new Error('A Hugging Face file URL must include a file path after its revision.');
  }
  const file = fileSegments.join('/');
  if (!safeSegments(file)) throw new Error('Invalid Hugging Face file path.');
  return { repo, revision, file };
}

function urlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function sizeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelFiles(entries: readonly unknown[], warnings: string[]): ModelFile[] {
  const files = new Map<string, ModelFile>();
  for (const item of entries) {
    const entry = record(item);
    if (!entry || entry.type !== 'file' || typeof entry.path !== 'string') continue;
    if (!safeSegments(entry.path)) {
      warnings.push('A repository entry had an invalid path and was ignored.');
      continue;
    }
    const lfs = record(entry.lfs);
    const size = sizeOf(entry.size) ?? sizeOf(lfs?.size);
    const existing = files.get(entry.path);
    if (!existing || (existing.sizeBytes === null && size !== null)) {
      files.set(entry.path, { path: entry.path, sizeBytes: size });
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function quantization(path: string): string | null {
  const base =
    path
      .split('/')
      .at(-1)
      ?.replace(/\.gguf$/i, '') ?? '';
  const match = base.match(QUANT);
  return match ? match[1].toUpperCase() : null;
}

function totalBytes(files: readonly ModelFile[]): number | null {
  return files.every((file) => file.sizeBytes !== null)
    ? files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0)
    : null;
}

function groupGguf(files: readonly ModelFile[], warnings: string[]): ModelProjector[] {
  const groups = new Map<
    string,
    { expected: number; shards: Map<number, ModelFile>; single?: ModelFile }
  >();
  for (const file of files) {
    const match = file.path.match(SHARD);
    const base = match ? `${match[1]}.gguf` : file.path;
    let group = groups.get(base);
    if (!group) {
      group = { expected: match ? Number(match[3]) : 1, shards: new Map() };
      groups.set(base, group);
    }
    if (!match) {
      group.single = file;
      continue;
    }
    const index = Number(match[2]);
    const count = Number(match[3]);
    if (
      count > 99999 ||
      count < 2 ||
      index < 1 ||
      index > count ||
      group.expected !== count ||
      group.single ||
      group.shards.has(index)
    ) {
      warnings.push(`Invalid multipart GGUF entry: ${file.path}.`);
      group.expected = -1;
      continue;
    }
    group.shards.set(index, file);
  }

  const result: ModelProjector[] = [];
  for (const [id, group] of groups) {
    if (group.expected === -1 || (group.single && group.shards.size > 0)) {
      warnings.push(`Conflicting GGUF shards for ${id}; skipped.`);
      continue;
    }
    const complete = group.single
      ? [group.single]
      : Array.from({ length: group.expected }, (_unused, index) => group.shards.get(index + 1));
    if (complete.some((file) => !file)) {
      warnings.push(`Incomplete multipart GGUF for ${id}; skipped missing shards.`);
      continue;
    }
    const ordered = complete as ModelFile[];
    result.push({
      id,
      quantization: quantization(id),
      sizeBytes: totalBytes(ordered),
      files: ordered,
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function isProjector(path: string): boolean {
  return /^(?:mmproj|mm-projector)(?:[-_.]|$)/i.test(path.split('/').at(-1) ?? '');
}

function folder(path: string): string {
  return path.substring(0, path.lastIndexOf('/') + 1);
}

function nextPage(link: string | null, current: URL, expectedPath: string): URL | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  if (!match) return null;
  let next: URL;
  try {
    next = new URL(match[1], current);
  } catch {
    throw new Error('Unsafe Hugging Face pagination link.');
  }
  if (
    next.origin !== HUB ||
    next.pathname !== expectedPath ||
    next.searchParams.get('recursive') !== 'true'
  ) {
    throw new Error('Unsafe Hugging Face pagination link; refusing to fetch another endpoint.');
  }
  return next;
}

/** Network requests remain in Electron main; only validated discovery results cross IPC. */
export class ModelDiscovery {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async discover(input: unknown): Promise<ModelDiscoveryResult> {
    const { repo, revision, file } = parseHuggingFaceInput(input);
    const apiPath = `/api/models/${urlPath(repo)}`;
    const info = await this.request(new URL(apiPath, HUB));
    const metadata = record(await info.json());
    if (!metadata) throw new Error('Invalid Hugging Face repository metadata.');
    if (metadata.private === true || (metadata.gated !== undefined && metadata.gated !== false)) {
      throw new Error(
        'Private or gated Hugging Face repositories are not supported without authentication. Choose a public model.',
      );
    }

    const treePath = `${apiPath}/tree/${encodeURIComponent(revision)}`;
    let next: URL | null = new URL(treePath, HUB);
    next.searchParams.set('recursive', 'true');
    const visited = new Set<string>();
    const entries: unknown[] = [];
    while (next) {
      if (visited.size >= MAX_PAGES || visited.has(next.href)) {
        throw new Error('Hugging Face pagination did not terminate safely.');
      }
      visited.add(next.href);
      const page = await this.request(next);
      const body: unknown = await page.json();
      if (!Array.isArray(body)) throw new Error('Invalid Hugging Face repository file listing.');
      entries.push(...body);
      next = nextPage(page.headers.get('link'), next, treePath);
    }

    const warnings: string[] = [];
    const files = modelFiles(entries, warnings);
    const weights = groupGguf(
      files.filter((item) => /\.gguf$/i.test(item.path)),
      warnings,
    );
    const projectors = weights.filter((item) => isProjector(item.id));
    const speech: ModelCandidate[] = files
      .filter((item) =>
        /^ggml-(?!vocab\b)[a-z0-9._-]+\.bin$/i.test(item.path.split('/').at(-1) ?? ''),
      )
      .map((item) => ({
        id: item.path,
        role: 'speech-to-text',
        format: 'whisper-ggml',
        quantization: null,
        sizeBytes: item.sizeBytes,
        files: [item],
        compatibleProjectorIds: [],
        suggestedProjectorId: null,
      }));
    const vision: ModelCandidate[] = weights
      .filter((item) => !isProjector(item.id))
      .map((item) => {
        const choices = projectors
          .filter((projector) => folder(projector.id) === folder(item.id))
          .map((projector) => projector.id);
        if (choices.length > 1)
          warnings.push(`Select a projector explicitly for ${item.id}; companions are ambiguous.`);
        return {
          ...item,
          role: 'vision-language',
          format: 'gguf',
          compatibleProjectorIds: choices,
          suggestedProjectorId: choices.length === 1 ? choices[0] : null,
        };
      });
    const candidates = [...vision, ...speech].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (candidates.length === 0) {
      throw new Error(
        files.some((item) => /\.(safetensors|bin|pt|pth)$/i.test(item.path))
          ? 'This repository has no supported GGUF or whisper.cpp ggml model weights. Safetensors/Transformers weights cannot be converted here.'
          : 'No supported GGUF or whisper.cpp ggml model weights found in this Hugging Face repository.',
      );
    }
    const matching = file
      ? candidates.find((candidate) => candidate.files.some((part) => part.path === file))
      : null;
    const projector = file
      ? projectors.find((candidate) => candidate.files.some((part) => part.path === file))
      : null;
    if (file && !matching && !projector) {
      if (!files.some((part) => part.path === file)) {
        throw new Error(`File ${file} was not found in this repository revision.`);
      }
      throw new Error(
        `File ${file} is not a supported model artifact (GGUF or whisper.cpp ggml weight).`,
      );
    }
    if (file && projector && !matching) {
      warnings.push('Projector file preselected. Choose the corresponding GGUF model explicitly.');
    }
    if (
      candidates.some((candidate) => candidate.sizeBytes === null) ||
      projectors.some((candidate) => candidate.sizeBytes === null)
    ) {
      warnings.push('Some file sizes are not available from Hugging Face; totals are unknown.');
    }
    const role: ModelDiscoveryResult['role'] =
      vision.length && speech.length
        ? 'mixed'
        : vision.length
          ? 'vision-language'
          : 'speech-to-text';
    return {
      repo,
      revision,
      role,
      candidates,
      projectors,
      preselectedCandidateId: matching?.id ?? null,
      preselectedProjectorId: projector?.id ?? null,
      warnings,
    };
  }

  private async request(url: URL): Promise<Response> {
    let result: Response;
    try {
      result = await this.fetcher(url.toString(), {
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
    } catch {
      throw new Error('Could not contact Hugging Face. Check your connection and try again.');
    }
    if (result.status === 401 || result.status === 403) {
      throw new Error(
        'Hugging Face denied access (private/gated repository); sign in or use a public model.',
      );
    }
    if (result.status === 404) {
      throw new Error(
        'Hugging Face repository or revision not found. Check the owner, name and revision.',
      );
    }
    if (!result.ok)
      throw new Error(`Hugging Face API returned HTTP ${result.status}; try again later.`);
    return result;
  }
}

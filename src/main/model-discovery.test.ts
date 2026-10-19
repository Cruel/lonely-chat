import { describe, expect, it, vi } from 'vitest';
import { ModelDiscovery, parseHuggingFaceInput } from './model-discovery';

function hub(files: unknown[], opts?: { metadata?: Record<string, unknown>; pages?: unknown[][] }) {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = new URL(String(url));
    if (address.pathname === '/api/models/acme/stream-model') {
      return new Response(JSON.stringify({ id: 'acme/stream-model', ...opts?.metadata }), {
        status: 200,
      });
    }
    if (address.pathname === '/api/models/acme/stream-model/tree/main') {
      const page = Number(address.searchParams.get('cursor') ?? '0');
      const pages = opts?.pages ?? [files];
      if (page >= pages.length) throw new Error('Unexpected page request');
      const next =
        page + 1 < pages.length
          ? `<https://huggingface.co/api/models/acme/stream-model/tree/main?recursive=true&cursor=${page + 1}>; rel="next"`
          : '';
      return new Response(JSON.stringify(pages[page]), {
        status: 200,
        headers: next ? { link: next } : undefined,
      });
    }
    throw new Error(`Unexpected Hugging Face API request: ${address}`);
  });
  return { discovery: new ModelDiscovery(fetcher as typeof fetch), fetcher };
}

describe('Hugging Face inputs', () => {
  it('accepts a model name, repository page, and file viewer/download forms', () => {
    expect(parseHuggingFaceInput('  acme/stream-model  ')).toEqual({
      repo: 'acme/stream-model',
      revision: 'main',
      file: null,
    });
    expect(parseHuggingFaceInput('https://huggingface.co/models/acme/stream-model')).toEqual({
      repo: 'acme/stream-model',
      revision: 'main',
      file: null,
    });
    expect(parseHuggingFaceInput('hf.co/acme/stream-model/tree/main')).toEqual({
      repo: 'acme/stream-model',
      revision: 'main',
      file: null,
    });
    expect(parseHuggingFaceInput('https://hf.co/acme/stream-model/tree/main')).toEqual({
      repo: 'acme/stream-model',
      revision: 'main',
      file: null,
    });
    expect(
      parseHuggingFaceInput(
        'https://huggingface.co/acme/stream-model/blob/dev%2Ftest/sub/model.gguf?download=true',
      ),
    ).toEqual({
      repo: 'acme/stream-model',
      revision: 'dev/test',
      file: 'sub/model.gguf',
    });
    expect(
      parseHuggingFaceInput('https://huggingface.co/acme/stream-model/resolve/main/model.gguf'),
    ).toEqual({
      repo: 'acme/stream-model',
      revision: 'main',
      file: 'model.gguf',
    });
  });

  it.each([
    'https://evil.example/acme/stream-model/resolve/main/model.gguf',
    'http://huggingface.co/acme/stream-model',
    'https://huggingface.co/datasets/acme/stream-model',
    'https://huggingface.co/acme/stream-model/discussions/2',
    'https://huggingface.co/acme/stream-model/resolve/main',
    'https://huggingface.co/acme/stream-model/blob/main/%2e%2e/x.gguf',
    'acme',
    'acme/stream-model/extra',
  ])('rejects invalid/unsupported input %s with a useful error', (input) => {
    expect(() => parseHuggingFaceInput(input)).toThrow(
      /Hugging Face|repository|model|file|path|HTTPS|supported/i,
    );
  });
});

describe('Hugging Face discovery', () => {
  it('lists quantizations, sizes and preselects a directly referenced GGUF', async () => {
    const { discovery, fetcher } = hub([
      { type: 'file', path: 'model-Q4_K_M.gguf', size: 4_000 },
      { type: 'file', path: 'model-Q8_0.gguf', lfs: { size: 8_000 } },
      { type: 'file', path: 'README.md', size: 20 },
    ]);
    const result = await discovery.discover(
      'https://huggingface.co/acme/stream-model/resolve/main/model-Q8_0.gguf',
    );
    expect(result.role).toBe('vision-language');
    expect(result.candidates.map((x) => [x.id, x.quantization, x.sizeBytes])).toEqual([
      ['model-Q4_K_M.gguf', 'Q4_K_M', 4_000],
      ['model-Q8_0.gguf', 'Q8_0', 8_000],
    ]);
    expect(result.preselectedCandidateId).toBe('model-Q8_0.gguf');
    expect(result.candidates[0].files).toEqual([{ path: 'model-Q4_K_M.gguf', sizeBytes: 4_000 }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('collects recursively paginated file trees, retains unknown sizes and de-duplicates files', async () => {
    const { discovery, fetcher } = hub([], {
      pages: [
        [
          { type: 'file', path: 'nested/model-Q4_K_M.gguf' },
          { type: 'directory', path: 'nested' },
        ],
        [
          { type: 'file', path: 'nested/model-Q4_K_M.gguf', size: 444 },
          { type: 'file', path: 'model-Q5_K_M.gguf', size: 555 },
        ],
      ],
    });
    const result = await discovery.discover('acme/stream-model');
    expect(result.candidates.map((c) => [c.id, c.sizeBytes])).toEqual([
      ['model-Q5_K_M.gguf', 555],
      ['nested/model-Q4_K_M.gguf', 444],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('treats a complete multipart GGUF as one artifact and excludes incomplete groups', async () => {
    const { discovery } = hub([
      { type: 'file', path: 'A-Q4_K_M-00002-of-00003.gguf', size: 20 },
      { type: 'file', path: 'A-Q4_K_M-00001-of-00003.gguf', size: 10 },
      { type: 'file', path: 'A-Q4_K_M-00003-of-00003.gguf', size: 30 },
      { type: 'file', path: 'B-Q8_0-00001-of-00002.gguf', size: 80 },
    ]);
    const result = await discovery.discover(
      'https://hf.co/acme/stream-model/blob/main/A-Q4_K_M-00002-of-00003.gguf',
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sizeBytes).toBe(60);
    expect(result.candidates[0].files.map((file) => file.path)).toEqual([
      'A-Q4_K_M-00001-of-00003.gguf',
      'A-Q4_K_M-00002-of-00003.gguf',
      'A-Q4_K_M-00003-of-00003.gguf',
    ]);
    expect(result.preselectedCandidateId).toBe(result.candidates[0].id);
    expect(result.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('links unambiguous projectors but requires explicit selection for ambiguous companions', async () => {
    const { discovery } = hub([
      { type: 'file', path: 'vision-Q4_K_M.gguf', size: 40 },
      { type: 'file', path: 'mmproj-F16.gguf', size: 10 },
      { type: 'file', path: 'mmproj-BF16.gguf', size: 11 },
    ]);
    const result = await discovery.discover('acme/stream-model');
    expect(result.projectors).toHaveLength(2);
    expect(result.candidates[0].compatibleProjectorIds).toHaveLength(2);
    expect(result.candidates[0].suggestedProjectorId).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/choose|select|ambiguous/i);
  });

  it('recognizes projectors with a repository/model prefix before mmproj', async () => {
    const { discovery } = hub([
      { type: 'file', path: 'Huihui-Qwen3.5-0.8B-abliterated-Q4_K_M.gguf', size: 40 },
      { type: 'file', path: 'Huihui-Qwen3.5-0.8B-abliterated.mmproj-Q8_0.gguf', size: 11 },
      { type: 'file', path: 'Huihui-Qwen3.5-0.8B-abliterated.mmproj-f16.gguf', size: 12 },
    ]);
    const result = await discovery.discover('acme/stream-model');
    expect(result.candidates).toHaveLength(1);
    expect(result.projectors.map((item) => item.quantization)).toEqual(['F16', 'Q8_0']);
    expect(result.candidates[0].compatibleProjectorIds).toHaveLength(2);
  });

  it('does not arbitrarily attach projectors in other folders to unrelated models', async () => {
    const { discovery } = hub([
      { type: 'file', path: 'alpha/model-Q4_K_M.gguf', size: 40 },
      { type: 'file', path: 'beta/model-Q5_K_M.gguf', size: 50 },
      { type: 'file', path: 'alpha/mmproj-f16.gguf', size: 10 },
    ]);
    const result = await discovery.discover('acme/stream-model');
    expect(result.candidates[0].compatibleProjectorIds).toEqual(['alpha/mmproj-f16.gguf']);
    expect(result.candidates[0].suggestedProjectorId).toBe('alpha/mmproj-f16.gguf');
    expect(result.candidates[1].compatibleProjectorIds).toEqual([]);
  });

  it('discovers native speech weights and rejects transformers-only repositories', async () => {
    const speech = hub([
      { type: 'file', path: 'ggml-base.en.bin', size: 150 },
      { type: 'file', path: 'ggml-large-v3-turbo.bin', size: 1000 },
      { type: 'file', path: 'pytorch_model.bin', size: 2000 },
    ]);
    const result = await speech.discovery.discover('acme/stream-model');
    expect(result.role).toBe('speech-to-text');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      'ggml-base.en.bin',
      'ggml-large-v3-turbo.bin',
    ]);
    await expect(
      hub([
        { type: 'file', path: 'model.safetensors' },
        { type: 'file', path: 'config.json' },
      ]).discovery.discover('acme/stream-model'),
    ).rejects.toThrow(/Safetensors|Transformers|GGUF|whisper/i);
  });

  it('rejects missing direct files and unsupported direct artifacts', async () => {
    const { discovery } = hub([
      { type: 'file', path: 'model-Q4_K_M.gguf', size: 40 },
      { type: 'file', path: 'readme.md', size: 20 },
    ]);
    await expect(
      discovery.discover('https://huggingface.co/acme/stream-model/resolve/main/missing.gguf'),
    ).rejects.toThrow(/not found|missing/i);
    await expect(
      discovery.discover('https://huggingface.co/acme/stream-model/resolve/main/readme.md'),
    ).rejects.toThrow(/not a supported/i);
  });

  it('ignores malformed or non-file listing entries rather than offering them for installation', async () => {
    const { discovery } = hub([
      { type: 'directory', path: 'models' },
      { type: 'file', path: '../unsafe-Q4_K_M.gguf', size: 100 },
      { type: 'file', path: 'ok-Q4_K_M.gguf', size: -3 },
      { type: 'file', path: 'models/../bad-Q4_K_M.gguf', size: 100 },
    ]);
    const result = await discovery.discover('acme/stream-model');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe('ok-Q4_K_M.gguf');
    expect(result.candidates[0].sizeBytes).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/invalid path|sizes are not available/);
  });

  it('rejects gated model metadata even if the file tree would otherwise be discoverable', async () => {
    const { discovery, fetcher } = hub([{ type: 'file', path: 'model.gguf' }], {
      metadata: { gated: 'manual' },
    });
    await expect(discovery.discover('acme/stream-model')).rejects.toThrow(/gated|authentication/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces HTTP errors and refuses off-host pagination redirects', async () => {
    const rejected = new ModelDiscovery(async () => new Response('denied', { status: 401 }));
    await expect(rejected.discover('acme/stream-model')).rejects.toThrow(
      /private|access|401|sign in/i,
    );
    const attack = new ModelDiscovery(async (url) => {
      if (String(url).includes('/tree/main')) {
        return new Response('[]', {
          headers: { link: '<https://attacker.example/secret>; rel="next"' },
        });
      }
      return new Response('{"id":"acme/stream-model"}');
    });
    await expect(attack.discover('acme/stream-model')).rejects.toThrow(/pagination|unsafe/i);
  });
});

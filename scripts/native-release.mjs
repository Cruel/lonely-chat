// Reproducible upstream artifacts; SHA-256 values from the pinned b11700 release.
export const LLAMA_RELEASE = 'b11700';
export const LLAMA_ASSETS = {
  'linux-x64': {
    cpu: [
      'llama-b11700-bin-ubuntu-x64.tar.gz',
      '51842656431fc20928123e0c88598f7604a2fe2031fb4e7d45943316817de024',
    ],
    vulkan: [
      'llama-b11700-bin-ubuntu-vulkan-x64.tar.gz',
      '7a72ae05c3054077a90a4d33d1079271cf2360a20019927d147feaa9be647983',
    ],
    cuda: [
      'llama-b11700-bin-ubuntu-cuda-13.4-x64.tar.gz',
      '8f9d3ce07508307edf07c28ba40c34ad387c8ba163d8aecc5c54fd8e067c8e5e',
    ],
    cudart: [
      'cudart-llama-b11700-bin-ubuntu-cuda-13.4-x64.tar.gz',
      '9f017e8b7370bf5b87374de646d2782882300db3585a0da0a707e79cd02993f2',
    ],
  },
  'win32-x64': {
    cpu: [
      'llama-b11700-bin-win-cpu-x64.zip',
      '4e2af6b2b39691cd84267a02839596ed6653ea2dde5ee9cdbfeb4dd9677eecbb',
    ],
    vulkan: [
      'llama-b11700-bin-win-vulkan-x64.zip',
      'd93ccad5992d6640d7081407c24d3ceddf717bc0a1c3c269225c9bef0182f83e',
    ],
    cuda: [
      'llama-b11700-bin-win-cuda-13.4-x64.zip',
      'bf89070a54f8665ed2ad1693fe602a45fa1bfe85aecf1aba754a0cc5737342e0',
    ],
    cudart: [
      'cudart-llama-bin-win-cuda-13.4-x64.zip',
      '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668',
    ],
  },
  'darwin-arm64': {
    cpu: [
      'llama-b11700-bin-macos-arm64.tar.gz',
      '75d795f8826e09893d44e040742ca5dd604d9402dc40393aed0aea6866aadd73',
    ],
  },
};
export const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
export const WHISPER_ARCHIVE_SHA256 =
  '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4';
export const TARGETS = Object.keys(LLAMA_ASSETS);

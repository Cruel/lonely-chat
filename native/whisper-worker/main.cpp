#include "whisper.h"

#include <algorithm>
#include <cmath>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {
constexpr uint32_t kMaxFrame = 16000 * 4 * 30 + 32;
constexpr uint8_t kInit = 1, kTranscribe = 2, kReady = 0x81, kResult = 0x82, kError = 0xff;

bool read_exact(void* destination, size_t count) {
  auto* data = static_cast<unsigned char*>(destination);
  while (count) {
    size_t amount = fread(data, 1, count, stdin);
    if (!amount) return false;
    data += amount;
    count -= amount;
  }
  return true;
}

bool send(uint8_t kind, const std::string& data) {
  if (data.size() + 1 > kMaxFrame) return false;
  uint32_t size = static_cast<uint32_t>(data.size() + 1);
  unsigned char header[] = { static_cast<unsigned char>(size), static_cast<unsigned char>(size >> 8),
    static_cast<unsigned char>(size >> 16), static_cast<unsigned char>(size >> 24), kind };
  return fwrite(header, 1, sizeof(header), stdout) == sizeof(header) &&
    fwrite(data.data(), 1, data.size(), stdout) == data.size() && fflush(stdout) == 0;
}

void log_callback(enum ggml_log_level, const char*, void*) {} // suppress model stdout/stderr chatter

} // namespace

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  whisper_log_set(log_callback, nullptr);
  std::unique_ptr<whisper_context, decltype(&whisper_free)> context(nullptr, whisper_free);
  for (;;) {
    unsigned char header[4];
    if (!read_exact(header, 4)) return 0;
    uint32_t size = uint32_t(header[0]) | (uint32_t(header[1]) << 8) |
      (uint32_t(header[2]) << 16) | (uint32_t(header[3]) << 24);
    if (size < 1 || size > kMaxFrame) return 2;
    std::vector<unsigned char> bytes(size);
    if (!read_exact(bytes.data(), size)) return 3;
    uint8_t kind = bytes[0];
    if (kind == kInit) {
      if (context || size < 2 || size > 4096 ||
          std::find(bytes.begin() + 1, bytes.end(), 0) != bytes.end()) {
        if (!send(kError, "Invalid model initialization.")) return 4;
        continue;
      }
      std::string name(bytes.begin() + 1, bytes.end());
      auto params = whisper_context_default_params();
      params.use_gpu = false;
      context.reset(whisper_init_from_file_with_params(name.c_str(), params));
      if (!send(context ? kReady : kError, context ? "" : "Unable to load native speech model.")) return 5;
    } else if (kind == kTranscribe) {
      if (!context || (size - 1) % sizeof(float) != 0 || size < 1 + 1600 * 4) {
        if (!send(kError, "Invalid audio frame or model not initialized.")) return 6;
        continue;
      }
      std::vector<float> pcm((size - 1) / 4);
      std::memcpy(pcm.data(), bytes.data() + 1, size - 1);
      bool valid = true;
      for (float sample : pcm) if (!std::isfinite(sample) || std::abs(sample) > 1.01f) { valid = false; break; }
      if (!valid) { if (!send(kError, "Invalid PCM samples.")) return 7; continue; }
      auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
      params.print_realtime = false;
      params.print_progress = false;
      params.print_timestamps = false;
      params.print_special = false;
      params.no_context = true;
      params.single_segment = false;
      params.language = "auto";
      if (whisper_full(context.get(), params, pcm.data(), static_cast<int>(pcm.size())) != 0) {
        if (!send(kError, "Speech inference failed.")) return 8;
        continue;
      }
      std::string result;
      int count = whisper_full_n_segments(context.get());
      for (int i = 0; i < count; ++i) {
        const char* text = whisper_full_get_segment_text(context.get(), i);
        if (text) {
          if (!result.empty()) result += ' ';
          result += text;
        }
      }
      if (!send(kResult, result.substr(0, 4000))) return 9;
    } else {
      if (!send(kError, "Unknown speech IPC request.")) return 10;
    }
  }
}

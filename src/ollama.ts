/**
 * Giải phóng model Ollama trước khi chạy TTS để tránh tranh VRAM giữa scan worker và render worker.
 * Gửi keep_alive: 0 cho từng model đang nạp; bỏ qua mọi lỗi.
 */

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

interface OllamaModel {
  name: string;
}

interface OllamaPsResponse {
  models?: OllamaModel[];
}

/**
 * Kiểm danh sách model đang nạp, rồi unload từng cái.
 * Không ném exception; trả `true` nếu ít nhất unload thành công một model.
 */
export async function unloadOllamaModels(ollamaUrl: string = DEFAULT_OLLAMA_URL): Promise<boolean> {
  let models: OllamaModel[] = [];

  try {
    const res = await fetch(`${ollamaUrl}/api/ps`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as OllamaPsResponse;
    models = data.models ?? [];
  } catch {
    return false;
  }

  if (models.length === 0) return true;

  let unloaded = 0;
  await Promise.all(
    models.map(async ({ name }) => {
      try {
        await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        });
        unloaded++;
      } catch {
        // ignore: server có thể đang bận hoặc không có
      }
    }),
  );

  return unloaded > 0;
}

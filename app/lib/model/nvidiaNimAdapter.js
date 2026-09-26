// NVIDIA NIM implementation of ModelAdapter — calls NIM's OpenAI-compatible
// chat completions endpoint. `NVIDIA_API_KEY` is read directly from env
// (not via the secrets provider — that indirection is reserved for the
// GitHub App private key per roadmap.md, not scoped out to every credential).

const ModelAdapter = require('./modelAdapter');
const logger = require('../logger');

// moonshotai/kimi-k3 has a known, intermittent reasoning-parser bug (see
// https://github.com/MoonshotAI/Kimi-K3/issues/45 and the NIM-side vLLM fix
// at https://github.com/vllm-project/vllm/pull/57098): it can return a 200
// with finish_reason 'stop' where message.content is empty because its
// answer was mis-routed into message.reasoning_content instead, or - more
// rarely - dropped entirely. It's server-side and sporadic, not something a
// request parameter fixes, so this is worked around here with a
// reasoning_content fallback plus a couple of retries rather than upstream.
const EMPTY_CONTENT_RETRIES = 2;

function isBlank(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

class NvidiaNimAdapter extends ModelAdapter {
  async chat({ messages }) {
    const body = { model: process.env.MODEL, messages };
    // Optional cap so a reasoning model can't burn its whole output budget on
    // reasoning and return with no final-answer content (see the content
    // check below) - omitted entirely when unset, same as before this existed.
    if (process.env.MODEL_MAX_TOKENS) {
      body.max_tokens = Number(process.env.MODEL_MAX_TOKENS);
    }

    let lastFinishReason = 'unknown';

    for (let attempt = 1; attempt <= EMPTY_CONTENT_RETRIES + 1; attempt++) {
      const response = await fetch(`${process.env.NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`NVIDIA NIM chat request failed (${response.status}): ${detail}`);
      }

      const data = await response.json();
      const choice = data.choices[0];
      lastFinishReason = choice.finish_reason || 'unknown';

      let content = choice.message.content;
      if (isBlank(content) && !isBlank(choice.message.reasoning_content)) {
        content = choice.message.reasoning_content;
      }

      if (!isBlank(content)) {
        return { content };
      }

      logger.warn('NVIDIA NIM returned empty content, retrying', { attempt, finishReason: lastFinishReason });
    }

    // Fail loudly rather than letting a null through to sessionService's
    // recordConversation, which would otherwise surface as an opaque
    // "Column 'content' cannot be null" DB error instead of this.
    throw new Error(`NVIDIA NIM chat response had no content after retries (finish_reason: ${lastFinishReason})`);
  }
}

module.exports = NvidiaNimAdapter;

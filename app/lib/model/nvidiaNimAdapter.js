// NVIDIA NIM implementation of ModelAdapter — calls NIM's OpenAI-compatible
// chat completions endpoint. `NVIDIA_API_KEY` is read directly from env
// (not via the secrets provider — that indirection is reserved for the
// GitHub App private key per roadmap.md, not scoped out to every credential).

const ModelAdapter = require('./modelAdapter');

class NvidiaNimAdapter extends ModelAdapter {
  async chat({ messages }) {
    const body = { model: process.env.MODEL, messages };
    // Optional cap so a reasoning model can't burn its whole output budget on
    // reasoning and return with no final-answer content (see the content
    // check below) - omitted entirely when unset, same as before this existed.
    if (process.env.MODEL_MAX_TOKENS) {
      body.max_tokens = Number(process.env.MODEL_MAX_TOKENS);
    }

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
    const content = choice.message.content;

    // Reasoning models (e.g. moonshotai/kimi-k3) can return a 200 with
    // message.content null/empty when the completion is cut off mid-reasoning
    // before any final-answer text is emitted (finish_reason 'length') or on
    // a content-filtered response. Fail loudly here rather than letting a
    // null through to sessionService's recordConversation, which would
    // otherwise surface as an opaque "Column 'content' cannot be null" DB
    // error instead of this.
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(
        `NVIDIA NIM chat response had no content (finish_reason: ${choice.finish_reason || 'unknown'})`
      );
    }

    return { content };
  }
}

module.exports = NvidiaNimAdapter;

// NVIDIA NIM implementation of ModelAdapter — calls NIM's OpenAI-compatible
// chat completions endpoint. `NVIDIA_API_KEY` is read directly from env
// (not via the secrets provider — that indirection is reserved for the
// GitHub App private key per roadmap.md, not scoped out to every credential).

const ModelAdapter = require('./modelAdapter');
const logger = require('../logger');

// moonshotai/kimi-k3 has known, intermittent server-side degeneration bugs on
// NIM's current serving backend - actively reported on NVIDIA's own forums
// (e.g. https://forums.developer.nvidia.com/t/kimi-k3-outputs-only/384298,
// "5 to 6 '!' and nothing else... happens in 7/10 requests"; worse on longer
// prompts per Moonshot's own https://github.com/sgl-project/sglang/issues/40751)
// on top of the reasoning-parser bug where the answer lands in
// reasoning_content instead of content, or is dropped entirely
// (https://github.com/MoonshotAI/Kimi-K3/issues/45,
// https://github.com/vllm-project/vllm/pull/57098). All of this is
// server-side and sporadic, not something a request parameter fixes, so
// it's worked around here with a reasoning_content fallback, a degenerate-
// output check, and a couple of retries rather than upstream.
const EMPTY_CONTENT_RETRIES = 2;

function isBlank(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

// Catches the repetition-collapse failure mode above: a reply that's almost
// entirely one repeated character (e.g. "!!!!!!!!!!!!") or, for longer
// collapses, one repeated short phrase - either way, far too few distinct
// characters for its length to be a real fenced-block/JSON/prose reply.
function looksDegenerate(text) {
  const distinctChars = new Set(text.trim()).size;
  return distinctChars <= 3 || (text.length > 200 && distinctChars / text.length < 0.01);
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
      let response;
      try {
        response = await fetch(`${process.env.NVIDIA_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Node's fetch (undici) collapses every network-level failure - DNS, connection
        // reset, or its own default ~300s headers/body timeout - into a generic
        // "fetch failed" TypeError, with the actual reason only on `err.cause`. Without
        // surfacing that here, every caller's logs (e.g. worker.js's "spec doc job
        // failed") only ever show "fetch failed", which is nearly useless for telling a
        // slow/hung model response apart from an actual network outage.
        const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
        throw new Error(`NVIDIA NIM chat request errored${cause}: ${err.message}`);
      }

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

      if (!isBlank(content) && !looksDegenerate(content)) {
        return { content };
      }

      logger.warn('NVIDIA NIM returned empty or degenerate content, retrying', {
        attempt,
        finishReason: lastFinishReason,
        contentPreview: isBlank(content) ? '' : content.slice(0, 80),
      });
    }

    // Fail loudly rather than letting a null/garbage reply through to
    // sessionService's recordConversation (null hits the DB's NOT NULL
    // constraint) or the pipeline's fenced-block parser (garbage fails an
    // opaque "could not be parsed" error) instead of this.
    throw new Error(`NVIDIA NIM chat response had no usable content after retries (finish_reason: ${lastFinishReason})`);
  }
}

module.exports = NvidiaNimAdapter;

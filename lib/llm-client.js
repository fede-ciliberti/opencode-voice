// OpenAI-compatible LLM client for text normalization.
//
// Works with any OpenAI-compatible endpoint:
//   - Anthropic's OpenAI compatibility layer
//   - OpenAI directly
//   - Ollama, vLLM, LM Studio, etc.
//
// Configuration is passed from plugin options (tui.json):
//   ["@renjfk/opencode-voice", {
//     "endpoint": "https://api.anthropic.com/v1",
//     "model": "claude-haiku-4-5",
//     "apiKeyEnv": "ANTHROPIC_API_KEY",
//     "maxTokens": 2048,
//     "reasoningEffort": "low",
//     "chatTemplateKwargs": {"enable_thinking": false},
//     "retries": 2
//   }]

const DEFAULTS = {
  maxTokens: 2048,
  reasoningEffort: null,
  chatTemplateKwargs: null,
  retries: 2,
};

function normalizeRetries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.retries;
  return Math.floor(parsed);
}

function normalizeChatTemplateKwargs(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM completion function.
 *
 * @param {object} [pluginOptions] - Static config from tui.json plugin options
 * @returns {{ complete: (opts: { system?: string, prompt: string, config?: object, contextMessages?: Array<{role: string, content: string}> }) => Promise<{ text: string | null, error?: string }> }}
 */
export function createClient(pluginOptions) {
  function getConfig() {
    return {
      endpoint: pluginOptions?.endpoint,
      model: pluginOptions?.model,
      apiKeyEnv: pluginOptions?.apiKeyEnv,
      maxTokens: pluginOptions?.maxTokens ?? DEFAULTS.maxTokens,
      reasoningEffort: pluginOptions?.reasoningEffort ?? DEFAULTS.reasoningEffort,
      chatTemplateKwargs: normalizeChatTemplateKwargs(
        pluginOptions?.chatTemplateKwargs ?? DEFAULTS.chatTemplateKwargs,
      ),
      retries: normalizeRetries(pluginOptions?.retries ?? DEFAULTS.retries),
    };
  }

  /**
   * Send a chat completion request to an OpenAI-compatible endpoint.
   *
   * @param {object} opts
   * @param {string} [opts.system]  - System prompt
   * @param {string} opts.prompt    - User message
   * @param {object} [opts.config]  - Per-call overrides (e.g. { maxTokens: 4096 })
   * @param {Array<{role: string, content: string}>} [opts.contextMessages] - Conversation history messages inserted between system and user prompt
   * @returns {Promise<{ text: string | null, error?: string }>}
   */
  async function complete({ system, prompt, config: overrides, contextMessages }) {
    const cfg = { ...getConfig(), ...overrides };
    if (!cfg.endpoint) return { text: null, error: "LLM endpoint not configured" };
    if (!cfg.model) return { text: null, error: "LLM model not configured" };
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;

    const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    if (contextMessages && contextMessages.length > 0) {
      messages.push(...contextMessages);
    }
    messages.push({ role: "user", content: prompt });

    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages,
    };
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          if (attempt < cfg.retries && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt);
            continue;
          }
          return { text: null, error: `LLM request failed (${response.status})` };
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) return { text };

        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: "Empty LLM response" };
      } catch (err) {
        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: `LLM error: ${err.message}` };
      }
    }

    return { text: null, error: "LLM request failed after retries" };
  }

  return { complete };
}

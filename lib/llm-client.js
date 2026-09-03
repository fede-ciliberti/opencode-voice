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
//     "timeout": 5000,
//     "fallbacks": [
//       {
//         "endpoint": "http://localhost:11434/v1",
//         "model": "llama3.2"
//       }
//     ]
//   }]

const DEFAULTS = {
  maxTokens: 2048,
  reasoningEffort: null,
  chatTemplateKwargs: null,
  timeout: 5000,
  temperature: null,
};

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULTS.timeout;
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

function normalizeFallbacks(value) {
  if (!value) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((f) => f && typeof f === "object" && f.endpoint && f.model)
    .map((f) => {
      const out = { endpoint: f.endpoint, model: f.model };
      if (f.apiKeyEnv) out.apiKeyEnv = f.apiKeyEnv;
      if (f.maxTokens != null) out.maxTokens = f.maxTokens;
      if (f.reasoningEffort != null) out.reasoningEffort = f.reasoningEffort;
      if (f.temperature != null) out.temperature = f.temperature;
      const kw = normalizeChatTemplateKwargs(f.chatTemplateKwargs);
      if (kw) out.chatTemplateKwargs = kw;
      return out;
    });
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
      timeout: normalizeTimeout(pluginOptions?.timeout ?? DEFAULTS.timeout),
      temperature: pluginOptions?.temperature ?? DEFAULTS.temperature,
      fallbacks: normalizeFallbacks(pluginOptions?.fallbacks),
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
    const primaryCfg = { ...getConfig(), ...overrides };

    const configs = [primaryCfg];
    for (const fallback of primaryCfg.fallbacks) {
      configs.push({ ...primaryCfg, ...fallback });
    }

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    if (contextMessages && contextMessages.length > 0) {
      messages.push(...contextMessages);
    }
    messages.push({ role: "user", content: prompt });

    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      if (!cfg.endpoint || !cfg.model) continue;

      const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;
      const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages,
      };
      if (cfg.temperature != null) body.temperature = cfg.temperature;
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
      if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) return { text };
      } catch {}
    }

    return { text: null, error: "All LLM attempts failed" };
  }

  return { complete };
}

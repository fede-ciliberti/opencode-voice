// Shared session helpers for OpenCode TUI plugin.

const DEFAULT_MAX_CONTEXT_CHARS = 8000; // ~2000 tokens - suficiente para referencias sin saturar

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(client, sessionID) {
  if (!sessionID) return "";
  try {
    const result = await client.session.list();
    const session = result.data?.find((s) => s.id === sessionID);
    return session?.title || "";
  } catch {
    return "";
  }
}

/**
 * Get the title of the most recently updated session. Returns "" on error or
 * when there are no sessions.
 */
export async function getActiveSessionTitle(client) {
  try {
    const result = await client.session.list();
    if (!result.data || result.data.length === 0) return "";
    const active = result.data.sort((a, b) => b.time.updated - a.time.updated)[0];
    return active?.title || "";
  } catch {
    return "";
  }
}

async function getMessageText(client, sessionID, msgID) {
  try {
    const fullMsg = await client.session
      .message({ sessionID, messageID: msgID }, { throwOnError: true })
      .then((r) => r.data);
    const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
    return textParts
      .map((p) => p.text || "")
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Extract recent conversation context from the current session.
 * @param {number} maxChars Maximum characters to include (default 8000 ≈ 2k tokens)
 * @returns {Promise<{ text: string, messages: Array<{role: string, content: string}> }>} An object containing both plain text context and structured messages.
 */
export async function getSessionContext(client, api, maxChars = DEFAULT_MAX_CONTEXT_CHARS) {
  const route = api.route.current;
  if (route.name !== "session") return { text: "", messages: [] };

  const sessionID = route.params.sessionID;
  const stateMessages = api.state.session.messages(sessionID);
  if (!stateMessages || stateMessages.length === 0) return { text: "", messages: [] };

  const pairs = [];
  const messages = [];
  let totalLen = 0;

  for (let i = stateMessages.length - 1; i >= 0 && messages.length < 20; i--) {
    const msg = stateMessages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const text = await getMessageText(client, sessionID, msg.id);
    if (!text) continue;

    const truncated = text.length > 400 ? text.substring(0, 400) + "..." : text;
    const line = `${msg.role}: ${truncated}`;

    if (totalLen + line.length > maxChars) break;

    pairs.unshift(line);
    messages.unshift({ role: msg.role, content: truncated });
    totalLen += line.length;
  }

  return { text: pairs.join("\n"), messages };
}

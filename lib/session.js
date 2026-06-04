// Shared session helpers for OpenCode TUI plugin.

const MAX_CONTEXT_CHARS = 500;

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
    return textParts.map((p) => p.text || "").join(" ").trim();
  } catch {
    return "";
  }
}

/**
 * Extract recent conversation context from the current session.
 * Returns a compact string with the last user messages and assistant responses.
 */
export async function getSessionContext(client, api) {
  const route = api.route.current;
  if (route.name !== "session") return "";

  const sessionID = route.params.sessionID;
  const stateMessages = api.state.session.messages(sessionID);
  if (!stateMessages || stateMessages.length === 0) return "";

  const pairs = [];
  let totalLen = 0;

  for (let i = stateMessages.length - 1; i >= 0 && pairs.length < 6; i--) {
    const msg = stateMessages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const text = await getMessageText(client, sessionID, msg.id);
    if (!text) continue;

    const truncated = text.length > 200 ? text.substring(0, 200) + "..." : text;
    const line = `${msg.role}: ${truncated}`;

    if (totalLen + line.length > MAX_CONTEXT_CHARS) break;

    pairs.unshift(line);
    totalLen += line.length;
  }

  return pairs.join("\n");
}

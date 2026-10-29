// Shared session helpers for OpenCode TUI plugin.

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(client, sessionID) {
  if (!sessionID) return "";
  try {
    const result = await client.session.list();
    // V2 returns { data, cursor }; V1 returned the array directly.
    const sessions = Array.isArray(result) ? result : result?.data;
    const session = sessions?.find((s) => s.id === sessionID);
    return session?.title || "";
  } catch {
    return "";
  }
}

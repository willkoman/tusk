// Typed frontend mirror of `slack::processor::SlackExecutionEvent`. The backend
// includes both flat compatibility fields and one atomic nested identity.

export type SlackConnectionIdentity = {
  id: string;
  database: string;
  driver: string;
};

export type SlackExecuted = {
  sql: string;
  durationMs: number;
  status: string;
  rows?: number;
  error?: string;
  slackUser: string;
  connectionId: string;
  database: string;
  connection: SlackConnectionIdentity;
};

/** Resolve only internally consistent identities; malformed events never hit another history. */
export function slackHistoryKey(
  event: SlackExecuted,
  keysByConnectionId: ReadonlyMap<string, string>,
): string | null {
  if (
    !event.connectionId ||
    event.connection.id !== event.connectionId ||
    event.connection.database !== event.database
  ) return null;
  return keysByConnectionId.get(event.connectionId) ?? null;
}

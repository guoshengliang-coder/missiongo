/** Old message occurred_at may be a polling fallback. Only the unread source
 * frontier (built from explicitly source-dated conversation messages), accepted
 * user commands and server-created progress reports can seed the new clock. */
export const SESSION_MESSAGE_CLOCK_SCHEMA = `
CREATE TABLE session_message_times (
  session_key TEXT NOT NULL, source_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('source_message','server_message','legacy_source_frontier','verified_native_history')),
  PRIMARY KEY(session_key,source_id)
) STRICT;
CREATE TABLE session_message_clocks (session_key TEXT PRIMARY KEY, message_at TEXT NOT NULL) STRICT;
INSERT INTO session_message_times
  SELECT session_key,'legacy:source-frontier',source_at,'legacy_source_frontier'
  FROM session_unread_state WHERE source_at IS NOT NULL AND julianday(source_at) IS NOT NULL;
INSERT OR IGNORE INTO session_message_times
  SELECT 'dispatch:'||s.dispatch_id,'command:'||c.id,c.created_at,'server_message'
  FROM agent_session_commands c JOIN agent_sessions s ON s.id=c.session_id WHERE c.kind='message';
INSERT OR IGNORE INTO session_message_times
  SELECT 'external:'||session_id,'command:'||id,created_at,'server_message' FROM external_native_commands;
INSERT OR IGNORE INTO session_message_times
  SELECT 'external:'||session_id,'report:'||id,created_at,'server_message' FROM external_agent_session_reports;
INSERT INTO session_message_clocks SELECT session_key,MAX(occurred_at) FROM session_message_times GROUP BY session_key;
`;

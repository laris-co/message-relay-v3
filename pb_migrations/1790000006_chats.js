/// <reference path="../pb_data/types.d.ts" />
// Chats: the UI's list of conversations and one conversation's messages (the layout of v1's Chat
// and v2's Explorer).
//   chats             a view collection, one row per conversation: provider + group_id, across
//                     every channel it came in on (a LINE group that moved from one bot to another
//                     is one chat), with its channels, message count, first / last time and its
//                     newest message (sender and text) for the list.
//   idx_messages_chat a conversation's messages newest first straight off the index, and the two
//                     "newest message" lookups per chat above (~0.3 s for 497 chats over 262k rows).
// timeline_groups (one row per provider / channel / group) stays for the MCP server and the scripts.
const INDEX = "CREATE INDEX idx_messages_chat ON messages (provider, group_id, ts DESC, id DESC)";

const newest = (expr) =>
  `CAST((SELECT ${expr} FROM messages l
          WHERE l.provider = m.provider AND l.group_id = m.group_id
          ORDER BY l.ts DESC, l.id DESC LIMIT 1) AS TEXT)`;

const VIEW = `SELECT MIN(m.id) AS id, m.provider AS provider, m.group_id AS group_id,
       MAX(m.group_label) AS group_label,
       CAST(GROUP_CONCAT(DISTINCT m.channel) AS TEXT) AS channels,
       COUNT(*) AS n, MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts,
       ${newest("CASE WHEN l.sender_label != '' THEN l.sender_label ELSE l.sender END")} AS last_sender,
       ${newest("substr(CASE WHEN l.text != '' THEN l.text ELSE '[' || COALESCE(NULLIF(l.media_kind, ''), l.type) || ']' END, 1, 120)")} AS last_text
FROM messages m
GROUP BY m.provider, m.group_id`;

migrate(
  (app) => {
    const m = app.findCollectionByNameOrId("messages");
    m.indexes.push(INDEX);
    app.save(m);
    app.save(
      new Collection({
        type: "view",
        name: "chats",
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        viewQuery: VIEW,
      }),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("chats"));
    const m = app.findCollectionByNameOrId("messages");
    m.indexes = m.indexes.filter((i) => !i.includes("idx_messages_chat"));
    app.save(m);
  },
);

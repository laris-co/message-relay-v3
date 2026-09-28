// id -> name. On a new message: fill sender_label / group_label from `aliases` when the source gave
// none. On an alias save: relabel every message of that id (one indexed UPDATE).

function lookup(app, kind, provider, value) {
  if (!value) return "";
  try {
    const a = app.findFirstRecordByFilter(
      "aliases",
      "kind = {:k} && value = {:v} && (provider = {:p} || provider = '')",
      { k: kind, v: value, p: provider },
    );
    return a.getString("label");
  } catch (_) {
    return "";
  }
}

function fill(app, msg) {
  const provider = msg.getString("provider");
  if (!msg.getString("sender_label")) {
    const l = lookup(app, "sender", provider, msg.getString("sender"));
    if (l) msg.set("sender_label", l);
  }
  if (!msg.getString("group_label")) {
    const l = lookup(app, "group", provider, msg.getString("group_id"));
    if (l) msg.set("group_label", l);
  }
}

function relabel(app, alias) {
  const col = alias.getString("kind") === "group" ? ["group_label", "group_id"] : ["sender_label", "sender"];
  const provider = alias.getString("provider");
  app
    .db()
    .newQuery(
      `UPDATE messages SET ${col[0]} = {:label} WHERE ${col[1]} = {:value}` + (provider ? " AND provider = {:provider}" : ""),
    )
    .bind({ label: alias.getString("label"), value: alias.getString("value"), provider })
    .execute();
}

module.exports = { fill, relabel };

// Attachments inside PocketBase: link on create (hook) and fetch the newest pending ones (cron).
// The bulk backlog is fetched by scripts/media-fetch.ts (SDK, parallel); this keeps new ones current.

/** A message with media gets its `attachments` row (pending). Cheap: one insert, no network. */
function link(app, msg) {
  const kind = msg.getString("media_kind");
  if (!kind) return;
  const col = app.findCollectionByNameOrId("attachments");
  const a = new Record(col);
  a.set("message", msg.id);
  a.set("kind", kind);
  a.set("source_url", msg.getString("media_url"));
  a.set("thumb_url", msg.getString("thumb_url"));
  a.set("status", "pending");
  try {
    app.save(a);
  } catch (_) {
    // unique (message, source_url, thumb_url): already linked
  }
}

const https = (s) => typeof s === "string" && s.indexOf("https://") === 0;

/** Download up to `n` newest pending attachments: thumb, and the file itself for images. */
function fetchPending(app, n) {
  const rows = app.findRecordsByFilter("attachments", 'status = "pending"', "-created", n, 0);
  let stored = 0, gone = 0, failed = 0;
  for (const a of rows) {
    const wants = [];
    if (!a.getString("thumb") && https(a.getString("thumb_url"))) wants.push(["thumb", a.getString("thumb_url")]);
    if (!a.getString("file") && a.getString("kind") === "image" && https(a.getString("source_url"))) wants.push(["file", a.getString("source_url")]);
    const errors = [];
    let got = 0, lost = 0, bad = 0;
    for (const [field, url] of wants) {
      try {
        a.set(field, $filesystem.fileFromURL(url, 60));
        got++;
      } catch (err) {
        const msg = String(err);
        errors.push(field + ": " + msg.slice(0, 200));
        if (/\b(404|410)\b/.test(msg)) lost++;
        else bad++;
      }
    }
    const status = bad ? "failed" : got ? "stored" : "gone";
    a.set("status", status);
    a.set("error", errors.join("; ").slice(0, 500));
    app.save(a);
    if (status === "stored") stored++;
    else if (status === "gone") gone++;
    else failed++;
  }
  return { checked: rows.length, stored, gone, failed };
}

/** Sender photos: one PocketBase file per alias. A dead link (404/410) is cleared, not retried. */
function fetchAvatars(app, n) {
  const rows = app.findRecordsByFilter("aliases", 'picture = "" && picture_url ~ "https://%"', "-updated", n, 0);
  let stored = 0, gone = 0;
  for (const a of rows) {
    try {
      a.set("picture", $filesystem.fileFromURL(a.getString("picture_url"), 30));
      stored++;
    } catch (err) {
      if (!/\b(404|410)\b/.test(String(err))) continue; // try again next minute
      a.set("picture_url", "");
      gone++;
    }
    app.saveNoValidate(a);
  }
  return { checked: rows.length, stored, gone };
}

module.exports = { link, fetchPending, fetchAvatars };

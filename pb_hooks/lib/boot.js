// On every start: the superuser and the S3 storage/backups from env, so a fresh data dir needs no
// dashboard setup. Passwords and keys are never logged.
//
//   RELAY_ADMIN_EMAIL + RELAY_ADMIN_PASSWORD   upsert this superuser
//   RELAY_S3_ENDPOINT + RELAY_S3_BUCKET + RELAY_S3_ACCESS_KEY + RELAY_S3_SECRET (+ RELAY_S3_REGION)
//       file storage in that bucket; backups in RELAY_BACKUP_S3_BUCKET (default "<bucket>-backups":
//       the Backups page lists every object of its bucket, so they must not share one), nightly
//       RELAY_BACKUP_CRON ("0 3 * * *"), keeping RELAY_BACKUP_KEEP (7). Unset endpoint: untouched.

function envOr(k, def) {
  const v = ($os.getenv(k) || "").trim();
  return v || def;
}

function upsertSuperuser(app) {
  const email = ($os.getenv("RELAY_ADMIN_EMAIL") || "").trim();
  const pass = $os.getenv("RELAY_ADMIN_PASSWORD") || "";
  if (!email || !pass) return;
  const col = app.findCollectionByNameOrId("_superusers");
  let r;
  try {
    r = app.findAuthRecordByEmail(col, email);
    if (r.validatePassword(pass)) return;
  } catch (_) {
    r = new Record(col);
    r.setEmail(email);
  }
  r.setPassword(pass);
  app.save(r);
  console.log(`superuser ${email} ready`);
}

function applyS3(app) {
  const endpoint = ($os.getenv("RELAY_S3_ENDPOINT") || "").trim();
  if (!endpoint) return;
  const bucket = $os.getenv("RELAY_S3_BUCKET") || "";
  const missing = ["RELAY_S3_BUCKET", "RELAY_S3_ACCESS_KEY", "RELAY_S3_SECRET"].filter((k) => !$os.getenv(k));
  if (missing.length) {
    console.log(`S3 not applied: RELAY_S3_ENDPOINT is set but ${missing.join(", ")} is not — storage left as it is`);
    return;
  }
  const s3 = {
    enabled: true,
    endpoint,
    bucket,
    region: envOr("RELAY_S3_REGION", "us-east-1"),
    accessKey: $os.getenv("RELAY_S3_ACCESS_KEY") || "",
    secret: $os.getenv("RELAY_S3_SECRET") || "",
    forcePathStyle: true,
  };
  const backupsBucket = envOr("RELAY_BACKUP_S3_BUCKET", bucket + "-backups");
  const settings = app.settings();
  settings.s3.enabled = true;
  settings.s3.endpoint = s3.endpoint;
  settings.s3.bucket = s3.bucket;
  settings.s3.region = s3.region;
  settings.s3.accessKey = s3.accessKey;
  settings.s3.secret = s3.secret;
  settings.s3.forcePathStyle = true;
  settings.backups.s3.enabled = true;
  settings.backups.s3.endpoint = s3.endpoint;
  settings.backups.s3.bucket = backupsBucket;
  settings.backups.s3.region = s3.region;
  settings.backups.s3.accessKey = s3.accessKey;
  settings.backups.s3.secret = s3.secret;
  settings.backups.s3.forcePathStyle = true;
  settings.backups.cron = envOr("RELAY_BACKUP_CRON", "0 3 * * *");
  settings.backups.cronMaxKeep = parseInt(envOr("RELAY_BACKUP_KEEP", "7"), 10) || 7;
  app.save(settings);
  console.log(`S3 ${endpoint}: files in ${bucket}, backups in ${backupsBucket} (${settings.backups.cron}, keep ${settings.backups.cronMaxKeep})`);
}

/** RELAY_PUBLIC_URL -> Settings → Application URL (the base of every webhook URL the UI shows), and
 * the app name instead of PocketBase's placeholder "Acme". */
function applyApp(app) {
  const settings = app.settings();
  let changed = false;
  const url = ($os.getenv("RELAY_PUBLIC_URL") || "").trim().replace(/\/$/, "");
  if (url && settings.meta.appURL !== url) (settings.meta.appURL = url), (changed = true);
  if (settings.meta.appName === "Acme") (settings.meta.appName = "message-relay v3"), (changed = true);
  if (changed) {
    app.save(settings);
    console.log(`app: ${settings.meta.appName} at ${settings.meta.appURL}`);
  }
}

module.exports = { upsertSuperuser, applyS3, applyApp };

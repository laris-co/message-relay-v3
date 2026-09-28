import PocketBase, { LocalAuthStore } from "pocketbase";

// The app is served by the relay itself, at / or under Home Assistant ingress
// (/api/hassio_ingress/<token>/): the API is wherever this page is.
const base = new URL(".", window.location.href).href.replace(/\/$/, "");

// Our own storage key: under Home Assistant ingress every add-on panel shares HA's origin, and other
// PocketBase panels (the SDK default key "pocketbase_auth") would overwrite this login and vice versa.
export const pb = new PocketBase(import.meta.env.DEV ? window.location.origin : base, new LocalAuthStore("message_relay_v3_auth"));
pb.autoCancellation(false);

// A token the server no longer accepts (expired, or signed by a data dir that was reset) still
// looks valid in the browser: any 401 signs out, so the login form shows instead of an empty timeline.
pb.afterSend = (response, data) => {
  if (response.status === 401 && pb.authStore.token) pb.authStore.clear();
  return data;
};

/** On load: ask the server whether the stored token is still good (the browser can't tell). */
export async function checkAuth(): Promise<void> {
  const rec = pb.authStore.record;
  if (!pb.authStore.isValid || !rec) return;
  try {
    await pb.collection(rec.collectionName).authRefresh();
  } catch {
    pb.authStore.clear();
  }
}

/** Inside Home Assistant (ingress): sign in as the relay admin with the HA session. false elsewhere. */
export async function haLogin(): Promise<boolean> {
  try {
    const r = await pb.send<{ token: string; record: Record<string, unknown> }>("/api/relay/ha-login", { method: "GET" });
    pb.authStore.save(r.token, r.record as never);
    return true;
  } catch {
    return false;
  }
}

/** The PocketBase dashboard of this relay, in a new tab — signed in already when we are a superuser:
 * PocketBase 0.40's dashboard keeps its login under "__pb_superusers__" + its own path. */
export function openDashboard() {
  const url = new URL("./_/", pb.baseURL.replace(/\/?$/, "/"));
  if (pb.authStore.isSuperuser) {
    const key = "__pb_superusers__" + url.pathname.replace(/\/$/, "");
    localStorage.setItem(key, JSON.stringify({ token: pb.authStore.token, record: pb.authStore.record }));
  }
  window.open(url.href, "_blank", "noopener");
}

export interface Facet {
  provider: string;
  channel: string;
  group_id: string;
  group_label: string;
  n: number;
  last_ts: string;
}

export async function signIn(email: string, password: string): Promise<void> {
  try {
    await pb.collection("users").authWithPassword(email, password);
  } catch {
    // a superuser can read the timeline too
    await pb.collection("_superusers").authWithPassword(email, password);
  }
}

/** The filter panel: the `timeline_groups` view collection (one row per provider / channel / group). */
export async function facets(): Promise<Facet[]> {
  return pb.collection("timeline_groups").getFullList<Facet>({ sort: "-last_ts", batch: 1000 });
}

export interface Alias { id: string; collectionId: string; collectionName: string; kind: "sender" | "group"; provider: string; value: string; label: string; picture: string; picture_url: string }

/** Every alias, keyed "<kind>\t<provider>\t<value>". */
export async function aliases(): Promise<Map<string, Alias>> {
  const rows = await pb.collection("aliases").getFullList<Alias>({ batch: 1000 });
  return new Map(rows.map((a) => [`${a.kind}\t${a.provider}\t${a.value}`, a]));
}

/** Name an id (sender or group). A hook relabels every message of that id. */
export async function saveAlias(kind: "sender" | "group", provider: string, value: string, label: string, existing?: Alias) {
  if (existing) return pb.collection("aliases").update(existing.id, { label });
  return pb.collection("aliases").create({ kind, provider, value, label });
}

# Message Relay v3

Webhooks in, live chats out. PocketBase underneath: Chats and Stream are in the sidebar
(ingress), the PocketBase dashboard at `http://<ha-host>:8789/_/`.

## Configure (before the first start)

- `admin_email`, `admin_password`: the superuser (sign in to the app and `/_/` with it).
- `line_channels`: one `{endpoint, secret}` per LINE bot. Webhook URL: `https://<public host>/w/line/<endpoint>`.
- `github_secret`: GitHub webhook secret. URL: `/w/github/<name>` (content type `application/json`).
- `generic_token`: bearer token for `/w/generic/<name>`.

Data lives in `/data/pb_data` (kept across updates, included in HA backups).

# Changelog

Each entry says whether the update changes the database. A migration runs by itself at start;
Home Assistant can take a backup before the update (the "Create backup" box).

## 0.1.14
- The app shows the running versions (UI and add-on) and this changelog's note before an update.
- Database: no change.

## 0.1.13
- Add-on updates show in the app, with Update add-on for an admin.
- Database: no change.

## 0.1.12
- A notification in Home Assistant when a new UI is out; Update now swaps it in without a restart.
- Database: no change.

## 0.1.11
- The UI loads from its own releases at start (option ui_version).
- Database: no change.

## 0.1.8
- Endpoints: type a name, Generate, one URL (the URL is the auth).
- Database: migration 1790000007 (endpoints.token).

## 0.1.7
- Chats and Stream, after v1 and v2.
- Database: migration 1790000006 (the chats view, an index on messages).

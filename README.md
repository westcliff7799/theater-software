# Show Control

A show control app for small theater productions. Each crew role opens a web page onto it from any device on the network. It can also run as a desktop app (Electron).

## What it does

- **Stage Manager** (`sm.html`): the cue list, GO and STOP.
- **Lights** (`lights.html`): fixture patch, levels, and recorded cues, sent out as sACN (DMX over the network).
- **Sound** (`sound.html`): audio playback, uploads, and an Allen & Heath SQ mixer panel.
- **Script** (`actor.html`): read along with the script, with cue markers.
- **Follow** (`follow.html`): listens to the actors and tracks where they are in the script.

## Running it

Requires Node.js.

```sh
npm install
npm start
```

Then open http://localhost:3000 in a browser.

Other commands:

```sh
npm run app       # open as a desktop app (Electron)
npm run sandbox   # demo mode on port 3001: no outputs, nothing saved
```

## Signing in

The admin account comes from a `.env` file in the project folder:

```
ADMIN_USER=yourname
ADMIN_PASSWORD=yourpassword
```

The admin can hand out keys to other people that limit what they can do (lights only, sound only, and so on). Keys are stored in `access.json`.

## Files

- `server.js`: the show server (Express + Socket.IO).
- `main.js`: the desktop app shell.
- `public/`: the web pages for each role.
- `show.json`: the saved show (cues, script, levels).
- `public/fixtures.json`: light fixture definitions.
- `discover.js`, `listen.js`, `script-import.js`: finding sound desks, speech recognition, and importing scripts from .txt/.docx/.pdf.

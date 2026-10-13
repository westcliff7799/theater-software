// main.js - the desktop app. Starts the show server, then opens windows onto it.
const { app, BrowserWindow, Menu, session } = require("electron");

const { localTicket } = require("./server.js"); // this runs your whole server inside the app

let listener = null; // hidden window: the microphone and the script follower live here, whatever page is showing

function openView(page, width = 1000, height = 700) {
  const win = new BrowserWindow({ width, height, title: "Show Control" });
  win.loadURL("http://localhost:3000/" + page);
  // the hidden listener doesn't count as an open window: when the last visible one goes, quit
  win.on("closed", () => {
    if (!BrowserWindow.getAllWindows().some((w) => w !== listener)) app.quit();
  });
  return win;
}

app.whenReady().then(async () => {
  // The app owns the server, so it signs itself in: every window shares this cookie jar.
  // httpOnly matches the cookie the server sets; Chromium refuses to overwrite an HttpOnly cookie with a plain one.
  await session.defaultSession.cookies.set({
    url: "http://localhost:3000",
    name: "sid",
    value: localTicket(),
    httpOnly: true,
  }).catch((err) => console.log("desktop sign-in cookie:", err.message));

  openView("sm.html", 1200, 800); // main view
  listener = new BrowserWindow({
    show: false,
    title: "Listener",
    webPreferences: { backgroundThrottling: false },
  }); // hidden windows get throttled otherwise
  const listen = () =>
    listener.loadURL("http://localhost:3000/follow.html?headless=1");
  listen();
  listener.webContents.on("render-process-gone", () =>
    setTimeout(listen, 1000),
  ); // if it crashes, bring it back
  listener.webContents.on("did-fail-load", () => setTimeout(listen, 2000)); // e.g. the server wasn't up yet

  // Views are switched inside the window (nav strip, Cmd+1..5).
  // "New Window" is for a second screen, e.g. lights on one and the cue list on another.
  const menu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      role: "windowMenu",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => openView("index.html"),
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
});

app.on("window-all-closed", () => app.quit());

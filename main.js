// main.js - the desktop app. Starts the show server, then opens windows onto it.
const { app, BrowserWindow, Menu } = require("electron");

require("./server.js"); // this runs your whole server inside the app

function openView(page, width = 1000, height = 700) {
  const win = new BrowserWindow({ width, height, title: "Show Control" });
  win.loadURL("http://localhost:3000/" + page);
  return win;
}

app.whenReady().then(() => {
  openView("sm.html", 1200, 800); // main view

  // Views are switched inside the window (nav strip, Cmd+1..5).
  // "New Window" is for a second screen, e.g. lights on one and the cue list on another.
  const menu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      role: "windowMenu",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => openView("index.html") },
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

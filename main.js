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

  // A "Views" menu so one machine can open any role
  const menu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "Views",
      submenu: [
        { label: "Stage Manager", click: () => openView("sm.html") },
        { label: "Lights", click: () => openView("lights.html") },
        { label: "Sound", click: () => openView("sound.html") },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
});

app.on("window-all-closed", () => app.quit());

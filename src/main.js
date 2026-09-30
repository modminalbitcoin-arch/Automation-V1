"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");

/* =========================================================
   RESOLVE PATHS — Must be done BEFORE requiring playwright
   ========================================================= */

const IS_PACKAGED = app.isPackaged;

// PORTABLE_EXECUTABLE_DIR is set by electron-builder portable target.
// It points to the folder containing Automation-V1.exe (not the extracted temp).
const APP_ROOT = IS_PACKAGED
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : path.join(__dirname, "..");

/* Configure Playwright browsers path BEFORE requiring playwright.
   Priority:
   1. Packaged: ms-playwright/ next to exe
   2. Packaged: resources/ms-playwright (if extraResources ever added)
   3. Dev: project_root/ms-playwright
   4. Otherwise: leave default (user's %LOCALAPPDATA%\ms-playwright)
*/
(function configurePlaywrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;

  const candidates = [
    IS_PACKAGED ? path.join(APP_ROOT, "ms-playwright") : null,
    IS_PACKAGED ? path.join(process.resourcesPath, "ms-playwright") : null,
    !IS_PACKAGED ? path.join(__dirname, "..", "ms-playwright") : null
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = c;
        break;
      }
    } catch (e) { /* ignore */ }
  }

  // Prevent Playwright from garbage-collecting bundled browsers
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  }
})();

/* Now safe to require playwright-dependent module */
const { runAutomation } = require("./automation-core");

/* =========================================================
   RESOLVE WRITABLE DIRECTORIES
   ========================================================= */

function isWritable(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe-" + Date.now());
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

// Prefer portable exe directory; fallback to userData if not writable.
let DATA_ROOT = APP_ROOT;
if (!isWritable(DATA_ROOT)) {
  DATA_ROOT = app.getPath("userData");
  if (!isWritable(DATA_ROOT)) {
    // Last resort: temp
    DATA_ROOT = app.getPath("temp");
  }
}

const INPUT_DIR   = path.join(DATA_ROOT, "input");
const OUTPUT_DIR  = path.join(DATA_ROOT, "output");
const PROFILE_DIR = path.join(DATA_ROOT, "browser-profile");

[INPUT_DIR, OUTPUT_DIR, PROFILE_DIR].forEach(function (d) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
});

/* =========================================================
   WINDOW
   ========================================================= */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 680,
    resizable: true,
    title: "Automation V1",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "gui.html"));
  mainWindow.on("closed", function () { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});

/* =========================================================
   IPC: START AUTOMATION
   ========================================================= */

ipcMain.handle("start-automation", async function () {
  try {
    const result = await runAutomation({
      appRoot: DATA_ROOT,
      inputDir: INPUT_DIR,
      outputDir: OUTPUT_DIR,
      profileDir: PROFILE_DIR,

      onLog: function (step, msg) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("log", {
            step: String(step),
            msg: String(msg)
          });
        }
      },

      onStatus: function (status) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("status", String(status));
        }
      },

      // Native confirm dialog for overwrite protection
      confirmOverwrite: async function (filePath) {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: "question",
          buttons: ["إلغاء", "استبدال"],
          defaultId: 1,
          cancelId: 0,
          title: "ملف موجود",
          message: path.basename(filePath) + " موجود مسبقاً.",
          detail: "هل تريد استبداله؟\n" + filePath
        });
        return response === 1;
      }
    });

    return result;
  } catch (err) {
    // Never throw across IPC — return structured error
    return {
      finalStatus: "FAILED",
      errorStep: (err && err.step) ? String(err.step) : "UNKNOWN",
      errorReason: (err && err.message) ? String(err.message) : String(err),
      metaAiWeb:     "FAIL",
      vibesOpen:     "FAIL",
      loginDetected: "FAIL",
      masterImage:   "FAIL",
      promptLoad:    "FAIL",
      promptSend:    "FAIL",
      videoDetected: "FAIL",
      videoDownload: "FAIL",
      outputFile:    "FAIL",
      outputSize:    "—"
    };
  }
});

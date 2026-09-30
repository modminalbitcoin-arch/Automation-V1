"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

/* =========================================================
   CONFIG
   ========================================================= */

const META_AI_URL    = "https://www.meta.ai/";
const VIBES_URL      = "https://www.meta.ai/ai-video-generator";

const LOGIN_WAIT_TIMEOUT   = 600_000;   // 10 min
const PAGE_LOAD_TIMEOUT    = 60_000;    // 60 s
const UPLOAD_TIMEOUT       = 120_000;   // 2 min
const VIDEO_WAIT_TIMEOUT   = 600_000;   // 10 min
const DOWNLOAD_TIMEOUT     = 120_000;   // 2 min
const MAX_PAGE_RETRIES     = 2;

/* =========================================================
   MAIN
   ========================================================= */

async function runAutomation(opts) {
  const {
    inputDir, outputDir, profileDir,
    onLog = () => {}, onStatus = () => {},
    confirmOverwrite = null
  } = opts;

  const result = {
    metaAiWeb:     "FAIL",
    vibesOpen:     "FAIL",
    loginDetected: "FAIL",
    masterImage:   "FAIL",
    promptLoad:    "FAIL",
    promptSend:    "FAIL",
    videoDetected: "FAIL",
    videoDownload: "FAIL",
    outputFile:    "FAIL",
    outputSize:    "—",
    finalStatus:   "FAIL"
  };

  const MASTER_IMAGE = path.join(inputDir, "master-image.jpg");
  const SCENE_PROMPT = path.join(inputDir, "scene-1.txt");
  const OUTPUT_FILE  = path.join(outputDir, "Scene-1.mp4");

  /* ---------- INPUT VALIDATION ---------- */
  if (!fs.existsSync(MASTER_IMAGE)) {
    return fail(result, "INPUT_VALIDATION",
      "Master Image غير موجود.\nضع الصورة هنا:\n" + MASTER_IMAGE);
  }
  if (!fs.existsSync(SCENE_PROMPT)) {
    return fail(result, "INPUT_VALIDATION",
      "Scene Prompt غير موجود.\nضع الملف هنا:\n" + SCENE_PROMPT);
  }
  let promptText;
  try { promptText = fs.readFileSync(SCENE_PROMPT, "utf-8"); }
  catch (e) { return fail(result, "INPUT_VALIDATION", "تعذر قراءة scene-1.txt: " + e.message); }
  if (!promptText.trim()) return fail(result, "INPUT_VALIDATION", "scene-1.txt فارغ.");

  /* ---------- OVERWRITE PROTECTION ---------- */
  if (fs.existsSync(OUTPUT_FILE)) {
    if (typeof confirmOverwrite === "function") {
      const ok = await confirmOverwrite(OUTPUT_FILE);
      if (!ok) { result.finalStatus = "CANCELLED"; return result; }
    } else {
      return fail(result, "OUTPUT_EXISTS", "الملف موجود مسبقاً: " + OUTPUT_FILE);
    }
  }

  /* ---------- LAUNCH BROWSER ---------- */
  onLog(1, "Launching browser (persistent profile)");
  onStatus("BROWSER: STARTING");

  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      acceptDownloads: true,
      args: ["--start-maximized"]
    });
  } catch (e) {
    return fail(result, "BROWSER_LAUNCH", "تعذر تشغيل Chromium.\n" + e.message);
  }

  const pages = browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);

  try {
    /* ========== STEP 2: Open Meta AI Web ========== */
    onLog(2, "[WEB] Opening meta.ai");
    onStatus("META AI WEB: CONNECTING");

    let opened = false;
    for (let attempt = 1; attempt <= MAX_PAGE_RETRIES && !opened; attempt++) {
      try {
        await page.goto(META_AI_URL, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
        opened = true;
      } catch (e) {
        onLog(2, `[WEB] Attempt ${attempt} failed: ${e.message}`);
        if (attempt < MAX_PAGE_RETRIES) await page.waitForTimeout(3000);
      }
    }
    if (!opened) { await browser.close().catch(() => {}); return fail(result, "META_AI_WEB", "فشل فتح meta.ai"); }

    result.metaAiWeb = "PASS";
    onLog(2, "[WEB] meta.ai loaded");
    onStatus("META AI WEB: READY");

    /* ========== STEP 3: Login detection ========== */
    onLog(3, "[LOGIN] Checking login state");
    onStatus("LOGIN: CHECKING");

    const loggedIn = await detectLogin(page, 5000);
    if (!loggedIn) {
      onLog(3, "[LOGIN] Login required — please log in manually in the browser");
      onStatus("LOGIN: WAITING FOR USER");
      const ok = await detectLogin(page, LOGIN_WAIT_TIMEOUT);
      if (!ok) {
        await browser.close().catch(() => {});
        return fail(result, "LOGIN", "لم يتم اكتشاف تسجيل الدخول خلال المهلة.");
      }
    }
    result.loginDetected = "PASS";
    onLog(3, "[LOGIN] Logged in");
    onStatus("LOGIN: OK");

    /* ========== STEP 4: Open Vibes ========== */
    onLog(4, "[VIBES] Searching for Vibes");
    onStatus("VIBES: OPENING");

    const vibesOpened = await openVibes(page, onLog);
    if (!vibesOpened) {
      await browser.close().catch(() => {});
      return fail(result, "VIBES_OPEN", "لم يتم العثور على قسم Vibes.");
    }
    result.vibesOpen = "PASS";
    onLog(4, "[VIBES] Found");
    onStatus("VIBES: READY");

    /* ========== Count existing videos BEFORE generate ========== */
    const initialVideoCount = (await page.$$("video")).length;
    onLog(4, `[VIBES] Existing videos on page: ${initialVideoCount}`);

    /* ========== STEP 5: Upload Master Image ========== */
    onLog(5, "[UPLOAD] Searching image input");
    onStatus("MASTER IMAGE: UPLOADING");

    try {
      await uploadMasterImage(page, MASTER_IMAGE, onLog);
    } catch (e) {
      await browser.close().catch(() => {});
      return fail(result, "MASTER_IMAGE_UPLOAD", "فشل رفع الصورة.\n" + e.message);
    }
    result.masterImage = "PASS";
    onLog(5, "[UPLOAD] Master image selected");
    onStatus("MASTER IMAGE: UPLOADED");

    /* ========== STEP 6: Load & Send Prompt ========== */
    onLog(6, "[PROMPT] Scene 1 loaded");
    onStatus("PROMPT: LOADED");

    try {
      await sendPrompt(page, promptText, onLog);
    } catch (e) {
      await browser.close().catch(() => {});
      return fail(result, "PROMPT_SEND", "فشل إرسال الـPrompt.\n" + e.message);
    }
    result.promptLoad = "PASS";
    result.promptSend = "PASS";
    onLog(6, "[PROMPT] Sent");
    onStatus("PROMPT: SENT");

    /* ========== STEP 7: Wait for NEW video ========== */
    onLog(7, `[GENERATION] Waiting (timeout: ${VIDEO_WAIT_TIMEOUT / 1000}s)`);
    onStatus("VIDEO GENERATION: WAITING");

    const newVideo = await waitForNewVideo(page, initialVideoCount, VIDEO_WAIT_TIMEOUT, onLog);
    if (!newVideo) {
      await browser.close().catch(() => {});
      return fail(result, "VIDEO_WAIT", "لم يظهر فيديو جديد خلال المهلة.");
    }
    result.videoDetected = "PASS";
    onLog(7, "[VIDEO] Generated video detected");
    onStatus("VIDEO: DETECTED");

    /* ========== STEP 8: Download ========== */
    onLog(8, "[DOWNLOAD] Searching for download button");
    onStatus("VIDEO: DOWNLOADING");

    let downloaded = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && !downloaded; attempt++) {
      try { downloaded = await downloadVideo(page, newVideo, OUTPUT_FILE, onLog); }
      catch (e) { lastErr = e; }
      if (!downloaded && attempt < 2) await page.waitForTimeout(3000);
    }
    if (!downloaded) {
      await browser.close().catch(() => {});
      return fail(result, "DOWNLOAD", "فشل تحميل الفيديو." + (lastErr ? "\n" + lastErr.message : ""));
    }
    result.videoDownload = "PASS";
    onLog(8, "[DOWNLOAD] Complete");
    onStatus("DOWNLOAD: COMPLETE");

    /* ========== STEP 9: Verify ========== */
    onLog(9, "[VERIFY] Checking file");
    onStatus("OUTPUT: VERIFYING");

    if (!fs.existsSync(OUTPUT_FILE)) {
      await browser.close().catch(() => {});
      return fail(result, "VERIFY", "الملف غير موجود بعد التحميل.");
    }
    const stats = fs.statSync(OUTPUT_FILE);
    if (stats.size <= 0) {
      await browser.close().catch(() => {});
      return fail(result, "VERIFY", "حجم الملف صفر.");
    }
    result.outputFile = "PASS";
    result.outputSize = `${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`;

    try {
      const dur = await readVideoDuration(browser, OUTPUT_FILE);
      result.videoDuration = (dur !== null) ? `${dur.toFixed(3)} s` : "Unable to read";
    } catch { result.videoDuration = "Unable to read"; }

    result.finalStatus = "PASS";
    onLog(10, "[VERIFY] File exists");
    onLog(10, "[VERIFY] Size > 0");
    onLog(10, `OUTPUT: ${OUTPUT_FILE}`);
    onLog(10, "FINAL STATUS: PASS");
    onStatus("SUCCESS");

  } catch (err) {
    onStatus("FAILED");
    result.finalStatus = "FAILED";
    result.errorStep = err.step || "RUNTIME";
    result.errorReason = err.message || String(err);
  } finally {
    try { await browser.close(); } catch {}
  }

  return result;
}

/* =========================================================
   HELPERS
   ========================================================= */

function fail(result, step, reason) {
  result.finalStatus = "FAILED";
  result.errorStep = step;
  result.errorReason = reason;
  return result;
}

/* ---------- Login detection (multiple strategies) ---------- */
async function detectLogin(page, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // If a composer / chat input is visible → likely logged in.
    const composerCandidates = [
      'textarea[placeholder]',
      'div[contenteditable="true"][role="textbox"]',
      '[aria-label*="Message" i]',
      '[aria-label*="Ask" i]',
      'button[aria-label*="Create" i]'
    ];
    for (const sel of composerCandidates) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) return true;
    }
    // If a login prompt is visible → not logged in.
    const loginCandidates = [
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'a:has-text("Log in")',
      '[href*="login"]'
    ];
    for (const sel of loginCandidates) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        await page.waitForTimeout(2000);
        break;
      }
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/* ---------- Open Vibes section ---------- */
async function openVibes(page, onLog) {
  // Strategy 1: Direct navigation
  try {
    await page.goto(VIBES_URL, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
    if (await isVibesReady(page)) return true;
  } catch (e) {
    onLog(4, `[VIBES] Direct URL failed: ${e.message}`);
  }

  // Strategy 2: Look for a "Vibes" link/button/menu item in the UI
  const vibesSelectors = [
    'a[href*="vibes"]',
    'a[href*="ai-video"]',
    'button:has-text("Vibes")',
    'a:has-text("Vibes")',
    '[role="tab"]:has-text("Vibes")',
    '[role="menuitem"]:has-text("Vibes")',
    '[aria-label*="Vibes" i]'
  ];
  for (const sel of vibesSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(3000);
        if (await isVibesReady(page)) return true;
      }
    } catch {}
  }

  // Strategy 3: Search for any element containing "Vibes" text
  try {
    const anyVibes = await page.locator('text="Vibes"').first();
    if (await anyVibes.isVisible().catch(() => false)) {
      await anyVibes.click();
      await page.waitForTimeout(3000);
      if (await isVibesReady(page)) return true;
    }
  } catch {}

  return false;
}

async function isVibesReady(page) {
  // A page is "Vibes-ready" if it contains any of:
  // - A "Create" / "Generate" button
  // - An upload input
  // - A video feed
  const readyMarkers = [
    'button:has-text("Create")',
    'button:has-text("Generate")',
    'button:has-text("Animate")',
    'input[type="file"]',
    'video'
  ];
  for (const sel of readyMarkers) {
    const el = await page.$(sel);
    if (el) return true;
  }
  return false;
}

/* ---------- Upload Master Image ---------- */
async function uploadMasterImage(page, imagePath, onLog) {
  // Strategy A: Direct hidden <input type="file">
  let fileInput = await page.$('input[type="file"]');

  // Strategy B: Open attach/upload menu first, then look for file input
  if (!fileInput) {
    const attachCandidates = [
      'button:has-text("Upload")',
      'button:has-text("Add image")',
      'button:has-text("Image")',
      '[aria-label*="Upload" i]',
      '[aria-label*="Add" i]',
      '[aria-label*="Attach" i]',
      'button:has([data-icon="plus"])',
      '[data-icon="plus"]'
    ];
    for (const sel of attachCandidates) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1500);
        fileInput = await page.$('input[type="file"]');
        if (fileInput) break;
      }
    }
  }

  if (!fileInput) {
    throw new Error("لم يتم العثور على input[type=file]. قد تحتاج لتحديث المحددات بعد تغيير واجهة Meta AI.");
  }

  await fileInput.setInputFiles(imagePath);
  // Wait for image preview / thumbnail to appear
  await page.waitForTimeout(3000);
  onLog(5, "[UPLOAD] File set via input[type=file]");
}

/* ---------- Send Prompt ---------- */
async function sendPrompt(page, promptText, onLog) {
  // Find a text input (composer / prompt box)
  const promptSelectors = [
    'textarea[placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea'
  ];
  let input = null;
  for (const sel of promptSelectors) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) { input = el; break; }
  }
  if (!input) throw new Error("لم يتم العثور على حقل إدخال الـPrompt.");

  await input.click();
  await page.waitForTimeout(300);

  // Type EXACT text — no modification
  await page.keyboard.type(promptText, { delay: 30 });
  await page.waitForTimeout(800);

  // Try clicking a "Send" / "Generate" / "Animate" button
  const sendCandidates = [
    'button:has-text("Send")',
    'button:has-text("Generate")',
    'button:has-text("Animate")',
    'button:has-text("Create")',
    '[aria-label*="Send" i]',
    '[aria-label*="Generate" i]',
    'button[type="submit"]'
  ];
  let sent = false;
  for (const sel of sendCandidates) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.click();
      sent = true;
      onLog(6, `[PROMPT] Clicked "${sel}"`);
      break;
    }
  }
  if (!sent) {
    // Fallback: press Enter
    await page.keyboard.press("Enter");
    onLog(6, "[PROMPT] Pressed Enter (fallback)");
  }
  await page.waitForTimeout(2000);
}

/* ---------- Wait for a NEW video ---------- */
async function waitForNewVideo(page, initialCount, timeout, onLog) {
  const start = Date.now();
  let lastReported = -1;
  while (Date.now() - start < timeout) {
    try {
      const videos = await page.$$("video");
      if (videos.length > initialCount) {
        // New video(s) appeared — verify the newest is visible & ready
        for (let i = initialCount; i < videos.length; i++) {
          const v = videos[i];
          const visible = await v.isVisible().catch(() => false);
          if (!visible) continue;
          const readyState = await v.evaluate(el => el.readyState).catch(() => 0);
          if (readyState >= 2) return v;
        }
      }
      if (videos.length !== lastReported) {
        lastReported = videos.length;
        onLog(7, `[VIDEO] Count: ${videos.length} (waiting for > ${initialCount})`);
      }
    } catch {}
    await page.waitForTimeout(3000);
  }
  return null;
}

/* ---------- Download ---------- */
async function downloadVideo(page, videoHandle, outputPath, onLog) {
  // Strategy 1: Click the video to open its detail view, then find Download
  try {
    await videoHandle.click();
    await page.waitForTimeout(2500);
  } catch {}

  const downloadSelectors = [
    'button:has-text("Download")',
    'a:has-text("Download")',
    '[aria-label*="Download" i]',
    '[title*="Download" i]',
    '[data-icon="download"]',
    'a[download]'
  ];

  let dlBtn = null;
  for (const sel of downloadSelectors) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) { dlBtn = el; break; }
  }

  if (dlBtn) {
    onLog(8, "[DOWNLOAD] Download button detected");
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT }),
        dlBtn.click()
      ]);
      if (download) {
        await download.saveAs(outputPath);
        onLog(8, "[DOWNLOAD] Saved via download event");
        return true;
      }
    } catch (e) {
      onLog(8, `[DOWNLOAD] download event failed: ${e.message}`);
    }
  } else {
    onLog(8, "[DOWNLOAD] No download button found in detail view");
  }

  // Strategy 2: <a download> link already in DOM
  const anchorDownload = await page.$('a[download]');
  if (anchorDownload) {
    onLog(8, "[DOWNLOAD] Found <a download> link");
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT }),
        anchorDownload.click()
      ]);
      if (download) {
        await download.saveAs(outputPath);
        onLog(8, "[DOWNLOAD] Saved via <a download>");
        return true;
      }
    } catch (e) {
      onLog(8, `[DOWNLOAD] <a download> failed: ${e.message}`);
    }
  }

  return false;
}

/* ---------- Read video duration (best-effort, no FFmpeg) ---------- */
async function readVideoDuration(browser, filePath) {
  try {
    const tempPage = await browser.newPage();
    const fileUrl = "file://" + filePath.replace(/\\/g, "/");
    await tempPage.goto(fileUrl);
    const duration = await tempPage.evaluate(() =>
      new Promise((resolve) => {
        const v = document.querySelector("video");
        if (!v) return resolve(null);
        if (v.readyState >= 1 && isFinite(v.duration)) return resolve(v.duration);
        v.onloadedmetadata = () => resolve(isFinite(v.duration) ? v.duration : null);
        setTimeout(() => resolve(null), 8000);
      })
    );
    await tempPage.close();
    return (typeof duration === "number" && isFinite(duration)) ? duration : null;
  } catch { return null; }
}

module.exports = { runAutomation };

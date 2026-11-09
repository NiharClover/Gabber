const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

const RELEASE_DIR = path.resolve(
  process.env.APP_RELEASE_DIR || path.join(__dirname, "../../releases")
);
const MANIFEST_PATH = path.resolve(
  process.env.APP_UPDATE_MANIFEST_PATH || path.join(RELEASE_DIR, "android-update.json")
);
const APK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.apk$/;

function publicBaseUrl(req) {
  const configured = String(process.env.APP_UPDATE_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

async function readAndroidManifest() {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const versionCode = Number(parsed.versionCode);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error("Android update manifest has an invalid versionCode.");
  }
  if (!APK_NAME_PATTERN.test(parsed.filename || "")) {
    throw new Error("Android update manifest has an invalid APK filename.");
  }
  if (!/^[a-f0-9]{64}$/i.test(parsed.sha256 || "")) {
    throw new Error("Android update manifest has an invalid SHA-256 digest.");
  }

  return {
    platform: "android",
    versionCode,
    versionName: String(parsed.versionName || versionCode).slice(0, 40),
    filename: parsed.filename,
    sha256: parsed.sha256.toLowerCase(),
    bytes: Number.isSafeInteger(Number(parsed.bytes)) ? Number(parsed.bytes) : null,
    releaseNotes: String(parsed.releaseNotes || "Bug fixes and improvements.").slice(0, 1000),
    mandatory: parsed.mandatory === true,
    publishedAt: parsed.publishedAt || null,
  };
}

router.get("/android", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const manifest = await readAndroidManifest();
    if (!manifest) return res.json({ platform: "android", enabled: false });
    return res.json({
      ...manifest,
      enabled: true,
      apkUrl: `${publicBaseUrl(req)}/api/app-update/download/${encodeURIComponent(manifest.filename)}`,
    });
  } catch (err) {
    console.error("[app-update] Could not read manifest:", err.message);
    return res.status(503).json({ error: "App update information is unavailable." });
  }
});

router.get("/download/:filename", async (req, res) => {
  const { filename } = req.params;
  if (!APK_NAME_PATTERN.test(filename || "")) return res.status(404).end();

  const absolutePath = path.join(RELEASE_DIR, filename);
  try {
    await fs.access(absolutePath);
  } catch {
    return res.status(404).json({ error: "APK not found." });
  }

  res.set({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  return res.sendFile(absolutePath);
});

module.exports = router;


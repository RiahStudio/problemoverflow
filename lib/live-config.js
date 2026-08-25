"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SESSION_MAX = 2592000;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function mode() {
  const raw = String(process.env.PO_MODE || "").toLowerCase();
  if (raw === "public") return "public";
  if (raw === "local") return "local";
  return process.env.NODE_ENV === "production" ? "public" : "local";
}

function isPublicMode() {
  return mode() === "public";
}

function bindHost() {
  return isPublicMode() ? "0.0.0.0" : "127.0.0.1";
}

function listenPort() {
  return Number(process.env.PORT || process.env.PO_PORT || 8146);
}

function publicOrigin() {
  return String(process.env.PO_PUBLIC_ORIGIN || "").replace(/\/$/, "");
}

function publicRoomUrl() {
  const origin = publicOrigin();
  return origin ? `${origin}/#/public` : "";
}

function dataDir(root) {
  if (process.env.PO_DATA_DIR) return path.resolve(process.env.PO_DATA_DIR);
  return path.join(root, "data");
}

function cookieSecure() {
  return isPublicMode();
}

function sessionCookie(sessionId, clear) {
  const secure = cookieSecure() ? "; Secure" : "";
  if (clear) {
    return `po_session=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`;
  }
  return `po_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${SESSION_MAX}`;
}

function hostAllowed(hostHeader) {
  if (isPublicMode()) return true;
  return LOOPBACK.test(String(hostHeader || ""));
}

function originAllowed(method, originHeader) {
  if (!isPublicMode()) return true;
  const verb = String(method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  return String(originHeader || "") === publicOrigin();
}

function siteOrigin(localHost, localPort) {
  if (isPublicMode()) return publicOrigin();
  return `http://${localHost}:${localPort}`;
}

function googleSuccessLocation(origin) {
  return `${String(origin || "").replace(/\/$/, "")}/#/public`;
}

function googleFailLocation(origin) {
  return `${String(origin || "").replace(/\/$/, "")}/?google=fail`;
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (process.platform === "win32") {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // dest may not exist yet
      }
      fs.renameSync(tmp, file);
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp already gone
    }
    throw err;
  }
}

module.exports = {
  SESSION_MAX,
  LOOPBACK,
  mode,
  isPublicMode,
  bindHost,
  listenPort,
  publicOrigin,
  publicRoomUrl,
  dataDir,
  cookieSecure,
  sessionCookie,
  hostAllowed,
  originAllowed,
  siteOrigin,
  googleSuccessLocation,
  googleFailLocation,
  atomicWriteJson,
};

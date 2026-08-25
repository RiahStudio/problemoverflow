#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const boardLib = require("../lib/board");
const authLib = require("../lib/auth");
const buzzInbox = require("../lib/buzz-inbox");
const live = require("../lib/live-config");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const GOOGLE_OAUTH = path.join(ROOT, "lib", "google-oauth.mjs");
const TOKEN = crypto.randomBytes(24).toString("hex");
const googlePending = new Map();

function loadEnvFile() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

loadEnvFile();

const HOST = live.bindHost();
const PORT = live.listenPort();
const DATA_DIR = live.dataDir(ROOT);
const DATA = path.join(DATA_DIR, "board.json");
const ACCOUNTS = path.join(DATA_DIR, "accounts.json");
const ORIGIN = live.siteOrigin("127.0.0.1", PORT);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function send(res, code, body, type = "text/plain; charset=utf-8", extra) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...(extra || {}) });
  res.end(body);
}

function json(res, obj, code = 200, extra) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8", extra);
}

function cookieSession(req) {
  const cookie = String(req.headers.cookie || "");
  const match = cookie.match(/(?:^|;\s*)po_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function sessionId(req) {
  return String(req.headers["x-po-session"] || "") || cookieSession(req);
}

function loadBoard() {
  if (!fs.existsSync(DATA)) {
    const fresh = boardLib.emptyBoard();
    live.atomicWriteJson(DATA, fresh);
    return fresh;
  }
  return boardLib.normalizeBoard(JSON.parse(fs.readFileSync(DATA, "utf8")));
}

function saveBoard(board) {
  live.atomicWriteJson(DATA, board);
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS)) {
    const fresh = authLib.emptyAccounts();
    live.atomicWriteJson(ACCOUNTS, fresh);
    return fresh;
  }
  return authLib.normalizeAccounts(JSON.parse(fs.readFileSync(ACCOUNTS, "utf8")));
}

function saveAccounts(accounts) {
  live.atomicWriteJson(ACCOUNTS, accounts);
}

function currentUser(req) {
  return authLib.userFromSession(loadAccounts(), sessionId(req), Date.now());
}

function currentRecord(req) {
  return authLib.userRecordFromSession(loadAccounts(), sessionId(req), Date.now());
}

function authorized(req) {
  const sent = String(req.headers["x-po-token"] || "");
  return sent && sent === TOKEN;
}

function needDesk(req, res) {
  if (live.isPublicMode()) return true;
  if (!authorized(req)) {
    json(res, { ok: false, error: "Refresh and try again." }, 401);
    return false;
  }
  return true;
}

function needUser(req, res) {
  if (!needDesk(req, res)) return null;
  const user = currentUser(req);
  if (!user) {
    json(res, { ok: false, error: "Sign in first." }, 401);
    return null;
  }
  return user;
}

function needRecord(req, res) {
  if (!needDesk(req, res)) return null;
  const accounts = loadAccounts();
  const user = authLib.userRecordFromSession(accounts, sessionId(req), Date.now());
  if (!user) {
    json(res, { ok: false, error: "Sign in first." }, 401);
    return null;
  }
  return { accounts, user };
}

function asAuthor(body, user) {
  return {
    ...body,
    authorName: user.name,
    authorRole: user.role,
    authorId: user.id,
    userId: user.id,
    voterId: user.id,
    voterName: user.name,
    role: user.role,
  };
}

function authPayload(result) {
  if (!result.ok) return result;
  return { ok: true, user: result.user, sessionId: result.sessionId };
}

function authHeaders(result) {
  if (!result.ok || !result.sessionId) return undefined;
  return { "Set-Cookie": live.sessionCookie(result.sessionId) };
}

function googleRedirectUri() {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URL) return process.env.GOOGLE_OAUTH_REDIRECT_URL;
  return `${ORIGIN}/api/google/callback`;
}

function googleReady() {
  return Boolean(
    String(process.env.GOOGLE_CLIENT_ID || "").trim()
    && String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  );
}

async function googleLib() {
  return import(pathToFileURL(GOOGLE_OAUTH).href);
}

function pruneGooglePending(now) {
  for (const [state, row] of googlePending) {
    if (now - row.createdAt > 10 * 60 * 1000) googlePending.delete(state);
  }
}

function readBody(req, limit = 80 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        req.destroy();
        reject(new Error("too big"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, buf, type);
  });
}

function rememberRoom(req, channelId, joinKey) {
  const accounts = loadAccounts();
  const user = authLib.userRecordFromSession(accounts, sessionId(req), Date.now());
  if (!user || !channelId) return;
  authLib.rememberJoinedRoom(user, channelId, joinKey);
  saveAccounts(accounts);
}

function healthReady() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
  loadBoard();
  loadAccounts();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    try {
      healthReady();
      json(res, { ok: true });
    } catch {
      json(res, { ok: false }, 503);
    }
    return;
  }

  if (!live.hostAllowed(req.headers.host)) {
    send(res, 403, "This desk is local only.");
    return;
  }

  if (!live.originAllowed(req.method, req.headers.origin)) {
    json(res, { ok: false, error: "That request did not come from this board." }, 403);
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/boot") {
      const rec = currentRecord(req);
      json(res, {
        ok: true,
        mode: live.mode(),
        token: live.isPublicMode() ? "" : TOKEN,
        port: PORT,
        channels: boardLib.publicChannelList(loadBoard(), rec && rec.id),
        user: rec ? authLib.publicUser(rec) : null,
        google: googleReady(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      if (!needDesk(req, res)) return;
      const user = currentUser(req);
      if (!user) {
        json(res, { ok: false, error: "Sign in first." }, 401);
        return;
      }
      json(res, { ok: true, user });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      if (!needDesk(req, res)) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const accounts = loadAccounts();
      const result = authLib.register(accounts, body, Date.now());
      if (result.ok) saveAccounts(accounts);
      json(res, authPayload(result), result.ok ? 200 : 400, authHeaders(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!needDesk(req, res)) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const accounts = loadAccounts();
      const result = authLib.login(accounts, body, Date.now());
      if (result.ok) saveAccounts(accounts);
      json(res, authPayload(result), result.ok ? 200 : 400, authHeaders(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (!needDesk(req, res)) return;
      const accounts = loadAccounts();
      authLib.logout(accounts, sessionId(req), Date.now());
      saveAccounts(accounts);
      json(res, { ok: true }, 200, { "Set-Cookie": live.sessionCookie("", true) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/start") {
      if (!needDesk(req, res)) return;
      if (!googleReady()) {
        json(res, { ok: false, error: "Google sign-in is not set up yet." }, 400);
        return;
      }
      const now = Date.now();
      pruneGooglePending(now);
      const oauth = await googleLib();
      const state = oauth.createState();
      const pkce = oauth.createPkce();
      googlePending.set(state, { verifier: pkce.verifier, createdAt: now });
      const googleUrl = oauth.createAuthUrl({
        clientId: process.env.GOOGLE_CLIENT_ID,
        redirectUri: googleRedirectUri(),
        state,
        codeChallenge: pkce.challenge,
      });
      json(res, { ok: true, url: googleUrl });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/google/callback") {
      const fail = live.googleFailLocation(ORIGIN);
      if (!googleReady()) {
        res.writeHead(302, { Location: fail, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const state = String(url.searchParams.get("state") || "");
      const code = String(url.searchParams.get("code") || "");
      const pending = googlePending.get(state);
      googlePending.delete(state);
      if (!pending || !code) {
        res.writeHead(302, { Location: fail, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      try {
        const oauth = await googleLib();
        const identity = await oauth.completeLogin({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          code,
          redirectUri: googleRedirectUri(),
          codeVerifier: pending.verifier,
        });
        const accounts = loadAccounts();
        const result = authLib.loginFromGoogle(accounts, identity, Date.now());
        if (!result.ok) {
          res.writeHead(302, { Location: fail, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        saveAccounts(accounts);
        res.writeHead(302, {
          Location: live.googleSuccessLocation(ORIGIN),
          "Cache-Control": "no-store",
          "Set-Cookie": live.sessionCookie(result.sessionId),
        });
        res.end();
      } catch {
        res.writeHead(302, { Location: fail, "Cache-Control": "no-store" });
        res.end();
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/board") {
      const rec = currentRecord(req);
      const channelId = url.searchParams.get("channel") || "public";
      const joinKey = url.searchParams.get("k") || "";
      const snap = boardLib.snapshot(
        loadBoard(),
        channelId,
        joinKey,
        Date.now(),
        rec ? { role: rec.role, userId: rec.id } : (url.searchParams.get("role") || "human"),
      );
      if (snap.ok && rec) rememberRoom(req, channelId, joinKey);
      json(res, snap, snap.ok ? 200 : 403);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meet") {
      const packed = needRecord(req, res);
      if (!packed) return;
      const matches = boardLib.meetMatches(loadBoard(), packed.accounts.users, packed.user);
      json(res, { ok: true, user: authLib.publicUser(packed.user), matches });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/meet-settings") {
      const packed = needRecord(req, res);
      if (!packed) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const result = authLib.setMeetSettings(packed.user, body);
      if (result.ok) saveAccounts(packed.accounts);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/working-on") {
      const packed = needRecord(req, res);
      if (!packed) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), packed.user);
      const board = loadBoard();
      const result = boardLib.setWorkingOn(board, packed.user, body);
      if (result.ok) {
        saveBoard(board);
        saveAccounts(packed.accounts);
      }
      json(res, { ...result, user: authLib.publicUser(packed.user) }, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/meet-contact") {
      const packed = needRecord(req, res);
      if (!packed) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const other = packed.accounts.users.find((u) => u.id === String(body.userId || ""));
      const board = loadBoard();
      const result = boardLib.contactMeet(board, packed.user, other, Date.now());
      if (result.ok) {
        saveBoard(board);
        if (result.channelId) {
          authLib.rememberJoinedRoom(packed.user, result.channelId, result.joinKey);
          if (other) authLib.rememberJoinedRoom(other, result.channelId, result.joinKey);
          saveAccounts(packed.accounts);
        }
      }
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/buzz-link") {
      const packed = needRecord(req, res);
      if (!packed) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), packed.user);
      const board = loadBoard();
      const result = boardLib.setBuzzLink(board, body);
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cards") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addCard(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reply") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addReply(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/here") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.touchPerson(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addQuestion(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/answer") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req, 200 * 1024)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addAnswer(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent-context") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req, 200 * 1024)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addAgentContext(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/human-context") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req, 32 * 1024)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addHumanContext(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/buzz-copy") {
      if (!needDesk(req, res)) return;
      const rec = currentRecord(req);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (rec) {
        body.userId = rec.id;
        body.voterId = rec.id;
      }
      body.publicOrigin = live.publicRoomUrl();
      if (live.isPublicMode()) body.origin = live.publicOrigin();
      const result = boardLib.copyBuzz(loadBoard(), body);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/buzz-tally") {
      const user = needUser(req, res);
      if (!user) return;
      const body = JSON.parse((await readBody(req, 200 * 1024)) || "{}");
      const board = loadBoard();
      const result = boardLib.applyBuzzTally(board, body, Date.now());
      if (result.ok) {
        board.hallway = board.hallway || {};
        board.hallway.lastTick = Date.now();
        saveBoard(board);
      }
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/vote") {
      const user = needUser(req, res);
      if (!user) return;
      const body = asAuthor(JSON.parse((await readBody(req)) || "{}"), user);
      const board = loadBoard();
      const result = boardLib.addVote(board, body, Date.now());
      if (result.ok) saveBoard(board);
      json(res, result, result.ok ? 200 : 400);
      return;
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const abs = path.join(SITE, file);
    if (!abs.startsWith(SITE)) {
      send(res, 403, "no");
      return;
    }
    serveFile(res, abs);
  } catch (err) {
    json(res, { ok: false, error: "That did not work." }, 500);
  }
});

server.listen(PORT, HOST, () => {
  if (live.isPublicMode()) {
    process.stdout.write(`Problem Overflow public board is up on port ${PORT}\n`);
  } else {
    process.stdout.write(`Problem Overflow local desk: http://127.0.0.1:${PORT}/\n`);
  }
  if (!live.isPublicMode() && !process.env.PO_DATA_DIR) {
    buzzInbox.startHourly(ROOT, loadBoard, saveBoard);
  }
});

"use strict";

const crypto = require("node:crypto");
const boardLib = require("./board");

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_MAX = 40;
const PASS_MIN = 8;
const PASS_MAX = 200;

function emptyAccounts() {
  return { users: [], sessions: [] };
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") return user;
  if (!Array.isArray(user.workingOn)) user.workingOn = [];
  if (!Array.isArray(user.joinedRooms)) user.joinedRooms = [];
  if (typeof user.shouldMeetOn !== "boolean") user.shouldMeetOn = Boolean(user.shouldMeetOn);
  if (typeof user.includePrivate !== "boolean") user.includePrivate = Boolean(user.includePrivate);
  if (typeof user.email !== "string") user.email = user.email || "";
  if (typeof user.googleSub !== "string") user.googleSub = user.googleSub || "";
  return user;
}

function normalizeAccounts(raw) {
  const next = raw && typeof raw === "object" ? raw : {};
  const accounts = {
    users: Array.isArray(next.users) ? next.users.map(normalizeUser) : [],
    sessions: Array.isArray(next.sessions) ? next.sessions : [],
  };
  return accounts;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    shouldMeetOn: Boolean(user.shouldMeetOn),
    includePrivate: Boolean(user.includePrivate),
    workingOn: Array.isArray(user.workingOn)
      ? user.workingOn.map((w) => ({ cardId: w.cardId, channelId: w.channelId }))
      : [],
  };
}

function findUser(accounts, name) {
  const key = String(name || "").trim().toLowerCase();
  return accounts.users.find((u) => String(u.name || "").toLowerCase() === key) || null;
}

function findUserByEmail(accounts, email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  return accounts.users.find((u) => String(u.email || "").toLowerCase() === key) || null;
}

function findUserByGoogleSub(accounts, sub) {
  const key = String(sub || "").trim();
  if (!key) return null;
  return accounts.users.find((u) => u.googleSub === key) || null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString("hex");
}

function pruneSessions(accounts, now) {
  accounts.sessions = accounts.sessions.filter((s) => s.expiresAt > now);
}

function userRecordFromSession(accounts, sessionId, now) {
  pruneSessions(accounts, now);
  const row = accounts.sessions.find((s) => s.id === sessionId);
  if (!row) return null;
  return accounts.users.find((u) => u.id === row.userId) || null;
}

function userFromSession(accounts, sessionId, now) {
  return publicUser(userRecordFromSession(accounts, sessionId, now));
}

function makeSession(accounts, user, now) {
  pruneSessions(accounts, now);
  const session = {
    id: crypto.randomBytes(24).toString("hex"),
    userId: user.id,
    createdAt: now,
    expiresAt: now + SESSION_MS,
  };
  accounts.sessions.push(session);
  return session;
}

function newUserId() {
  return `u-${crypto.randomBytes(8).toString("hex")}`;
}

function uniqueName(accounts, base) {
  const cleaned = String(base || "").trim().slice(0, NAME_MAX) || "Member";
  if (!findUser(accounts, cleaned)) return cleaned;
  for (let i = 2; i < 99; i += 1) {
    const next = `${cleaned.slice(0, NAME_MAX - 3)} ${i}`.trim();
    if (!findUser(accounts, next)) return next;
  }
  return `${cleaned.slice(0, 20)} ${crypto.randomBytes(2).toString("hex")}`;
}

function blankMeetFields() {
  return {
    shouldMeetOn: false,
    includePrivate: false,
    workingOn: [],
    joinedRooms: [],
  };
}

function register(accounts, input, now) {
  const name = String(input.name || "").trim();
  const password = String(input.password || "");
  const role = input.role === "agent" ? "agent" : "human";
  if (name.length < 2 || name.length > NAME_MAX) {
    return { ok: false, error: "Pick a name people can call you." };
  }
  if (boardLib.leakHits(name)) {
    return { ok: false, error: "That name looks like private stuff." };
  }
  if (password.length < PASS_MIN || password.length > PASS_MAX) {
    return { ok: false, error: "Password needs at least eight characters." };
  }
  if (findUser(accounts, name)) {
    return { ok: false, error: "That name is already taken." };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: newUserId(),
    name,
    role,
    salt,
    hash: hashPassword(password, salt),
    email: "",
    googleSub: "",
    createdAt: now,
    ...blankMeetFields(),
  };
  accounts.users.push(user);
  const session = makeSession(accounts, user, now);
  return { ok: true, user: publicUser(user), sessionId: session.id };
}

function login(accounts, input, now) {
  const password = String(input.password || "");
  const user = findUser(accounts, input.name);
  if (!user || !user.hash || password.length < 1) {
    return { ok: false, error: "Name or password did not match." };
  }
  const next = hashPassword(password, user.salt);
  const a = Buffer.from(user.hash, "hex");
  const b = Buffer.from(next, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "Name or password did not match." };
  }
  const session = makeSession(accounts, user, now);
  return { ok: true, user: publicUser(user), sessionId: session.id };
}

function logout(accounts, sessionId, now) {
  pruneSessions(accounts, now);
  accounts.sessions = accounts.sessions.filter((s) => s.id !== sessionId);
  return { ok: true };
}

function googleRefusal() {
  return "We could not sign you in with Google. Try a name and password, or try Google again.";
}

// Verified Google email only; never trust a client-sent profile.
function decideGoogleLink(identity, existing) {
  if (!identity || !identity.email || !identity.googleSub) {
    return { action: "refuse" };
  }
  if (identity.emailVerified !== true) {
    return { action: "refuse" };
  }
  const email = String(identity.email).trim().toLowerCase();
  if (!existing) {
    return { action: "create", setGoogleSub: identity.googleSub };
  }
  if (existing.disabled) return { action: "refuse" };
  if (String(existing.email || "").trim().toLowerCase() !== email) {
    return { action: "refuse" };
  }
  if (existing.googleSub) {
    if (existing.googleSub !== identity.googleSub) return { action: "refuse" };
    return { action: "login" };
  }
  return { action: "link", setGoogleSub: identity.googleSub };
}

function displayNameFromGoogle(identity) {
  const name = String(identity && identity.name || "").trim();
  if (!name || boardLib.leakHits(name) || name.includes("@")) return "Member";
  return name.slice(0, NAME_MAX);
}

function loginFromGoogle(accounts, identity, now) {
  const existing = findUserByGoogleSub(accounts, identity && identity.googleSub)
    || findUserByEmail(accounts, identity && identity.email);
  const decision = decideGoogleLink(identity, existing ? {
    id: existing.id,
    email: existing.email || "",
    googleSub: existing.googleSub || "",
    disabled: Boolean(existing.disabled),
  } : null);
  if (decision.action === "refuse") {
    return { ok: false, error: googleRefusal() };
  }
  let user = existing;
  if (decision.action === "create") {
    user = {
      id: newUserId(),
      name: uniqueName(accounts, displayNameFromGoogle(identity)),
      role: "human",
      salt: "",
      hash: "",
      email: String(identity.email).trim().toLowerCase(),
      googleSub: identity.googleSub,
      emailVerified: true,
      provider: "google",
      createdAt: now,
      ...blankMeetFields(),
    };
    accounts.users.push(user);
  } else {
    if (decision.setGoogleSub) user.googleSub = decision.setGoogleSub;
    user.emailVerified = true;
    if (!user.email) user.email = String(identity.email).trim().toLowerCase();
  }
  const session = makeSession(accounts, user, now);
  return { ok: true, user: publicUser(user), sessionId: session.id };
}

function setMeetSettings(user, input) {
  if (!user) return { ok: false, error: "Sign in first." };
  user.shouldMeetOn = Boolean(input.shouldMeetOn);
  user.includePrivate = Boolean(input.includePrivate);
  if (!user.shouldMeetOn) user.includePrivate = false;
  if (!user.includePrivate && Array.isArray(user.workingOn)) {
    // Keep public working-on marks; drop private ones so they don't leak into matches.
    user.workingOn = user.workingOn.filter((w) => w.channelId === "public");
  }
  return { ok: true, user: publicUser(user) };
}

function rememberJoinedRoom(user, channelId, joinKey) {
  if (!user || !channelId) return;
  if (!Array.isArray(user.joinedRooms)) user.joinedRooms = [];
  const existing = user.joinedRooms.find((r) => r.channelId === channelId);
  if (existing) {
    if (joinKey) existing.joinKey = joinKey;
    return;
  }
  user.joinedRooms.push({ channelId, joinKey: joinKey || "" });
}

module.exports = {
  emptyAccounts,
  normalizeAccounts,
  publicUser,
  userFromSession,
  userRecordFromSession,
  register,
  login,
  logout,
  loginFromGoogle,
  decideGoogleLink,
  googleRefusal,
  setMeetSettings,
  rememberJoinedRoom,
};

"use strict";

const crypto = require("node:crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const HERE_MS = 2 * 60 * 60 * 1000;

const RULES = {
  uploadCapPerWeek: 70,
  agentVotesPerWeek: 7,
  humanVotesPerWeek: 21,
  agentWeight: 3,
  agentContextMin: 40,
  agentContextMax: 4000,
  humanContextMin: 24,
  humanContextMax: 1200,
  humanAnswerMax: 280,
  questionMax: 280,
  weekSeats: 10,
  weekDays: 7,
  topicRoomsPerWeek: 3,
};

const FORBIDDEN = /([a-z]:\\)|(\.env\b)|(\/users\/)|(\/home\/)|(\bapi[_-]?key\b)|(\bpassword\b)|(@[a-z0-9.-]+\.[a-z]{2,})/i;

const RESERVED_SLUGS = new Set([
  "public", "chiang-mai-ai", "video", "api", "p", "r", "s", "sitemap", "feed",
  "llms", "robots", "favicon", "healthz", "index", "assets", "www", "admin",
  "login", "register", "auth", "google", "meet", "card", "cards", "vote",
  "rooms", "room", "topic", "topics", "static", "css", "js", "pair",
]);

const DEFAULT_CHANNELS = [
  {
    id: "public",
    name: "Public",
    visibility: "public",
    joinKey: null,
    mode: "competitive-collaborative",
    kind: "room",
    blurb: "Open board. Top of the day, week, month, year, or all time.",
  },
  {
    id: "chiang-mai-ai",
    name: "Chiang Mai AI",
    visibility: "closed",
    joinKey: "cm-4c-nimman-7k2q",
    mode: "collaborative",
    kind: "room",
    blurb: "Private room for the Chiang Mai AI crowd.",
  },
  {
    id: "video",
    name: "Video",
    visibility: "closed",
    joinKey: "vid-cut-room-9m4w",
    mode: "collaborative",
    kind: "room",
    blurb: "Private room for video people. Share the link.",
  },
];

function weekKey(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset));
  return monday.toISOString().slice(0, 10);
}

function emptyWeek() {
  return {
    id: "week-1",
    name: "Week 1",
    seats: RULES.weekSeats,
    days: RULES.weekDays,
    startsAt: 0,
    endsAt: 0,
    subscribers: [],
  };
}

function emptyHallway() {
  return { lastAt: 0, lastTick: 0, applied: 0, skipped: 0 };
}

function isAnswerCard(card) {
  return card && (card.kind === "reply" || card.kind === "answer");
}

function emptyBoard() {
  return {
    schema: "problemoverflow.board/0",
    channels: DEFAULT_CHANNELS.map((c) => ({ ...c })),
    cards: [],
    votes: [],
    people: [],
    contacts: [],
    week: emptyWeek(),
    hallway: emptyHallway(),
  };
}

function normalizeBoard(raw) {
  const board = raw && typeof raw === "object" ? raw : {};
  const next = {
    schema: "problemoverflow.board/0",
    channels: Array.isArray(board.channels) && board.channels.length
      ? board.channels
      : DEFAULT_CHANNELS.map((c) => ({ ...c })),
    cards: Array.isArray(board.cards) ? board.cards : [],
    votes: Array.isArray(board.votes) ? board.votes : [],
    people: Array.isArray(board.people) ? board.people : [],
    contacts: Array.isArray(board.contacts) ? board.contacts : [],
    week: board.week && typeof board.week === "object" ? board.week : emptyWeek(),
    hallway: board.hallway && typeof board.hallway === "object" ? board.hallway : emptyHallway(),
  };
  if (!Array.isArray(next.week.subscribers)) next.week.subscribers = [];
  if (!next.week.seats) next.week.seats = RULES.weekSeats;
  if (!next.week.days) next.week.days = RULES.weekDays;
  if (!next.hallway.lastAt) next.hallway.lastAt = 0;
  if (!next.hallway.lastTick) next.hallway.lastTick = 0;
  for (const vote of next.votes) {
    if (vote.source !== "buzz") vote.source = "board";
    if (vote.direction !== "down") vote.direction = "up";
  }
  for (const card of next.cards) {
    if (card.channel === "public-demo") card.channel = "public";
    if (!card.channel) card.channel = "public";
    if (!Array.isArray(card.clarifications)) card.clarifications = [];
    if (typeof card.humanContext !== "string") card.humanContext = card.humanContext || "";
    if (typeof card.agentContext !== "string") card.agentContext = card.agentContext || "";
    if (typeof card.buzzUrl !== "string") card.buzzUrl = card.buzzUrl || "";
    if (typeof card.authorId !== "string") card.authorId = card.authorId || "";
    if (typeof card.parentId !== "string") card.parentId = card.parentId || "";
  }
  for (const channel of next.channels) {
    if (!channel.kind) channel.kind = "room";
    if (!Array.isArray(channel.members)) channel.members = [];
    if (typeof channel.ownerId !== "string") channel.ownerId = channel.ownerId || "";
    if (!channel.createdAt) channel.createdAt = channel.createdAt || 0;
  }
  return next;
}

function leakHits(text) {
  const s = String(text || "");
  if (FORBIDDEN.test(s)) return true;
  if (/\b127\.0\.0\.1\b/i.test(s)) return true;
  if (/https?:\/\/localhost\b/i.test(s)) return true;
  if (/\blocalhost:\d+/i.test(s)) return true;
  for (const ch of DEFAULT_CHANNELS) {
    if (ch.joinKey && s.includes(ch.joinKey)) return true;
  }
  return false;
}

function findChannel(board, channelId) {
  return (board.channels || []).find((c) => c.id === channelId) || null;
}

function canSeeChannel(channel, joinKey, userId) {
  if (!channel) return false;
  if (channel.visibility === "public") return true;
  if (channel.kind === "pair" && userId && (channel.members || []).includes(userId)) return true;
  return Boolean(channel.joinKey) && String(joinKey || "") === channel.joinKey;
}

function inputUserId(input) {
  return String((input && (input.userId || input.voterId)) || "").trim();
}

function canSeeFromInput(channel, input) {
  return canSeeChannel(channel, input && input.joinKey, inputUserId(input));
}

function asViewer(viewer) {
  if (viewer && typeof viewer === "object") {
    return { role: asRole(viewer.role), userId: String(viewer.userId || "").trim() };
  }
  return { role: asRole(viewer), userId: "" };
}

function userSeesChannel(board, user, channelId, extraJoinKey) {
  const channel = findChannel(board, channelId);
  if (!channel) return false;
  if (canSeeChannel(channel, extraJoinKey, user && user.id)) return true;
  const rooms = (user && user.joinedRooms) || [];
  for (const row of rooms) {
    if (row.channelId === channelId && canSeeChannel(channel, row.joinKey, user && user.id)) return true;
  }
  return false;
}

function publicChannelList(board, userId) {
  return (board.channels || [])
    .filter((c) => {
      if (c.kind === "pair") return Boolean(userId) && (c.members || []).includes(userId);
      return true;
    })
    .map((c) => {
      const member = c.kind === "pair" && userId && (c.members || []).includes(userId);
      return {
        id: c.id,
        name: c.name,
        visibility: c.visibility,
        mode: c.mode,
        blurb: c.blurb,
        kind: c.kind || "room",
        open: c.visibility === "public",
        joinKey: member ? c.joinKey : undefined,
      };
    });
}

function asRole(value) {
  return value === "agent" ? "agent" : "human";
}

function hasExtraContext(card) {
  return Boolean(String(card && card.humanContext || "").trim() || String(card && card.agentContext || "").trim());
}

function stripForViewer(card, role) {
  const clarifications = (card.clarifications || []).map((item) => {
    const row = {
      id: item.id,
      question: item.question,
      askedBy: item.askedBy,
      askedRole: item.askedRole,
      askedAt: item.askedAt,
      humanAnswer: item.humanAnswer || "",
      agentAnswer: item.agentAnswer || "",
      answeredBy: item.answeredBy || "",
      answeredRole: item.answeredRole || "",
      answeredAt: item.answeredAt || 0,
    };
    return row;
  });
  const next = {
    ...card,
    humanContext: card.humanContext || "",
    agentContext: card.agentContext || "",
    hasExtraContext: hasExtraContext(card),
    hasAgentContext: Boolean(String(card.agentContext || "").trim()),
    clarifications,
  };
  return next;
}

function checkAgentContext(text, required) {
  const agentContext = String(text || "").trim();
  if (!agentContext) {
    if (required) {
      return { ok: false, error: "An agent post needs a deeper box so other agents can actually understand it." };
    }
    return { ok: true, agentContext: "" };
  }
  if (agentContext.length < RULES.agentContextMin || agentContext.length > RULES.agentContextMax) {
    return { ok: false, error: "The deeper box needs a real paragraph, not a novel and not a shrug." };
  }
  if (leakHits(agentContext)) {
    return { ok: false, error: "That deeper box looks like it has private stuff in it. Take out paths, keys, and emails." };
  }
  return { ok: true, agentContext };
}

function checkHumanContext(text) {
  const humanContext = String(text || "").trim();
  if (!humanContext) return { ok: true, humanContext: "" };
  if (humanContext.length < RULES.humanContextMin || humanContext.length > RULES.humanContextMax) {
    return { ok: false, error: "Readable context needs a real paragraph, not a novel and not a shrug." };
  }
  if (leakHits(humanContext)) {
    return { ok: false, error: "That readable context looks like it has private stuff in it. Take out paths, keys, and emails." };
  }
  return { ok: true, humanContext };
}

function sanitizeCard(input, now, channel) {
  const title = String(input.title || "").trim();
  const pointA = String(input.pointA || "").trim();
  const pointB = String(input.pointB || "").trim();
  const obstacle = String(input.obstacle || "").trim();
  const offer = String(input.offer || "").trim();
  const ask = String(input.ask || "").trim();
  const authorName = String(input.authorName || "").trim();
  const authorRole = asRole(input.authorRole);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6)
    : String(input.tags || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6);

  const human = checkHumanContext(input.humanContext);
  if (!human.ok) return human;

  const fields = [title, pointA, pointB, obstacle, offer, ask, human.humanContext, authorName, tags.join(" ")];
  if (fields.some(leakHits)) {
    return { ok: false, error: "That card looks like it has private stuff in it. Take out paths, keys, and emails." };
  }
  if (!title || title.split(/\s+/).length > 10) {
    return { ok: false, error: "Title needs to be there, and ten words or fewer." };
  }
  if (pointA.length < 12 || pointB.length < 12 || obstacle.length < 12) {
    return { ok: false, error: "Where you are, where you want to be, and what's in the way all need a real sentence." };
  }
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }

  const context = checkAgentContext(input.agentContext, authorRole === "agent");
  if (!context.ok) return context;

  return {
    ok: true,
    card: {
      id: input.id || `po-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      schema: "problemoverflow.card/0",
      title,
      visibility: channel.visibility === "public" ? "public" : "closed",
      source: "human-corrected",
      pointA,
      pointB,
      obstacle,
      offer,
      ask,
      tags,
      kind: "problem",
      channel: channel.id,
      authorName,
      authorRole,
      authorId: String(input.authorId || input.voterId || "").trim(),
      buzzUrl: "",
      humanContext: human.humanContext,
      agentContext: context.agentContext,
      clarifications: [],
      parentId: "",
      createdAt: now,
    },
  };
}

function personId(role, name) {
  return `${role}-${String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function touchPerson(board, input, now) {
  const name = String(input.authorName || input.name || "").trim();
  const role = asRole(input.authorRole || input.role);
  const channelId = String(input.channelId || "");
  if (!name || !findChannel(board, channelId)) {
    return { ok: false, error: "Need a name and a room." };
  }
  if (leakHits(name)) {
    return { ok: false, error: "That name looks like private stuff." };
  }
  const id = personId(role, name);
  const existing = board.people.find((p) => p.id === id);
  if (existing) {
    existing.lastSeen = now;
    existing.channelId = channelId;
    existing.role = role;
    existing.name = name;
  } else {
    board.people.push({ id, name, role, channelId, lastSeen: now });
  }
  return { ok: true };
}

function channelCards(board, channelId) {
  return board.cards.filter((c) => c.channel === channelId && !isAnswerCard(c));
}

function channelReplies(board, channelId) {
  return board.cards.filter((c) => c.channel === channelId && isAnswerCard(c));
}

function channelVotes(board, channelId) {
  const ids = new Set(channelCards(board, channelId).map((c) => c.id));
  return board.votes.filter((v) => ids.has(v.cardId));
}

function findProblem(board, channelId, cardId) {
  return channelCards(board, channelId).find((c) => c.id === cardId) || null;
}

function nestWouldCycle(board, channelId, childId, parentId) {
  let cur = String(parentId || "");
  const seen = new Set([String(childId || "")]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const node = findProblem(board, channelId, cur);
    if (!node) return false;
    cur = String(node.parentId || "");
  }
  return false;
}

function findClarifyAnswer(board, channelId, itemId) {
  const id = String(itemId || "");
  if (!id) return null;
  for (const card of channelCards(board, channelId)) {
    const item = (card.clarifications || []).find((q) => q.id === id);
    if (item && String(item.humanAnswer || "").trim()) {
      return { card, item };
    }
  }
  return null;
}

function findVotable(board, channelId, cardId) {
  const id = String(cardId || "");
  if (!id) return null;
  const problem = findProblem(board, channelId, id);
  if (problem) return { kind: "problem", id: problem.id };
  const answer = channelReplies(board, channelId).find((c) => c.id === id);
  if (answer) return { kind: "answer", id: answer.id };
  const clarify = findClarifyAnswer(board, channelId, id);
  if (clarify) return { kind: "answer", id: clarify.item.id };
  return null;
}

function postsThisWeek(board, authorName, now) {
  const key = weekKey(now);
  return board.cards.filter((c) => c.authorName === authorName && weekKey(c.createdAt) === key).length;
}

function slugTopic(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function uniqueTopicId(board, name) {
  let base = slugTopic(name) || "t";
  let id = base;
  const taken = () => RESERVED_SLUGS.has(id) || Boolean(findChannel(board, id)) || id.startsWith("pair-");
  let guard = 0;
  while (taken() && guard < 8) {
    id = `${base.slice(0, 20)}-${crypto.randomBytes(3).toString("hex")}`;
    guard += 1;
  }
  if (taken()) id = `t-${crypto.randomBytes(4).toString("hex")}`;
  return id;
}

function topicRoomsThisWeek(board, userId, now) {
  const key = weekKey(now);
  return (board.channels || []).filter((c) => (
    c.kind === "topic" && c.ownerId === userId && weekKey(c.createdAt || 0) === key
  )).length;
}

function votesThisWeek(board, voterId, now) {
  const key = weekKey(now);
  return board.votes.filter((v) => v.voterId === voterId && v.source !== "buzz" && weekKey(v.at) === key).length;
}

function addCard(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const checked = sanitizeCard(input, now, channel);
  if (!checked.ok) return checked;
  const parentId = String(input.parentId || "").trim();
  if (parentId) {
    const parent = findProblem(board, channel.id, parentId);
    if (!parent) {
      return { ok: false, error: "That bigger problem is not in this room." };
    }
    if (parent.id === checked.card.id) {
      return { ok: false, error: "A problem cannot sit under itself." };
    }
    if (nestWouldCycle(board, channel.id, checked.card.id, parent.id)) {
      return { ok: false, error: "That nest would loop." };
    }
    checked.card.parentId = parent.id;
  }
  if (postsThisWeek(board, checked.card.authorName, now) >= RULES.uploadCapPerWeek) {
    return { ok: false, error: "That's the weekly cap. Come back next week." };
  }
  board.cards.push(checked.card);
  touchPerson(board, {
    ...input,
    authorName: checked.card.authorName,
    authorRole: checked.card.authorRole,
    channelId: channel.id,
  }, now);
  return { ok: true, card: checked.card };
}

function addReply(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const parentId = String(input.inReplyTo || input.cardId || "");
  const note = String(input.note || "").trim();
  const authorName = String(input.authorName || "").trim();
  const authorRole = asRole(input.authorRole);
  if (!parentId || !findProblem(board, channel.id, parentId)) {
    return { ok: false, error: "That problem is not in this room." };
  }
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  if (note.length < 8 || note.length > 280) {
    return { ok: false, error: "A reply needs a short real note." };
  }
  if (leakHits(note) || leakHits(authorName)) {
    return { ok: false, error: "That reply looks like it has private stuff in it." };
  }
  if (postsThisWeek(board, authorName, now) >= RULES.uploadCapPerWeek) {
    return { ok: false, error: "That's the weekly cap. Come back next week." };
  }
  const reply = {
    id: input.id || `po-r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    schema: "problemoverflow.card/0",
    kind: "answer",
    inReplyTo: parentId,
    note,
    channel: channel.id,
    visibility: channel.visibility === "public" ? "public" : "closed",
    authorName,
    authorRole,
    createdAt: now,
  };
  board.cards.push(reply);
  touchPerson(board, { authorName, authorRole, channelId: channel.id }, now);
  return { ok: true, reply };
}

function addQuestion(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const question = String(input.question || "").trim();
  const authorName = String(input.authorName || "").trim();
  const authorRole = asRole(input.authorRole);
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  if (question.length < 8 || question.length > RULES.questionMax) {
    return { ok: false, error: "Ask one real clarifying question." };
  }
  if (leakHits(question) || leakHits(authorName)) {
    return { ok: false, error: "That question looks like it has private stuff in it." };
  }
  if (!Array.isArray(card.clarifications)) card.clarifications = [];
  const item = {
    id: input.id || `po-q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    question,
    askedBy: authorName,
    askedRole: authorRole,
    askedAt: now,
    humanAnswer: "",
    agentAnswer: "",
    answeredBy: "",
    answeredRole: "",
    answeredAt: 0,
  };
  card.clarifications.push(item);
  touchPerson(board, { authorName, authorRole, channelId: channel.id }, now);
  return { ok: true, question: item };
}

function addAnswer(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const item = (card.clarifications || []).find((q) => q.id === String(input.questionId || ""));
  if (!item) {
    return { ok: false, error: "That question is not on this problem." };
  }
  const authorName = String(input.authorName || "").trim();
  const authorRole = asRole(input.authorRole);
  const humanAnswer = String(input.humanAnswer || "").trim();
  const agentAnswer = String(input.agentAnswer || "").trim();
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  if (leakHits(humanAnswer) || leakHits(agentAnswer) || leakHits(authorName)) {
    return { ok: false, error: "That answer looks like it has private stuff in it." };
  }

  if (authorRole === "agent" && item.humanAnswer && !humanAnswer && agentAnswer) {
    if (agentAnswer.length < 12 || agentAnswer.length > RULES.agentContextMax) {
      return { ok: false, error: "The agent answer needs a real deeper note." };
    }
    item.agentAnswer = agentAnswer;
    if (!item.answeredBy) {
      item.answeredBy = authorName;
      item.answeredRole = "agent";
      item.answeredAt = now;
    }
    touchPerson(board, { authorName, authorRole, channelId: channel.id }, now);
    return { ok: true, question: item };
  }

  if (humanAnswer.length < 8 || humanAnswer.length > RULES.humanAnswerMax) {
    return { ok: false, error: "People need a short real answer." };
  }
  if (authorRole === "agent") {
    if (agentAnswer.length < 12 || agentAnswer.length > RULES.agentContextMax) {
      return { ok: false, error: "An agent answer needs the short box and the deeper box." };
    }
  } else if (agentAnswer) {
    return { ok: false, error: "The deeper box is for agents. Keep your answer short." };
  }

  item.humanAnswer = humanAnswer;
  if (authorRole === "agent") item.agentAnswer = agentAnswer;
  item.answeredBy = authorName;
  item.answeredRole = authorRole;
  item.answeredAt = now;
  touchPerson(board, { authorName, authorRole, channelId: channel.id }, now);
  return { ok: true, question: item };
}

function addAgentContext(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const authorName = String(input.authorName || "").trim();
  const authorRole = asRole(input.authorRole);
  if (authorRole !== "agent") {
    return { ok: false, error: "Only an agent writes the deeper box." };
  }
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  const context = checkAgentContext(input.agentContext, true);
  if (!context.ok) return context;
  card.agentContext = context.agentContext;
  touchPerson(board, { authorName, authorRole, channelId: channel.id }, now);
  return { ok: true, card };
}

function addHumanContext(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const authorName = String(input.authorName || "").trim();
  if (!authorName) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  const context = checkHumanContext(input.humanContext);
  if (!context.ok) return context;
  if (!context.humanContext) {
    return { ok: false, error: "Readable context needs a real paragraph." };
  }
  card.humanContext = context.humanContext;
  touchPerson(board, {
    authorName,
    authorRole: asRole(input.authorRole),
    channelId: channel.id,
  }, now);
  return { ok: true, card };
}

function joinWeek(board, input, now) {
  if (!board.week) board.week = emptyWeek();
  const week = board.week;
  const name = String(input.authorName || input.name || "").trim();
  const role = asRole(input.authorRole || input.role);
  if (!name) {
    return { ok: false, error: "Put a name on it so people know who to meet." };
  }
  if (leakHits(name)) {
    return { ok: false, error: "That name looks like private stuff." };
  }
  if (week.endsAt && now > week.endsAt) {
    return { ok: false, error: "This week is closed." };
  }
  if (week.subscribers.some((s) => String(s.name).toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: "You're already in this week." };
  }
  if (week.subscribers.length >= week.seats) {
    return { ok: false, error: "This week is full. Ten seats." };
  }
  if (!week.startsAt) {
    week.startsAt = now;
    week.endsAt = now + week.days * DAY_MS;
  }
  week.subscribers.push({ name, role, at: now });
  touchPerson(board, { name, role, channelId: "public" }, now);
  return { ok: true, week };
}

function weekView(board, now) {
  const week = board.week || emptyWeek();
  const open = week.subscribers.length < week.seats && (!week.endsAt || now <= week.endsAt);
  const publicCards = channelCards(board, "public");
  const votes = channelVotes(board, "public");
  const since = week.startsAt || 0;
  const top = ranked(publicCards, votes, since)[0];
  return {
    id: week.id,
    name: week.name,
    seats: week.seats,
    days: week.days,
    startsAt: week.startsAt,
    endsAt: week.endsAt,
    open,
    left: Math.max(0, week.seats - week.subscribers.length),
    subscribers: week.subscribers.map((s) => ({ name: s.name, role: s.role })),
    winner: top
      ? { title: top.card.title, authorName: top.card.authorName, rank: top.rank }
      : null,
  };
}

function addVote(board, input, now) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const cardId = String(input.cardId || "");
  const voterId = String(input.voterId || "").trim();
  const voterName = String(input.voterName || "").trim();
  const role = asRole(input.role);
  if (!cardId || !voterId || !voterName) {
    return { ok: false, error: "Need a card and a name to vote." };
  }
  const votable = findVotable(board, channel.id, cardId);
  if (!votable) {
    return { ok: false, error: "That card is not in this room." };
  }
  const existing = board.votes.filter((v) => v.cardId === cardId && v.voterId === voterId);
  if (existing.some((v) => v.source !== "buzz")) {
    return { ok: false, error: "You already backed this one." };
  }
  board.votes = board.votes.filter((v) => !(v.cardId === cardId && v.voterId === voterId && v.source === "buzz"));
  const cap = role === "agent" ? RULES.agentVotesPerWeek : RULES.humanVotesPerWeek;
  if (votesThisWeek(board, voterId, now) >= cap) {
    return { ok: false, error: "That's your vote pile for the week." };
  }
  board.votes.push({
    cardId,
    voterId,
    voterName,
    role,
    at: now,
    channelId: channel.id,
    source: "board",
    direction: "up",
  });
  touchPerson(board, { name: voterName, role, channelId: channel.id }, now);
  return { ok: true };
}

function peopleInRoom(board, channelId, now) {
  return (board.people || [])
    .filter((p) => p.channelId === channelId && now - p.lastSeen <= HERE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((p) => ({ id: p.id, name: p.name, role: p.role, lastSeen: p.lastSeen }));
}

function workingInRoom(board, channelId, here) {
  const hereIds = new Set(here.map((p) => p.id));
  const names = new Map();
  for (const card of board.cards.filter((c) => c.channel === channelId)) {
    const id = personId(card.authorRole || "human", card.authorName);
    if (!hereIds.has(id)) names.set(id, { id, name: card.authorName, role: card.authorRole || "human" });
  }
  return [...names.values()].slice(0, 12);
}

function activity(board, channelId) {
  const events = [];
  for (const card of board.cards.filter((c) => c.channel === channelId)) {
    if (isAnswerCard(card)) {
      events.push({ at: card.createdAt, type: "reply", actor: card.authorName, text: card.note, cardId: card.inReplyTo });
    } else {
      events.push({ at: card.createdAt, type: "post", actor: card.authorName, text: card.title, cardId: card.id });
      for (const item of card.clarifications || []) {
        events.push({ at: item.askedAt, type: "ask", actor: item.askedBy, text: item.question, cardId: card.id });
        if (item.humanAnswer) {
          events.push({
            at: item.answeredAt,
            type: "clarify",
            actor: item.answeredBy,
            text: item.humanAnswer,
            cardId: card.id,
          });
        }
      }
    }
  }
  for (const vote of channelVotes(board, channelId)) {
    events.push({
      at: vote.at,
      type: "vote",
      actor: vote.voterName,
      text: vote.direction === "down" ? "passed on a problem" : "backed a problem",
      cardId: vote.cardId,
    });
  }
  return events.sort((a, b) => b.at - a.at).slice(0, 16);
}

function voteDir(vote) {
  return vote && vote.direction === "down" ? -1 : 1;
}

function scoreCard(votes, card, since) {
  const mine = votes.filter((v) => v.cardId === card.id && v.at >= since);
  let agent = 0;
  let human = 0;
  let rank = 0;
  for (const vote of mine) {
    const dir = voteDir(vote);
    rank += dir * (vote.role === "agent" ? RULES.agentWeight : 1);
    if (vote.role === "agent") agent += dir;
    else human += dir;
  }
  return {
    agent,
    human,
    total: mine.length,
    rank,
  };
}

function ranked(cards, votes, since) {
  return cards
    .map((card) => ({ card, ...scoreCard(votes, card, since) }))
    .sort((a, b) => b.rank - a.rank || b.card.createdAt - a.card.createdAt);
}

function risingRanked(cards, votes, now) {
  const since = now - 2 * DAY_MS;
  return cards
    .map((card) => {
      const scored = scoreCard(votes, card, since);
      const ageHours = Math.max(2, (now - card.createdAt) / HOUR_MS);
      return { card, ...scored, heat: scored.rank / ageHours };
    })
    .sort((a, b) => b.heat - a.heat || b.rank - a.rank || b.card.createdAt - a.card.createdAt);
}

function words(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

function overlapScore(a, b) {
  const tags = (a.tags || []).filter((t) => (b.tags || []).includes(t)).length * 3;
  const wa = words(`${a.obstacle} ${a.pointB} ${a.agentContext || ""}`);
  const wb = words(`${b.obstacle} ${b.pointB} ${b.agentContext || ""}`);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return tags + shared;
}

function whoMeetsWho(cards) {
  const pairs = [];
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i];
      const b = cards[j];
      if (a.authorName === b.authorName) continue;
      const score = overlapScore(a, b);
      if (score >= 3) {
        pairs.push({
          score,
          a: { id: a.id, title: a.title, authorName: a.authorName },
          b: { id: b.id, title: b.title, authorName: b.authorName },
        });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, 8);
}

function roomUrl(origin, channelId, joinKey) {
  const base = String(origin || "").replace(/\/$/, "");
  if (joinKey) return `${base}/#/${channelId}?k=${encodeURIComponent(joinKey)}`;
  return `${base}/#/${channelId}`;
}

function hallwayLine(boardUrl) {
  const url = String(boardUrl || "").trim();
  if (!url || /127\.0\.0\.1|localhost/i.test(url)) {
    return "If you can help, reply here.";
  }
  return url;
}

function buzzBlurb(card, boardUrl) {
  const lines = [
    `Stuck: ${card.title}`,
    `Now: ${card.pointA}`,
    `Want: ${card.pointB}`,
    `In the way: ${card.obstacle}`,
    hallwayLine(boardUrl),
  ];
  const text = lines.join("\n");
  if (leakHits(text)) {
    return { ok: false, error: "That card is not safe to paste into Buzz." };
  }
  if (/\bagent context\b/i.test(text) || (card.agentContext && text.includes(card.agentContext))) {
    return { ok: false, error: "The deeper box stays on the board. Buzz only gets the short card." };
  }
  if (card.humanContext && text.includes(card.humanContext)) {
    return { ok: false, error: "Extra readable context stays on the board. Buzz only gets the short card." };
  }
  return { ok: true, text };
}

function copyBuzz(board, input) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const publicRoom = channel.visibility === "public";
  const boardUrl = publicRoom ? String(input.publicOrigin || "") : String(input.origin || "");
  return buzzBlurb(card, boardUrl);
}

function setBuzzLink(board, input) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, input)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  const url = String(input.buzzUrl || "").trim();
  if (!url) {
    card.buzzUrl = "";
    return { ok: true, card };
  }
  if (!isSafeBuzzUrl(url)) {
    return { ok: false, error: leakHits(url) || /127\.0\.0\.1|localhost/i.test(url)
      ? "That link is not safe."
      : "That has to be a Buzz link." };
  }
  card.buzzUrl = url;
  return { ok: true, card };
}

function normalizeBuzzUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "").toLowerCase();
}

function isSafeBuzzUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  if (leakHits(raw) || /127\.0\.0\.1|localhost/i.test(raw)) return false;
  if (/^https:\/\/(www\.)?buzz\.xyz(\/|$)/i.test(raw)) return true;
  if (/^https:\/\/problemoverflow\.communities\.buzz\.xyz(\/|$)/i.test(raw)) return true;
  return false;
}

function voteDirection(raw) {
  const value = String(raw || "up").toLowerCase();
  if (value === "down" || value === "-" || value === "downvote") return "down";
  return "up";
}

function findTallyCard(board, item) {
  const cardId = String((item && item.cardId) || "").trim();
  if (cardId) {
    const byId = board.cards.find((c) => c.id === cardId && !isAnswerCard(c));
    if (byId) return byId;
  }
  const url = normalizeBuzzUrl(item && item.buzzUrl);
  if (!url) return null;
  return board.cards.find((c) => !isAnswerCard(c) && normalizeBuzzUrl(c.buzzUrl) === url) || null;
}

function applyBuzzTally(board, tally, now) {
  if (!tally || typeof tally !== "object" || tally.schema !== "problemoverflow.buzz-tally/0") {
    return { ok: false, error: "That hallway update is the wrong shape." };
  }
  const items = Array.isArray(tally.items) ? tally.items : [];
  const skipped = [];
  const applied = [];
  if (!items.length) {
    board.hallway = board.hallway || emptyHallway();
    board.hallway.lastAt = now;
    board.hallway.applied = 0;
    board.hallway.skipped = 0;
    return { ok: true, applied, skipped, hallway: board.hallway };
  }

  const incoming = [];
  const spent = { up: Object.create(null), down: Object.create(null) };

  function spend(voterId, role, direction) {
    const cap = role === "agent" ? RULES.agentVotesPerWeek : RULES.humanVotesPerWeek;
    const bucket = spent[direction];
    bucket[voterId] = (bucket[voterId] || 0) + 1;
    return bucket[voterId] <= cap;
  }

  for (const item of items) {
    const rawUrl = String((item && item.buzzUrl) || "").trim();
    const cardId = String((item && item.cardId) || "").trim();
    if (rawUrl && !isSafeBuzzUrl(rawUrl) && !cardId) {
      skipped.push({ reason: "bad-url" });
      continue;
    }
    const card = findTallyCard(board, item);
    if (!card) {
      skipped.push({ reason: "unmatched" });
      continue;
    }
    const channel = findChannel(board, card.channel);
    if (!channel || channel.visibility !== "public") {
      skipped.push({ reason: "not-public", cardId: card.id });
      continue;
    }
    const boardVoters = new Set(
      board.votes.filter((v) => v.cardId === card.id && v.source !== "buzz").map((v) => v.voterId)
    );
    const byVoter = new Map();
    for (const row of Array.isArray(item.votes) ? item.votes : []) {
      const voterId = String(row.voterId || "").trim();
      const voterName = String(row.voterName || "").trim();
      if (!voterId || !voterName) continue;
      if (leakHits(voterId) || leakHits(voterName)) continue;
      if (card.authorId && voterId === card.authorId) continue;
      byVoter.set(voterId, {
        voterId,
        voterName,
        role: asRole(row.role),
        direction: voteDirection(row.direction),
      });
    }
    let kept = 0;
    for (const vote of byVoter.values()) {
      if (boardVoters.has(vote.voterId)) continue;
      if (!spend(vote.voterId, vote.role, vote.direction)) continue;
      incoming.push({
        cardId: card.id,
        voterId: vote.voterId,
        voterName: vote.voterName,
        role: vote.role,
        at: now,
        channelId: channel.id,
        source: "buzz",
        direction: vote.direction,
      });
      kept += 1;
    }
    applied.push(card.id);
    if (!kept && byVoter.size) skipped.push({ reason: "capped", cardId: card.id });
  }

  if (applied.length) {
    board.votes = board.votes.filter((v) => v.source !== "buzz").concat(incoming);
  }
  board.hallway = board.hallway || emptyHallway();
  board.hallway.lastAt = now;
  board.hallway.applied = applied.length;
  board.hallway.skipped = skipped.length;
  return { ok: true, applied, skipped, hallway: board.hallway };
}

function cardUsableForMeet(board, user, other, card) {
  const channel = findChannel(board, card.channel);
  if (!channel || channel.kind === "pair") return false;
  if (channel.visibility === "public") return true;
  if (!user.includePrivate || !other.includePrivate) return false;
  return userSeesChannel(board, user, channel.id) && userSeesChannel(board, other, channel.id);
}

function hitTitle(board, viewer, other, card) {
  const channel = findChannel(board, card.channel);
  if (!channel) return "A problem";
  if (channel.visibility === "public") return card.title;
  if (viewer.includePrivate && other.includePrivate && userSeesChannel(board, viewer, channel.id)) {
    return card.title;
  }
  return "A private problem";
}

function resolveWorkingCards(board, user) {
  const rows = Array.isArray(user.workingOn) ? user.workingOn : [];
  const out = [];
  for (const row of rows) {
    const card = findProblem(board, row.channelId, row.cardId);
    if (card) out.push(card);
  }
  return out;
}

function matchHits(board, viewer, other) {
  const mine = resolveWorkingCards(board, viewer);
  const theirs = resolveWorkingCards(board, other);
  const hits = [];
  for (const a of mine) {
    for (const b of theirs) {
      if (!cardUsableForMeet(board, viewer, other, a) || !cardUsableForMeet(board, viewer, other, b)) continue;
      if (a.id === b.id) {
        hits.push({
          score: 99,
          same: true,
          a: { cardId: a.id, channelId: a.channel, title: hitTitle(board, viewer, other, a) },
          b: { cardId: b.id, channelId: b.channel, title: hitTitle(board, viewer, other, b) },
        });
        continue;
      }
      const score = overlapScore(a, b);
      if (score >= 3) {
        hits.push({
          score,
          same: false,
          a: { cardId: a.id, channelId: a.channel, title: hitTitle(board, viewer, other, a) },
          b: { cardId: b.id, channelId: b.channel, title: hitTitle(board, viewer, other, b) },
        });
      }
    }
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, 4);
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function findContact(board, a, b) {
  const key = pairKey(a, b);
  return (board.contacts || []).find((row) => row.pairKey === key) || null;
}

function createTopicRoom(board, input, now) {
  const userId = inputUserId(input);
  if (!userId) {
    return { ok: false, error: "Sign in first." };
  }
  const name = String(input.name || "").trim();
  const blurb = String(input.blurb || "").trim().slice(0, 120);
  if (name.length < 2 || name.length > 40) {
    return { ok: false, error: "Pick a short topic name." };
  }
  if (leakHits(name) || leakHits(blurb)) {
    return { ok: false, error: "That name is not safe to post." };
  }
  if (topicRoomsThisWeek(board, userId, now) >= RULES.topicRoomsPerWeek) {
    return { ok: false, error: "That's this week's topics. Come back next week." };
  }
  const id = uniqueTopicId(board, name);
  const channel = {
    id,
    name,
    visibility: "public",
    joinKey: null,
    mode: "collaborative",
    kind: "topic",
    blurb: blurb || `Public topic: ${name}.`,
    ownerId: userId,
    createdAt: now,
    members: [],
  };
  board.channels.push(channel);
  return {
    ok: true,
    channel: {
      id: channel.id,
      name: channel.name,
      visibility: "public",
      kind: "topic",
      blurb: channel.blurb,
      open: true,
    },
  };
}

function openPairChannel(board, a, b) {
  const name = leakHits(`${a.name} ${b.name}`) ? "Pair room" : `${a.name} × ${b.name}`;
  const channel = {
    id: `pair-${crypto.randomBytes(6).toString("hex")}`,
    name,
    visibility: "closed",
    mode: "collaborative",
    kind: "pair",
    members: [a.id, b.id],
    joinKey: `pk-${crypto.randomBytes(8).toString("hex")}`,
    blurb: "Just the two of you.",
  };
  board.channels.push(channel);
  return channel;
}

function contactStatus(row, viewerId, otherId) {
  if (!row) return "none";
  if (row.channelId) return "open";
  const mine = Boolean(row.wants && row.wants[viewerId]);
  const theirs = Boolean(row.wants && row.wants[otherId]);
  if (mine && theirs) return "open";
  if (mine) return "waiting";
  if (theirs) return "theirs";
  return "none";
}

function meetMatches(board, users, viewer) {
  if (!viewer || !viewer.shouldMeetOn) return [];
  const out = [];
  for (const other of users) {
    if (!other || other.id === viewer.id || !other.shouldMeetOn) continue;
    const hits = matchHits(board, viewer, other);
    if (!hits.length) continue;
    const row = findContact(board, viewer.id, other.id);
    const status = contactStatus(row, viewer.id, other.id);
    const channel = row && row.channelId ? findChannel(board, row.channelId) : null;
    const member = channel && (channel.members || []).includes(viewer.id);
    out.push({
      userId: other.id,
      name: other.name,
      hits,
      score: hits[0].score,
      status,
      channelId: member ? channel.id : "",
      joinKey: member ? channel.joinKey : "",
    });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function setWorkingOn(board, user, input) {
  const channel = findChannel(board, input.channelId);
  if (!canSeeFromInput(channel, { ...input, userId: user.id })) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const card = findProblem(board, channel.id, String(input.cardId || ""));
  if (!card) {
    return { ok: false, error: "That problem is not in this room." };
  }
  if (channel.visibility !== "public" && !user.includePrivate) {
    return { ok: false, error: "Turn on private rooms in Should Meet first." };
  }
  if (!Array.isArray(user.workingOn)) user.workingOn = [];
  const idx = user.workingOn.findIndex((w) => w.cardId === card.id);
  if (idx >= 0) user.workingOn.splice(idx, 1);
  else user.workingOn.push({ cardId: card.id, channelId: channel.id });
  return { ok: true, workingOn: user.workingOn };
}

function contactMeet(board, viewer, other, now) {
  if (!other || viewer.id === other.id) {
    return { ok: false, error: "Pick someone else." };
  }
  if (!viewer.shouldMeetOn || !other.shouldMeetOn) {
    return { ok: false, error: "Should Meet is off." };
  }
  const key = pairKey(viewer.id, other.id);
  let row = findContact(board, viewer.id, other.id);
  if (!row) {
    row = { pairKey: key, wants: {}, channelId: "", createdAt: now };
    board.contacts.push(row);
  }
  if (!row.wants) row.wants = {};
  row.wants[viewer.id] = true;
  if (row.wants[viewer.id] && row.wants[other.id] && !row.channelId) {
    const channel = openPairChannel(board, viewer, other);
    row.channelId = channel.id;
  }
  const channel = row.channelId ? findChannel(board, row.channelId) : null;
  const member = channel && (channel.members || []).includes(viewer.id);
  return {
    ok: true,
    status: contactStatus(row, viewer.id, other.id),
    channelId: member ? channel.id : "",
    joinKey: member ? channel.joinKey : "",
  };
}

function isPublicRoom(channel) {
  return Boolean(channel && channel.visibility === "public" && channel.kind !== "pair");
}

function publicRoomPermalink(origin, channelId) {
  const base = String(origin || "").replace(/\/$/, "");
  const id = String(channelId || "").trim();
  return `${base}/r/${encodeURIComponent(id)}`;
}

function publicSystemView(board, card) {
  if (!card || isAnswerCard(card)) return null;
  const channel = findChannel(board, card.channel);
  if (!isPublicRoom(channel)) return null;
  const parent = card.parentId ? findProblem(board, card.channel, card.parentId) : null;
  const children = channelCards(board, card.channel)
    .filter((c) => c.parentId === card.id)
    .map((c) => ({ id: c.id, title: c.title }));
  const votes = (board.votes || []).filter((v) => v.channelId === card.channel);
  const answers = ranked(
    channelReplies(board, card.channel).filter((r) => r.inReplyTo === card.id),
    votes,
    0
  ).map((row) => ({
    id: row.card.id,
    note: row.card.note,
    authorName: row.card.authorName,
    rank: row.rank,
  }));
  return {
    channelId: channel.id,
    channelName: channel.name,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    children,
    answers,
  };
}

function publicCard(board, cardId) {
  const id = String(cardId || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const card = (board.cards || []).find((c) => c.id === id && !isAnswerCard(c));
  if (!card) return null;
  const channel = findChannel(board, card.channel);
  if (!isPublicRoom(channel)) return null;
  return card;
}

function publicProblems(board) {
  return (board.cards || []).filter((c) => {
    if (isAnswerCard(c)) return false;
    return isPublicRoom(findChannel(board, c.channel));
  });
}

function publicPermalink(origin, cardId) {
  const base = String(origin || "").replace(/\/$/, "");
  return `${base}/p/${encodeURIComponent(cardId)}`;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publicSitemapXml(board, origin) {
  const base = String(origin || "").replace(/\/$/, "");
  const locs = [base + "/"];
  for (const channel of board.channels || []) {
    if (isPublicRoom(channel) && channel.kind === "topic") {
      locs.push(publicRoomPermalink(base, channel.id));
    }
  }
  for (const card of publicProblems(board)) {
    locs.push(publicPermalink(base, card.id));
  }
  const body = locs.map((loc) => `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <changefreq>hourly</changefreq>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function rfc822(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toUTCString();
}

function publicRssXml(board, origin) {
  const base = String(origin || "").replace(/\/$/, "");
  const items = publicProblems(board)
    .slice()
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, 50)
    .map((c) => {
      const link = publicPermalink(base, c.id);
      const pub = rfc822(c.createdAt);
      const dateLine = pub ? `\n      <pubDate>${pub}</pubDate>` : "";
      return `    <item>\n      <title>${xmlEscape(c.title)}</title>\n      <link>${xmlEscape(link)}</link>\n      <guid isPermaLink="true">${xmlEscape(link)}</guid>\n      <description>${xmlEscape(c.pointA || c.title || "")}</description>${dateLine}\n    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>Problem Overflow</title>\n    <link>${xmlEscape(base + "/")}</link>\n    <description>Share the problem, not the stack. Public problems only.</description>\n${items}\n  </channel>\n</rss>\n`;
}

function snapshot(board, channelId, joinKey, now, viewer) {
  const view = asViewer(viewer);
  const channel = findChannel(board, channelId);
  if (!canSeeChannel(channel, joinKey, view.userId)) {
    return { ok: false, error: "That room is closed. You need the link." };
  }
  const cards = channelCards(board, channel.id);
  const votes = channelVotes(board, channel.id);
  const replies = channelReplies(board, channel.id);
  const answerVotes = board.votes.filter((v) => v.channelId === channel.id);
  const here = peopleInRoom(board, channel.id, now);
  const decorate = (row) => {
    const parent = row.card.parentId ? findProblem(board, channel.id, row.card.parentId) : null;
    const children = cards
      .filter((c) => c.parentId === row.card.id)
      .map((c) => ({ id: c.id, title: c.title }));
    const scoredAnswers = ranked(
      replies.filter((r) => r.inReplyTo === row.card.id),
      answerVotes,
      0
    );
    const clarifications = (row.card.clarifications || []).map((item) => ({
      ...item,
      rank: scoreCard(answerVotes, { id: item.id }, 0).rank,
    }));
    return {
      ...row,
      card: {
        ...stripForViewer(row.card, view.role),
        parentId: row.card.parentId || "",
        clarifications,
      },
      parent: parent ? { id: parent.id, title: parent.title } : null,
      children,
      replies: scoredAnswers.map((ans) => ({
        ...ans.card,
        rank: ans.rank,
      })),
    };
  };
  const rankedAll = ranked(cards, votes, 0).map(decorate);
  const rising = risingRanked(cards, votes, now).map(decorate);
  const top = {
    day: ranked(cards, votes, now - DAY_MS).map(decorate),
    week: ranked(cards, votes, now - WEEK_MS).map(decorate),
    month: ranked(cards, votes, now - MONTH_MS).map(decorate),
    year: ranked(cards, votes, now - YEAR_MS).map(decorate),
    all: rankedAll,
  };
  const safeChannel = {
    id: channel.id,
    name: channel.name,
    visibility: channel.visibility,
    mode: channel.mode,
    kind: channel.kind || "room",
    blurb: channel.blurb,
  };
  return {
    ok: true,
    rules: RULES,
    viewer: view.role,
    channel: safeChannel,
    channels: publicChannelList(board, view.userId),
    cards: rankedAll,
    live: [...rankedAll].sort((a, b) => b.card.createdAt - a.card.createdAt),
    rising,
    day: top.day,
    month: top.month,
    top,
    meet: [],
    here,
    working: workingInRoom(board, channel.id, here),
    activity: activity(board, channel.id),
    week: weekView(board, now),
    hallway: {
      lastAt: (board.hallway && board.hallway.lastAt) || 0,
      lastTick: (board.hallway && board.hallway.lastTick) || 0,
    },
  };
}

module.exports = {
  RULES,
  DEFAULT_CHANNELS,
  emptyBoard,
  normalizeBoard,
  leakHits,
  isAnswerCard,
  findChannel,
  canSeeChannel,
  publicChannelList,
  userSeesChannel,
  sanitizeCard,
  addCard,
  addReply,
  addQuestion,
  addAnswer,
  addAgentContext,
  addHumanContext,
  hasExtraContext,
  addVote,
  touchPerson,
  ranked,
  snapshot,
  roomUrl,
  hallwayLine,
  buzzBlurb,
  copyBuzz,
  setBuzzLink,
  applyBuzzTally,
  setWorkingOn,
  meetMatches,
  contactMeet,
  overlapScore,
  joinWeek,
  weekView,
  weekKey,
  postsThisWeek,
  votesThisWeek,
  stripForViewer,
  publicCard,
  publicProblems,
  publicPermalink,
  publicRoomPermalink,
  publicSystemView,
  publicSitemapXml,
  publicRssXml,
  createTopicRoom,
};

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const boardLib = require("../lib/board");
const live = require("../lib/live-config");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`ok  ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`fail  ${name}\n  ${err.message}\n`);
  }
}

const now = 1787529000000;

check("leaks are refused", () => {
  const board = boardLib.emptyBoard();
  const bad = boardLib.addCard(board, {
    channelId: "public",
    title: "Secret path leak",
    pointA: "I am stuck in C:\\Users\\someone\\secret",
    pointB: "I want a clean card with no workshop in it",
    obstacle: "The draft still has a password in it",
    authorName: "Zach",
  }, now);
  assert.equal(bad.ok, false);
});

check("email and env leaks are refused", () => {
  const hit = boardLib.leakHits("write to .env and mail me@site.com");
  assert.equal(hit, true);
});

check("localhost and join keys are leaks", () => {
  assert.equal(boardLib.leakHits("open http://localhost:8146"), true);
  assert.equal(boardLib.leakHits("come to cm-4c-nimman-7k2q"), true);
  assert.equal(boardLib.leakHits("A localhost link would leak the workshop."), false);
  assert.equal(boardLib.leakHits("I am stuck on a short that still needs my hands"), false);
});

check("wrong key hides a private room", () => {
  const board = boardLib.normalizeBoard({
    cards: [{
      id: "secret-1",
      title: "Private stuck thing",
      pointA: "We are in a closed room with a real problem.",
      pointB: "Only people with the link should see this card.",
      obstacle: "A public peek would leak the private room.",
      tags: ["private"],
      channel: "chiang-mai-ai",
      authorName: "Mina",
      createdAt: now,
    }],
  });
  const denied = boardLib.snapshot(board, "chiang-mai-ai", "nope", now);
  assert.equal(denied.ok, false);
  const open = boardLib.snapshot(board, "chiang-mai-ai", "cm-4c-nimman-7k2q", now);
  assert.equal(open.ok, true);
  assert.equal(open.cards.length, 1);
});

check("public snapshot never lists private cards", () => {
  const board = boardLib.normalizeBoard({
    cards: [
      {
        id: "pub-1",
        title: "Public stuck thing",
        pointA: "This one is meant for anyone to see.",
        pointB: "It should show on the public board only.",
        obstacle: "Private cards must not ride along.",
        tags: ["public"],
        channel: "public",
        authorName: "Ada",
        createdAt: now,
      },
      {
        id: "hid-1",
        title: "Hidden video stuck thing",
        pointA: "This belongs in the video room only.",
        pointB: "Public visitors should never see this title.",
        obstacle: "A mixed snapshot would leak the private room.",
        tags: ["video"],
        channel: "video",
        authorName: "Bea",
        createdAt: now,
      },
    ],
  });
  const snap = boardLib.snapshot(board, "public", "", now);
  assert.equal(snap.ok, true);
  assert.equal(snap.cards.every((row) => row.card.channel === "public"), true);
  assert.equal(snap.cards.some((row) => row.card.id === "hid-1"), false);
});

check("old public-demo cards remap", () => {
  const board = boardLib.normalizeBoard({
    cards: [{ id: "old", channel: "public-demo", title: "Old", createdAt: now }],
  });
  assert.equal(board.cards[0].channel, "public");
});

check("weekly upload cap", () => {
  const board = boardLib.emptyBoard();
  const base = {
    channelId: "public",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "There are too many posts in one week already.",
    authorName: "Capper",
  };
  for (let i = 0; i < 70; i += 1) {
    const result = boardLib.addCard(board, { ...base, title: `Cap test number ${i}` }, now);
    assert.equal(result.ok, true);
  }
  const extra = boardLib.addCard(board, { ...base, title: "One more over the cap" }, now);
  assert.equal(extra.ok, false);
});

check("agent vote pile is seven", () => {
  const board = boardLib.emptyBoard();
  for (let i = 0; i < 8; i += 1) {
    const added = boardLib.addCard(board, {
      channelId: "public",
      title: `Vote card number ${i}`,
      pointA: "This card exists so an agent can spend a vote.",
      pointB: "The eighth vote should be refused this week.",
      obstacle: "The weekly agent pile is supposed to be small.",
      authorName: `Author ${i}`,
    }, now);
    assert.equal(added.ok, true);
    const vote = boardLib.addVote(board, {
      channelId: "public",
      cardId: added.card.id,
      voterId: "agent-one",
      voterName: "Agent One",
      role: "agent",
    }, now);
    if (i < 7) assert.equal(vote.ok, true);
    else assert.equal(vote.ok, false);
  }
});

check("wrong key cannot vote in a private room", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "video",
    joinKey: "vid-cut-room-9m4w",
    title: "Private video stuck thing",
    pointA: "This card lives in the video room only.",
    pointB: "A stranger without the link should not vote.",
    obstacle: "A leaked vote would prove the card was visible.",
    authorName: "Cam",
  }, now);
  assert.equal(added.ok, true);
  const sneak = boardLib.addVote(board, {
    channelId: "video",
    joinKey: "wrong",
    cardId: added.card.id,
    voterId: "human-sneak",
    voterName: "Sneak",
    role: "human",
  }, now);
  assert.equal(sneak.ok, false);
});

check("answers can be voted without lifting the parent", () => {
  const board = boardLib.emptyBoard();
  const parent = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public stuck thing",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
  }, now);
  assert.equal(parent.ok, true);
  const child = boardLib.addCard(board, {
    channelId: "public",
    parentId: parent.card.id,
    title: "Need the first substep done",
    pointA: "The bigger stuck thing is still open.",
    pointB: "This smaller step should sit under it.",
    obstacle: "A flat list hides which problems belong together.",
    authorName: "Ben",
  }, now);
  assert.equal(child.ok, true);
  assert.equal(child.card.parentId, parent.card.id);
  const answer = boardLib.addReply(board, {
    channelId: "public",
    cardId: parent.card.id,
    note: "Here is a real short answer for it.",
    authorName: "Ned",
  }, now);
  assert.equal(answer.ok, true);
  assert.equal(answer.reply.kind, "answer");
  const voted = boardLib.addVote(board, {
    channelId: "public",
    cardId: answer.reply.id,
    voterId: "agent-one",
    voterName: "Agent One",
    role: "agent",
  }, now);
  assert.equal(voted.ok, true);
  const snap = boardLib.snapshot(board, "public", "", now);
  const row = snap.cards.find((r) => r.card.id === parent.card.id);
  assert.equal(row.rank, 0);
  assert.equal(row.replies.length, 1);
  assert.equal(row.replies[0].rank, 3);
  assert.ok(row.children.some((c) => c.id === child.card.id));
  const nested = snap.cards.find((r) => r.card.id === child.card.id);
  assert.equal(nested.parent.id, parent.card.id);
});

check("parent in another room is refused", () => {
  const board = boardLib.emptyBoard();
  const priv = boardLib.addCard(board, {
    channelId: "video",
    joinKey: "vid-cut-room-9m4w",
    title: "Private video stuck thing",
    pointA: "This card lives in the video room only.",
    pointB: "A public card should not sit under it.",
    obstacle: "A cross-room nest would leak the private room.",
    authorName: "Cam",
  }, now);
  assert.equal(priv.ok, true);
  const sneaky = boardLib.addCard(board, {
    channelId: "public",
    parentId: priv.card.id,
    title: "Need a public nest sneak",
    pointA: "I am trying to hang a public card under a private one.",
    pointB: "The board should refuse that nest.",
    obstacle: "A leaked parent would prove the private card was visible.",
    authorName: "Sneak",
  }, now);
  assert.equal(sneaky.ok, false);
});

check("people can open a public topic room", () => {
  const board = boardLib.emptyBoard();
  const unsigned = boardLib.createTopicRoom(board, { name: "Agents" }, now);
  assert.equal(unsigned.ok, false);
  const made = boardLib.createTopicRoom(board, { name: "Agents", blurb: "Public topic for agents.", userId: "u-ada" }, now);
  assert.equal(made.ok, true);
  assert.equal(made.channel.kind, "topic");
  assert.equal(made.channel.visibility, "public");
  assert.notEqual(made.channel.id, "public");
  assert.notEqual(made.channel.id, "video");
  const reserved = boardLib.createTopicRoom(board, { name: "Video", userId: "u-ada" }, now);
  assert.equal(reserved.ok, true);
  assert.notEqual(reserved.channel.id, "video");
  const leak = boardLib.createTopicRoom(board, { name: "password dump", userId: "u-ada" }, now);
  assert.equal(leak.ok, false);
  boardLib.createTopicRoom(board, { name: "Third topic", userId: "u-ada" }, now);
  const capped = boardLib.createTopicRoom(board, { name: "Fourth topic", userId: "u-ada" }, now);
  assert.equal(capped.ok, false);
  const xml = boardLib.publicSitemapXml(board, "https://problemoverflow.com");
  assert.match(xml, /\/topics</);
  assert.match(xml, /\/meetup</);
  assert.match(xml, new RegExp("/r/" + made.channel.id));
  assert.doesNotMatch(xml, /\/r\/video</);
  assert.doesNotMatch(xml, /\/r\/public</);
  const listed = boardLib.publicTopicRooms(board);
  assert.ok(listed.some((t) => t.id === made.channel.id));
  assert.ok(!listed.some((t) => t.id === "public" || t.id === "video" || t.id === "chiang-mai-ai"));
  assert.equal(boardLib.publicTopicsPermalink("https://problemoverflow.com"), "https://problemoverflow.com/topics");
  assert.equal(boardLib.publicMeetupPermalink("https://problemoverflow.com"), "https://problemoverflow.com/meetup");
  const posted = boardLib.addCard(board, {
    channelId: made.channel.id,
    title: "Need a topic stuck thing",
    pointA: "I am on the first side of a topic problem.",
    pointB: "I want a second side a stranger can help with.",
    obstacle: "The house Public room is too mixed for this.",
    authorName: "Ada",
  }, now);
  assert.equal(posted.ok, true);
  const child = boardLib.addCard(board, {
    channelId: made.channel.id,
    parentId: posted.card.id,
    title: "Need the first topic substep",
    pointA: "The bigger topic problem is still open.",
    pointB: "This smaller step should sit under it.",
    obstacle: "A flat list hides which problems belong together.",
    authorName: "Ben",
  }, now);
  assert.equal(child.ok, true);
  const answer = boardLib.addReply(board, {
    channelId: made.channel.id,
    cardId: posted.card.id,
    note: "Here is a real short answer for the topic.",
    authorName: "Ned",
  }, now);
  assert.equal(answer.ok, true);
  const view = boardLib.publicSystemView(board, posted.card);
  assert.equal(view.channelId, made.channel.id);
  assert.equal(view.children[0].id, child.card.id);
  assert.equal(view.answers[0].note, "Here is a real short answer for the topic.");
  assert.ok(boardLib.publicCard(board, posted.card.id));
});

check("clarifying answers can be voted after they exist", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need one clarifying question",
    pointA: "Someone will ask what I actually mean by unstuck.",
    pointB: "I could answer in one short line people can read.",
    obstacle: "A novel in the human box would bury the stuck thing.",
    authorName: "Zach",
  }, now);
  assert.equal(added.ok, true);
  const asked = boardLib.addQuestion(board, {
    channelId: "public",
    cardId: added.card.id,
    question: "What would unstuck look like this week?",
    authorName: "Mina",
  }, now);
  assert.equal(asked.ok, true);
  const tooSoon = boardLib.addVote(board, {
    channelId: "public",
    cardId: asked.question.id,
    voterId: "agent-one",
    voterName: "Agent One",
    role: "agent",
  }, now);
  assert.equal(tooSoon.ok, false);
  const answered = boardLib.addAnswer(board, {
    channelId: "public",
    cardId: added.card.id,
    questionId: asked.question.id,
    humanAnswer: "Five lines that sound like me, posted after I say yes.",
    authorName: "Zach",
  }, now);
  assert.equal(answered.ok, true);
  const voted = boardLib.addVote(board, {
    channelId: "public",
    cardId: asked.question.id,
    voterId: "agent-one",
    voterName: "Agent One",
    role: "agent",
  }, now);
  assert.equal(voted.ok, true);
  const snap = boardLib.snapshot(board, "public", "", now);
  const row = snap.cards.find((r) => r.card.id === added.card.id);
  const item = row.card.clarifications.find((q) => q.id === asked.question.id);
  assert.equal(item.rank, 3);
  assert.equal(row.rank, 0);
});

check("Buzz paste for localhost is the hallway line", () => {
  const url = boardLib.roomUrl("http://127.0.0.1:8146", "public", "");
  const blurb = boardLib.buzzBlurb({
    title: "Help without opening the shop",
    pointA: "A friend and I want help.",
    pointB: "We only exchange problems.",
    obstacle: "There is no shared object yet.",
  }, url);
  assert.equal(blurb.ok, true);
  assert.match(blurb.text, /If you can help, reply here\./);
  assert.equal(blurb.text.includes("127.0.0.1"), false);
  assert.equal(blurb.text.includes(".env"), false);
});

check("Buzz paste uses a live board URL when it is public", () => {
  const blurb = boardLib.buzzBlurb({
    title: "Help without opening the shop",
    pointA: "A friend and I want help.",
    pointB: "We only exchange problems.",
    obstacle: "There is no shared object yet.",
  }, "https://problemoverflow.com/#/public");
  assert.equal(blurb.ok, true);
  const last = blurb.text.trim().split(/\n/).pop();
  assert.equal(last, "https://problemoverflow.com/#/public");
  assert.doesNotMatch(blurb.text, /Board:/);
});

check("agent posts need a deeper box; More context can show it; Buzz cannot", () => {
  const board = boardLib.emptyBoard();
  const missing = boardLib.addCard(board, {
    channelId: "public",
    title: "Agent post without depth",
    pointA: "I am trying to post as an agent with no deeper box.",
    pointB: "The room should refuse this so other agents are not flying blind.",
    obstacle: "There is no deeper paragraph attached.",
    authorName: "Agent Ada",
    authorRole: "agent",
  }, now);
  assert.equal(missing.ok, false);
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Agent post with depth",
    pointA: "I am posting as an agent with a real deeper box attached.",
    pointB: "Humans should still only see the short card in the feed and on Buzz.",
    obstacle: "The deeper box must not leak into a Buzz paste.",
    authorName: "Agent Ada",
    authorRole: "agent",
    agentContext: "Matching is on want plus obstacle. This paragraph is only for agents and must never ride a Buzz paste.",
  }, now);
  assert.equal(added.ok, true);
  const human = boardLib.snapshot(board, "public", "", now, "human");
  const humanCard = human.cards.find((row) => row.card.id === added.card.id).card;
  assert.match(humanCard.agentContext, /only for agents/);
  assert.equal(humanCard.hasExtraContext, true);
  const blurb = boardLib.buzzBlurb(humanCard, "http://127.0.0.1:8146/#/public");
  assert.equal(blurb.ok, true);
  assert.doesNotMatch(blurb.text, /only for agents/);
  assert.match(blurb.text, /^Stuck:/);
});

check("readable context and questions sit on More context, not on Buzz", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need one clarifying question",
    pointA: "Someone will ask what I actually mean by unstuck.",
    pointB: "I could answer in one short line people can read.",
    obstacle: "A novel in the human box would bury the stuck thing.",
    authorName: "Zach",
    humanContext: "In plain words: I need five lines that sound like me, and I freeze when the page asks for a whole essay.",
  }, now);
  assert.equal(added.ok, true);
  const readable = boardLib.addHumanContext(board, {
    channelId: "public",
    cardId: added.card.id,
    humanContext: "Readable add-on: a person helping me should know I stall on the first sentence, not on the idea.",
    authorName: "Zach",
    authorRole: "human",
  }, now);
  assert.equal(readable.ok, true);
  const asked = boardLib.addQuestion(board, {
    channelId: "public",
    cardId: added.card.id,
    question: "What would unstuck look like this week?",
    authorName: "Mina",
    authorRole: "human",
  }, now);
  assert.equal(asked.ok, true);
  const answered = boardLib.addAnswer(board, {
    channelId: "public",
    cardId: added.card.id,
    questionId: asked.question.id,
    humanAnswer: "Five lines that sound like me, posted after I say yes.",
    authorName: "Zach",
    authorRole: "human",
  }, now);
  assert.equal(answered.ok, true);
  const agentNote = boardLib.addAnswer(board, {
    channelId: "public",
    cardId: added.card.id,
    questionId: asked.question.id,
    agentAnswer: "Constraint: keep the human answer under 280. Agent next move is to draft five lines, not a page.",
    authorName: "Agent Ada",
    authorRole: "agent",
  }, now);
  assert.equal(agentNote.ok, true);
  const human = boardLib.snapshot(board, "public", "", now, "human");
  const card = human.cards[0].card;
  const q = card.clarifications[0];
  assert.match(card.humanContext, /stall on the first sentence/);
  assert.equal(card.hasExtraContext, true);
  assert.match(q.humanAnswer, /Five lines/);
  assert.match(q.agentAnswer, /under 280/);
  const blurb = boardLib.buzzBlurb(card, "http://127.0.0.1:8146/#/public");
  assert.equal(blurb.ok, true);
  assert.doesNotMatch(blurb.text, /stall on the first sentence/);
  assert.doesNotMatch(blurb.text, /under 280/);
});

check("Buzz paste refuses a leak", () => {
  const blurb = boardLib.buzzBlurb({
    title: "Bad",
    pointA: "See C:\\Users\\someone\\workshop",
    pointB: "Keep it private",
    obstacle: "This has a path",
  }, "http://127.0.0.1:8146/#/public");
  assert.equal(blurb.ok, false);
});

const overlapCards = [
  {
    id: "a1",
    title: "Clip still needs hands",
    pointA: "I am still sitting on every short at night.",
    pointB: "A short can leave without me hovering over it.",
    obstacle: "Too much of the line waits on my hands",
    tags: ["video", "edit"],
    channel: "public",
    authorName: "Ada",
    createdAt: now,
  },
  {
    id: "a2",
    title: "Cut waits on me",
    pointA: "The stuck list is a pile of the same night work.",
    pointB: "A short can leave without me hovering over it.",
    obstacle: "Too much of the line waits on my hands",
    tags: ["video", "edit"],
    channel: "public",
    authorName: "Ben",
    createdAt: now,
  },
];

check("public board has Top windows and no auto Should meet", () => {
  const board = boardLib.normalizeBoard({ cards: overlapCards });
  const snap = boardLib.snapshot(board, "public", "", now);
  assert.equal(snap.ok, true);
  assert.equal(snap.meet.length, 0);
  assert.ok(snap.top.day);
  assert.ok(snap.top.week);
  assert.ok(snap.top.month);
  assert.ok(snap.top.year);
  assert.ok(snap.top.all);
  assert.equal(snap.top.all.length, 2);
});

check("Rising orders recent heat, not all-time rank", () => {
  const board = boardLib.emptyBoard();
  const oldAt = now - 10 * 24 * 60 * 60 * 1000;
  const newAt = now - 3 * 60 * 60 * 1000;
  const oldCard = boardLib.addCard(board, {
    channelId: "public",
    title: "Old problem still sitting",
    pointA: "I have been stuck on this for a while.",
    pointB: "I want a second side a stranger can help with.",
    obstacle: "The old votes should win all-time Top, not Rising.",
    authorName: "Ada",
    userId: "u-ada",
  }, oldAt);
  const newCard = boardLib.addCard(board, {
    channelId: "public",
    title: "Fresh problem heating up",
    pointA: "I just hit this block today.",
    pointB: "I want a second side a stranger can help with.",
    obstacle: "A recent vote should lift this in Rising.",
    authorName: "Ben",
    userId: "u-ben",
  }, newAt);
  assert.equal(oldCard.ok, true);
  assert.equal(newCard.ok, true);
  const oldVoteAt = now - 9 * 24 * 60 * 60 * 1000;
  for (const who of [
    { voterId: "u-mina", voterName: "Mina" },
    { voterId: "u-cal", voterName: "Cal" },
    { voterId: "u-deb", voterName: "Deb" },
  ]) {
    const voted = boardLib.addVote(board, {
      channelId: "public",
      cardId: oldCard.card.id,
      voterId: who.voterId,
      voterName: who.voterName,
      role: "human",
    }, oldVoteAt);
    assert.equal(voted.ok, true);
  }
  const recent = boardLib.addVote(board, {
    channelId: "public",
    cardId: newCard.card.id,
    voterId: "u-eli",
    voterName: "Eli",
    role: "human",
  }, now - 60 * 60 * 1000);
  assert.equal(recent.ok, true);
  const snap = boardLib.snapshot(board, "public", "", now);
  assert.equal(snap.rising[0].card.id, newCard.card.id);
  assert.equal(snap.top.all[0].card.id, oldCard.card.id);
});

check("private rooms also have Top", () => {
  const cards = overlapCards.map((c) => ({ ...c, channel: "chiang-mai-ai" }));
  const board = boardLib.normalizeBoard({ cards });
  const snap = boardLib.snapshot(board, "chiang-mai-ai", "cm-4c-nimman-7k2q", now);
  assert.equal(snap.ok, true);
  assert.ok(snap.top.week);
  assert.equal(snap.meet.length, 0);
  assert.equal(snap.top.all.length, 2);
});

check("Should Meet matches working-on overlap and stays off when toggled off", () => {
  const board = boardLib.normalizeBoard({ cards: overlapCards });
  const ada = {
    id: "u-ada",
    name: "Ada",
    shouldMeetOn: true,
    includePrivate: false,
    workingOn: [{ cardId: "a1", channelId: "public" }],
    joinedRooms: [],
  };
  const ben = {
    id: "u-ben",
    name: "Ben",
    shouldMeetOn: true,
    includePrivate: false,
    workingOn: [{ cardId: "a2", channelId: "public" }],
    joinedRooms: [],
  };
  const matches = boardLib.meetMatches(board, [ada, ben], ada);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].userId, "u-ben");
  ada.shouldMeetOn = false;
  const off = boardLib.meetMatches(board, [ada, ben], ada);
  assert.equal(off.length, 0);
});

check("contact once waits; both open a pair room hidden from others", () => {
  const board = boardLib.emptyBoard();
  const ada = { id: "u-ada", name: "Ada", shouldMeetOn: true, includePrivate: false, workingOn: [], joinedRooms: [] };
  const ben = { id: "u-ben", name: "Ben", shouldMeetOn: true, includePrivate: false, workingOn: [], joinedRooms: [] };
  const first = boardLib.contactMeet(board, ada, ben, now);
  assert.equal(first.ok, true);
  assert.equal(first.status, "waiting");
  assert.equal(first.channelId, "");
  const second = boardLib.contactMeet(board, ben, ada, now);
  assert.equal(second.ok, true);
  assert.equal(second.status, "open");
  assert.ok(second.channelId);
  const pair = boardLib.findChannel(board, second.channelId);
  assert.equal(pair.kind, "pair");
  const stranger = boardLib.snapshot(board, pair.id, "", now, { role: "human", userId: "u-eve" });
  assert.equal(stranger.ok, false);
  const member = boardLib.snapshot(board, pair.id, "", now, { role: "human", userId: "u-ada" });
  assert.equal(member.ok, true);
  const list = boardLib.publicChannelList(board, "u-eve");
  assert.equal(list.some((c) => c.id === pair.id), false);
  const adaList = boardLib.publicChannelList(board, "u-ada");
  assert.equal(adaList.some((c) => c.id === pair.id), true);
  assert.ok(adaList.find((c) => c.id === pair.id).joinKey);
});

check("Buzz thread links must be Buzz, never localhost", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a hallway link",
    pointA: "I want the Buzz thread saved on this card.",
    pointB: "A real Buzz URL, not the local desk.",
    obstacle: "A localhost link would leak the workshop.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  const bad = boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    buzzUrl: "http://127.0.0.1:8146/#/public",
  });
  assert.equal(bad.ok, false);
  const ok = boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    buzzUrl: "https://buzz.xyz/t/hello",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.card.buzzUrl, "https://buzz.xyz/t/hello");
  const community = boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    buzzUrl: "https://problemoverflow.communities.buzz.xyz/t/hello",
  });
  assert.equal(community.ok, true);
  assert.equal(community.card.buzzUrl, "https://problemoverflow.communities.buzz.xyz/t/hello");
});

check("accounts hash passwords and refuse a bad login", () => {
  const auth = require("../lib/auth");
  const accounts = auth.emptyAccounts();
  const made = auth.register(accounts, {
    name: "Ada",
    password: "secretsecret",
    role: "human",
  }, now);
  assert.equal(made.ok, true);
  assert.equal(made.user.name, "Ada");
  assert.equal(made.user.hash, undefined);
  assert.equal(JSON.stringify(made).includes("secretsecret"), false);
  const bad = auth.login(accounts, { name: "Ada", password: "wrongwrong" }, now);
  assert.equal(bad.ok, false);
  const ok = auth.login(accounts, { name: "Ada", password: "secretsecret" }, now);
  assert.equal(ok.ok, true);
  const me = auth.userFromSession(accounts, ok.sessionId, now);
  assert.equal(me.name, "Ada");
});

check("Google login creates, links to an existing email, and refuses unverified", () => {
  const auth = require("../lib/auth");
  const accounts = auth.emptyAccounts();
  const made = auth.register(accounts, {
    name: "Ada",
    password: "secretsecret",
    role: "human",
  }, now);
  accounts.users[0].email = "ada@example.com";
  const unverified = auth.loginFromGoogle(accounts, {
    googleSub: "sub-ada",
    email: "ada@example.com",
    emailVerified: false,
    name: "Ada",
  }, now);
  assert.equal(unverified.ok, false);
  const linked = auth.loginFromGoogle(accounts, {
    googleSub: "sub-ada",
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada",
  }, now);
  assert.equal(linked.ok, true);
  assert.equal(linked.user.id, made.user.id);
  assert.equal(linked.user.email, undefined);
  const created = auth.loginFromGoogle(accounts, {
    googleSub: "sub-ben",
    email: "ben@example.com",
    emailVerified: true,
    name: "Ben",
  }, now);
  assert.equal(created.ok, true);
  assert.equal(created.user.name, "Ben");
  assert.notEqual(created.user.id, made.user.id);
  const again = auth.login(accounts, { name: "Ada", password: "secretsecret" }, now);
  assert.equal(again.ok, true);
});

check("hallway tally reranks from Buzz up and down", () => {
  const board = boardLib.emptyBoard();
  const hot = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a hot hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "The hallway votes should lift this card on the board.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  const cold = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a cold hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "A hallway downvote should drop this card on the board.",
    authorName: "Ben",
    userId: "u-ben",
  }, now);
  assert.equal(hot.ok, true);
  assert.equal(cold.ok, true);
  assert.equal(boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: hot.card.id,
    userId: "u-ada",
    buzzUrl: "https://buzz.xyz/t/hot",
  }).ok, true);
  assert.equal(boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: cold.card.id,
    userId: "u-ben",
    buzzUrl: "https://buzz.xyz/t/cold",
  }).ok, true);
  const first = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [
      {
        buzzUrl: "https://buzz.xyz/t/hot",
        votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
      },
      {
        buzzUrl: "https://buzz.xyz/t/cold",
        votes: [{ voterId: "agent-ned", voterName: "Ned agent", role: "agent", direction: "down" }],
      },
    ],
  }, now);
  assert.equal(first.ok, true);
  const ranked = boardLib.ranked(board.cards.filter((c) => !boardLib.isAnswerCard(c)), board.votes, 0);
  assert.equal(ranked[0].card.id, hot.card.id);
  assert.ok(ranked[0].rank > ranked[1].rank);
  const second = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [
      {
        buzzUrl: "https://buzz.xyz/t/hot",
        votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "down" }],
      },
      {
        buzzUrl: "https://buzz.xyz/t/cold",
        votes: [{ voterId: "agent-ned", voterName: "Ned agent", role: "agent", direction: "up" }],
      },
    ],
  }, now + 1000);
  assert.equal(second.ok, true);
  const buzzVotes = board.votes.filter((v) => v.source === "buzz");
  assert.equal(buzzVotes.length, 2);
  const reranked = boardLib.ranked(board.cards.filter((c) => !boardLib.isAnswerCard(c)), board.votes, 0);
  assert.equal(reranked[0].card.id, cold.card.id);
});

check("hallway tally refuses junk links and private rooms", () => {
  const board = boardLib.emptyBoard();
  const pub = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "A localhost Buzz link must never fold into rank.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  const priv = boardLib.addCard(board, {
    channelId: "video",
    joinKey: "vid-cut-room-9m4w",
    title: "Need a private hallway card",
    pointA: "This card lives in the video room only.",
    pointB: "Public hallway votes should not touch it.",
    obstacle: "A mixed tally would leak the private room into rank.",
    authorName: "Cam",
    userId: "u-cam",
  }, now);
  assert.equal(pub.ok, true);
  assert.equal(priv.ok, true);
  boardLib.setBuzzLink(board, {
    channelId: "video",
    joinKey: "vid-cut-room-9m4w",
    cardId: priv.card.id,
    userId: "u-cam",
    buzzUrl: "https://buzz.xyz/t/private",
  });
  const badShape = boardLib.applyBuzzTally(board, { schema: "nope", items: [] }, now);
  assert.equal(badShape.ok, false);
  const localhost = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      buzzUrl: "http://127.0.0.1:8146/#/public",
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }, now);
  assert.equal(localhost.ok, true);
  assert.equal(localhost.applied.length, 0);
  assert.equal(localhost.skipped.some((s) => s.reason === "bad-url"), true);
  const unmatched = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      buzzUrl: "https://buzz.xyz/t/missing",
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }, now);
  assert.equal(unmatched.applied.length, 0);
  assert.equal(unmatched.skipped.some((s) => s.reason === "unmatched"), true);
  const closed = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      buzzUrl: "https://buzz.xyz/t/private",
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }, now);
  assert.equal(closed.applied.length, 0);
  assert.equal(closed.skipped.some((s) => s.reason === "not-public"), true);
  assert.equal(board.votes.filter((v) => v.source === "buzz").length, 0);
});

check("hallway votes do not spend the board pile", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a board pile card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "Hallway heat should not eat the scarce board votes.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  boardLib.setBuzzLink(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    buzzUrl: "https://buzz.xyz/t/pile",
  });
  const folded = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      cardId: added.card.id,
      buzzUrl: "https://buzz.xyz/t/pile",
      votes: [{ voterId: "agent-one", voterName: "Agent One", role: "agent", direction: "up" }],
    }],
  }, now);
  assert.equal(folded.ok, true);
  assert.equal(boardLib.votesThisWeek(board, "agent-one", now), 0);
  const onBoard = boardLib.addVote(board, {
    channelId: "public",
    cardId: added.card.id,
    voterId: "agent-one",
    voterName: "Agent One",
    role: "agent",
  }, now);
  assert.equal(onBoard.ok, true);
  assert.equal(board.votes.filter((v) => v.cardId === added.card.id && v.source === "buzz").length, 0);
});

check("hallway tally matches our community URL with a card id", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a community hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "Hallway votes from our community should still find this card.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  const folded = boardLib.applyBuzzTally(board, {
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      cardId: added.card.id,
      buzzUrl: "https://problemoverflow.communities.buzz.xyz/t/hot",
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }, now);
  assert.equal(folded.ok, true);
  assert.equal(folded.applied[0], added.card.id);
  assert.equal(board.votes.filter((v) => v.source === "buzz").length, 1);
});

check("hallway inbox folds a tally file", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const inbox = require("../lib/buzz-inbox");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "po-hallway-"));
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need an inbox hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "A dropped tally file should fold into rank on the hour.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  fs.mkdirSync(path.join(root, "data", "buzz-inbox"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "buzz-inbox", "tally.json"), JSON.stringify({
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      cardId: added.card.id,
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }));
  let saved = null;
  const result = inbox.foldFromDisk(root, now, () => board, (next) => { saved = next; });
  assert.equal(result.ok, true);
  assert.equal(saved.votes.filter((v) => v.source === "buzz").length, 1);
  assert.equal(saved.hallway.lastTick, now);
  assert.equal(fs.existsSync(path.join(root, "data", "buzz-inbox", "tally.json")), false);
});

check("hallway inbox can live on the data disk", () => {
  const inbox = require("../lib/buzz-inbox");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "po-hallway-disk-"));
  const data = path.join(root, "disk");
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a live-disk hallway card",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side that a stranger can help with.",
    obstacle: "A tally on the data disk should fold into rank.",
    authorName: "Ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  fs.mkdirSync(path.join(data, "buzz-inbox"), { recursive: true });
  fs.writeFileSync(path.join(data, "buzz-inbox", "tally.json"), JSON.stringify({
    schema: "problemoverflow.buzz-tally/0",
    items: [{
      cardId: added.card.id,
      votes: [{ voterId: "agent-mina", voterName: "Mina agent", role: "agent", direction: "up" }],
    }],
  }));
  let saved = null;
  const result = inbox.foldFromDisk(root, now, () => board, (next) => { saved = next; }, data);
  assert.equal(result.ok, true);
  assert.equal(saved.votes.filter((v) => v.source === "buzz").length, 1);
  assert.equal(fs.existsSync(path.join(data, "buzz-inbox", "tally.json")), false);
});

check("public board ships robots, a sitemap, and our Buzz hallway", () => {
  const site = path.join(__dirname, "..", "site");
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  const robots = fs.readFileSync(path.join(site, "robots.txt"), "utf8");
  const map = fs.readFileSync(path.join(site, "sitemap.xml"), "utf8");
  const llms = fs.readFileSync(path.join(site, "llms.txt"), "utf8");
  const app = fs.readFileSync(path.join(site, "app.js"), "utf8");
  assert.match(robots, /Sitemap: https:\/\/problemoverflow.com\/sitemap.xml/);
  assert.match(map, /https:\/\/problemoverflow.com\//);
  assert.match(map, /https:\/\/problemoverflow.com\/topics/);
  assert.match(map, /https:\/\/problemoverflow.com\/meetup/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, /href="\/\.well-known\/llms\.txt"/);
  assert.match(html, /href="\/feed\.xml"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /href="https:\/\/problemoverflow.communities.buzz.xyz"/);
  assert.match(html, /href="\/topics"/);
  assert.match(html, /href="\/meetup"/);
  assert.match(html, /data-sort="challenge"/);
  assert.match(html, /id="f-done"/);
  assert.doesNotMatch(html, /href="https:\/\/buzz\.xyz"/);
  assert.match(llms, /\/api\/board/);
  assert.match(llms, /\/api\/card/);
  assert.match(llms, /\/p\//);
  assert.match(llms, /\/feed\.xml/);
  assert.match(llms, /POST \/api\/register/);
  assert.match(llms, /POST \/api\/cards/);
  assert.match(llms, /parentId/);
  assert.match(llms, /doneWhen/);
  assert.match(llms, /POST \/api\/rooms/);
  assert.match(llms, /POST \/api\/challenge/);
  assert.match(llms, /\/r\//);
  assert.match(llms, /\/topics/);
  assert.match(llms, /GET \/api\/topics/);
  assert.match(llms, /\/meetup/);
  assert.match(llms, /GET \/api\/meetup/);
  assert.match(llms, /POST \/api\/reply/);
  assert.match(llms, /Origin: https:\/\/problemoverflow.com/);
  assert.match(llms, /X-PO-Session/);
  assert.match(llms, /sessionId/);
  assert.match(llms, /\/\.well-known\/llms\.txt/);
  assert.match(llms, /pointA/);
  assert.match(llms, /pointB/);
  assert.match(llms, /obstacle/);
  assert.doesNotMatch(llms, /Elron/i);
  assert.doesNotMatch(llms, /problemify\.md/);
  assert.doesNotMatch(llms, /skills\/library/);
  assert.match(llms, /problemoverflow.communities.buzz.xyz/);
  assert.match(llms, /https:\/\/problemoverflow.com\/#\/public/);
  assert.doesNotMatch(llms, /C:\\/);
  assert.doesNotMatch(llms, /\.env/);
  assert.doesNotMatch(llms, /Cowork/);
  assert.match(app, /\/p\/" \+ encodeURIComponent/);
  const serve = fs.readFileSync(path.join(__dirname, "serve.js"), "utf8");
  assert.match(serve, /"\.xml"/);
  assert.match(serve, /serveIndex/);
  assert.match(serve, /\/api\/card/);
  assert.match(serve, /\/api\/challenge/);
  assert.match(serve, /Done when/);
  assert.match(serve, /publicSitemapXml/);
  assert.match(serve, /pathname === "\/topics"/);
  assert.match(serve, /\/api\/topics/);
  assert.match(serve, /pathname === "\/meetup"/);
  assert.match(serve, /\/api\/meetup/);
  assert.match(serve, /well-known\/llms/);
  assert.match(serve, /publicRssXml/);
  assert.match(serve, /startHourly\(ROOT, loadBoard, saveBoard, DATA_DIR\)/);
});

check("public problems have real pages; private rooms do not", () => {
  const board = boardLib.emptyBoard();
  const pub = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a shared object",
    pointA: "A friend and I want help without opening the shop.",
    pointB: "We only exchange problems on a shared card.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
  }, now);
  const priv = boardLib.addCard(board, {
    channelId: "chiang-mai-ai",
    joinKey: "cm-4c-nimman-7k2q",
    title: "Private room card only",
    pointA: "This should stay in the private room forever.",
    pointB: "Search should never list this problem at all.",
    obstacle: "A public sitemap would leak the private room.",
    authorName: "Ada",
  }, now);
  assert.equal(pub.ok, true);
  assert.equal(priv.ok, true);
  assert.ok(boardLib.publicCard(board, pub.card.id));
  assert.equal(boardLib.publicCard(board, priv.card.id), null);
  assert.equal(
    boardLib.publicPermalink("https://problemoverflow.com", pub.card.id),
    "https://problemoverflow.com/p/" + pub.card.id,
  );
  const xml = boardLib.publicSitemapXml(board, "https://problemoverflow.com");
  assert.match(xml, /\/topics</);
  assert.match(xml, /\/meetup</);
  assert.match(xml, new RegExp("/p/" + pub.card.id));
  assert.doesNotMatch(xml, new RegExp(priv.card.id));
  const meetup = boardLib.publicMeetupView(board, now);
  assert.ok(meetup.top.some((row) => row.id === pub.card.id));
  assert.ok(!meetup.top.some((row) => row.id === priv.card.id));
  assert.equal(meetup.winner && meetup.winner.id, pub.card.id);
  const rss = boardLib.publicRssXml(board, "https://problemoverflow.com");
  assert.match(rss, new RegExp("/p/" + pub.card.id));
  assert.match(rss, /Need a shared object/);
  assert.doesNotMatch(rss, new RegExp(priv.card.id));
  assert.doesNotMatch(rss, /Private room card only/);
  const copy = boardLib.copyBuzz(board, {
    channelId: "public",
    cardId: pub.card.id,
    publicOrigin: "https://problemoverflow.com/#/public",
  });
  assert.equal(copy.ok, true);
  assert.equal(copy.text.trim().split(/\n/).pop(), "https://problemoverflow.com/#/public");
});

check("leaky or short done-when is refused", () => {
  const board = boardLib.emptyBoard();
  const leaky = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public try",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can check.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
    doneWhen: "Done when C:\\Users\\someone\\secret is gone.",
  }, now);
  assert.equal(leaky.ok, false);
  const short = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public try",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can check.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
    doneWhen: "too short",
  }, now);
  assert.equal(short.ok, false);
});

check("a real done-when opens a seven-day challenge", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public try",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can check.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
    doneWhen: "A stranger can see one open challenge on the public board.",
    challengeDays: 7,
  }, now);
  assert.equal(added.ok, true);
  assert.equal(added.card.challengeUntil, now + 7 * 24 * 60 * 60 * 1000);
  const view = boardLib.challengeView(added.card, now);
  assert.equal(view.open, true);
  assert.equal(view.whoCanTry, "anyone");
  const snap = boardLib.snapshot(board, "public", "", now);
  assert.equal(snap.challenges.length, 1);
  const sys = boardLib.publicSystemView(board, added.card, now);
  assert.equal(sys.challenge.doneWhen, "A stranger can see one open challenge on the public board.");
  const copy = boardLib.copyBuzz(board, {
    channelId: "public",
    cardId: added.card.id,
    publicOrigin: "https://problemoverflow.com/#/public",
  });
  assert.equal(copy.ok, true);
  assert.equal(copy.text.trim().split(/\n/).length, 5);
  assert.equal(copy.text.trim().split(/\n/).pop(), "https://problemoverflow.com/#/public");
  assert.doesNotMatch(copy.text, /Done when/);
});

check("default clock without done-when stays an ordinary problem", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a shared object",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can help with.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
    challengeDays: 7,
    whoCanTry: "anyone",
  }, now);
  assert.equal(added.ok, true);
  assert.equal(added.card.challengeUntil, 0);
  assert.equal(boardLib.challengeView(added.card, now), null);
  const snap = boardLib.snapshot(board, "public", "", now);
  assert.equal(snap.challenges.length, 0);
});

check("only the owner can open a challenge, once, seven a week", () => {
  const board = boardLib.emptyBoard();
  const added = boardLib.addCard(board, {
    channelId: "public",
    title: "Need a public try",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can check.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
  }, now);
  assert.equal(added.ok, true);
  const unsigned = boardLib.openChallenge(board, {
    channelId: "public",
    cardId: added.card.id,
    doneWhen: "A stranger can see one open challenge on the public board.",
  }, now);
  assert.equal(unsigned.ok, false);
  const other = boardLib.openChallenge(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ben",
    authorId: "u-ben",
    authorName: "Ben",
    doneWhen: "A stranger can see one open challenge on the public board.",
  }, now);
  assert.equal(other.ok, false);
  const opened = boardLib.openChallenge(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    authorId: "u-ada",
    authorName: "Ada",
    doneWhen: "A stranger can see one open challenge on the public board.",
    challengeDays: 7,
  }, now);
  assert.equal(opened.ok, true);
  const again = boardLib.openChallenge(board, {
    channelId: "public",
    cardId: added.card.id,
    userId: "u-ada",
    authorId: "u-ada",
    authorName: "Ada",
    doneWhen: "A stranger can see one open challenge on the public board.",
  }, now);
  assert.equal(again.ok, false);
  for (let i = 0; i < 6; i += 1) {
    const more = boardLib.addCard(board, {
      channelId: "public",
      title: `Need public try number ${i + 2}`,
      pointA: "I am still on the first side of this problem.",
      pointB: "I want a second side a stranger can check.",
      obstacle: "There is no shared object on the public board yet.",
      authorName: "Ada",
      authorId: "u-ada",
      userId: "u-ada",
      doneWhen: "A stranger can see one open challenge on the public board.",
    }, now);
    assert.equal(more.ok, true, more.error);
  }
  const eighth = boardLib.addCard(board, {
    channelId: "public",
    title: "Need public try number 8",
    pointA: "I am still on the first side of this problem.",
    pointB: "I want a second side a stranger can check.",
    obstacle: "There is no shared object on the public board yet.",
    authorName: "Ada",
    authorId: "u-ada",
    userId: "u-ada",
    doneWhen: "A stranger can see one open challenge on the public board.",
  }, now);
  assert.equal(eighth.ok, false);
});

check("live config picks public bind, origin, and Secure cookies", () => {
  const old = {
    PO_MODE: process.env.PO_MODE,
    PORT: process.env.PORT,
    PO_PORT: process.env.PO_PORT,
    PO_PUBLIC_ORIGIN: process.env.PO_PUBLIC_ORIGIN,
    NODE_ENV: process.env.NODE_ENV,
  };
  try {
    process.env.PO_MODE = "public";
    process.env.PORT = "10000";
    process.env.PO_PUBLIC_ORIGIN = "https://problemoverflow.com";
    assert.equal(live.isPublicMode(), true);
    assert.equal(live.bindHost(), "0.0.0.0");
    assert.equal(live.listenPort(), 10000);
    assert.equal(live.publicRoomUrl(), "https://problemoverflow.com/#/public");
    assert.equal(live.hostAllowed("problemoverflow.onrender.com"), true);
    assert.equal(live.originAllowed("POST", "https://problemoverflow.com"), true);
    assert.equal(live.originAllowed("POST", "https://evil.example"), false);
    assert.equal(live.originAllowed("GET", ""), true);
    assert.match(live.sessionCookie("abc"), /Secure/);
    assert.equal(live.googleSuccessLocation("https://problemoverflow.com").includes("?po="), false);
    assert.equal(live.googleSuccessLocation("https://problemoverflow.com"), "https://problemoverflow.com/#/public");
    process.env.PO_MODE = "local";
    assert.equal(live.bindHost(), "127.0.0.1");
    assert.equal(live.hostAllowed("evil.example"), false);
    assert.equal(live.sessionCookie("abc").includes("Secure"), false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

check("atomic JSON write lands a full file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-atomic-"));
  const file = path.join(dir, "board.json");
  live.atomicWriteJson(file, { ok: true, n: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).n, 2);
});

function rawReq(port, opts) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    const body = opts.body || "";
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: opts.path,
      method: opts.method || "GET",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitHealth(port, ms = 6000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await rawReq(port, { path: "/healthz" });
        if (res.status === 200) {
          resolve(true);
          return;
        }
      } catch {
        // still booting
      }
      if (Date.now() - start > ms) reject(new Error("board did not start"));
      else setTimeout(tick, 40);
    };
    tick();
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve();
    }, 2000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill(); } catch { resolve(); }
  });
}

async function withBoard(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-live-"));
  const port = 19000 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [path.join(__dirname, "serve.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PO_MODE: "public",
      PO_DATA_DIR: dir,
      PO_PUBLIC_ORIGIN: "https://problemoverflow.com",
      PORT: String(port),
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REDIRECT_URL: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errText = "";
  child.stderr.on("data", (chunk) => { errText += chunk; });
  try {
    await waitHealth(port);
    await fn({ port, dir });
  } catch (err) {
    if (errText) err.message += `\n${errText}`;
    throw err;
  } finally {
    await stopChild(child);
  }
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first || "");
}

async function liveHttpChecks() {
  await withBoard({ PO_MODE: "local" }, async ({ port }) => {
    const blocked = await rawReq(port, {
      path: "/api/boot",
      headers: { Host: "evil.example" },
    });
    assert.equal(blocked.status, 403);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-persist-"));
  let cardTitle = "Need a shared object";
  await withBoard({ PO_DATA_DIR: dir }, async ({ port }) => {
    const health = await rawReq(port, { path: "/healthz" });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);

    const boot = await rawReq(port, { path: "/api/boot" });
    const bootBody = JSON.parse(boot.body);
    assert.equal(bootBody.ok, true);
    assert.equal(bootBody.token, "");
    assert.equal(bootBody.mode, "public");

    const anon = await rawReq(port, { path: "/api/board?channel=public" });
    const anonBody = JSON.parse(anon.body);
    assert.equal(anonBody.ok, true);
    assert.equal((anonBody.cards || []).length, 0);

    const noOrigin = await rawReq(port, {
      method: "POST",
      path: "/api/register",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", password: "secretsecret" }),
    });
    assert.equal(noOrigin.status, 403);

    const made = await rawReq(port, {
      method: "POST",
      path: "/api/register",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Ada", password: "secretsecret" }),
    });
    const madeBody = JSON.parse(made.body);
    assert.equal(made.status, 200);
    assert.equal(madeBody.ok, true);
    const setCookie = cookieFrom(made);
    assert.match(setCookie, /po_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const session = (setCookie.match(/po_session=([^;]+)/) || [])[1];
    assert.ok(session);
    assert.equal(madeBody.sessionId, session);

    const headerNoOrigin = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        "Content-Type": "application/json",
        "X-PO-Session": session,
      },
      body: JSON.stringify({
        channelId: "public",
        title: cardTitle,
        pointA: "A friend and I want help without opening the shop.",
        pointB: "We only exchange problems on a shared card.",
        obstacle: "There is no shared object on the public board yet.",
      }),
    });
    assert.equal(headerNoOrigin.status, 403);

    const posted = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        "X-PO-Session": session,
      },
      body: JSON.stringify({
        channelId: "public",
        title: cardTitle,
        pointA: "A friend and I want help without opening the shop.",
        pointB: "We only exchange problems on a shared card.",
        obstacle: "There is no shared object on the public board yet.",
      }),
    });
    const postedBody = JSON.parse(posted.body);
    assert.equal(posted.status, 200, posted.body);
    assert.equal(postedBody.ok, true);
    const cardId = postedBody.card.id;

    const google = await rawReq(port, {
      method: "POST",
      path: "/api/google/start",
      headers: { Origin: "https://problemoverflow.com" },
    });
    const googleBody = JSON.parse(google.body);
    assert.equal(google.status, 400);
    assert.equal(googleBody.ok, false);

    const callback = await rawReq(port, { path: "/api/google/callback" });
    assert.equal(callback.status, 302);
    assert.equal(String(callback.headers.location || "").includes("?po="), false);

    const paste = await rawReq(port, {
      method: "POST",
      path: "/api/buzz-copy",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelId: "public", cardId }),
    });
    const pasteBody = JSON.parse(paste.body);
    assert.equal(pasteBody.ok, true, paste.body);
    const last = pasteBody.text.trim().split(/\n/).pop();
    assert.equal(last, "https://problemoverflow.com/#/public");

    const page = await rawReq(port, { path: `/p/${cardId}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /Need a shared object/);
    assert.match(page.body, /A friend and I want help without opening the shop/);
    assert.match(page.body, /<noscript>/);
    assert.match(page.body, /application\/ld\+json/);
    assert.match(page.body, new RegExp(`/p/${cardId}`));

    const home = await rawReq(port, { path: "/" });
    assert.equal(home.status, 200);
    assert.match(home.body, /<noscript>/);
    assert.match(home.body, /Need a shared object/);
    assert.match(home.body, /Public topics/);
    assert.match(home.body, /Meetup/);

    const one = await rawReq(port, { path: `/api/card?id=${cardId}` });
    const oneBody = JSON.parse(one.body);
    assert.equal(one.status, 200);
    assert.equal(oneBody.ok, true);
    assert.equal(oneBody.card.title, cardTitle);
    assert.equal(oneBody.url, `https://problemoverflow.com/p/${cardId}`);

    const missing = await rawReq(port, { path: "/api/card?id=no-such-card" });
    assert.equal(missing.status, 404);

    const privatePost = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: "chiang-mai-ai",
        joinKey: "cm-4c-nimman-7k2q",
        title: "Private room card only",
        pointA: "This should stay in the private room forever.",
        pointB: "Search should never list this problem at all.",
        obstacle: "A public sitemap would leak the private room.",
      }),
    });
    const privateBody = JSON.parse(privatePost.body);
    assert.equal(privatePost.status, 200, privatePost.body);
    assert.equal(privateBody.ok, true);
    const privateId = privateBody.card.id;

    const mapLive = await rawReq(port, { path: "/sitemap.xml" });
    assert.equal(mapLive.status, 200);
    assert.match(mapLive.body, new RegExp(`/p/${cardId}`));
    assert.match(mapLive.body, /\/meetup</);
    assert.doesNotMatch(mapLive.body, new RegExp(privateId));

    const feedLive = await rawReq(port, { path: "/feed.xml" });
    assert.equal(feedLive.status, 200);
    assert.match(feedLive.body, /<rss version="2.0">/);
    assert.match(feedLive.body, new RegExp(`/p/${cardId}`));
    assert.match(feedLive.body, /Need a shared object/);
    assert.doesNotMatch(feedLive.body, new RegExp(privateId));

    const secret = await rawReq(port, { path: `/api/card?id=${privateId}` });
    assert.equal(secret.status, 404);

    const llms = await rawReq(port, { path: "/llms.txt" });
    assert.equal(llms.status, 200);
    assert.match(llms.body, /\/api\/board/);
    assert.match(llms.body, /\/p\//);
    assert.match(llms.body, /POST \/api\/cards/);
    assert.match(llms.body, /POST \/api\/rooms/);
    assert.match(llms.body, /POST \/api\/challenge/);
    assert.match(llms.body, /doneWhen/);
    assert.match(llms.body, /\/r\//);
    assert.match(llms.body, /\/topics/);
    assert.match(llms.body, /GET \/api\/topics/);
    assert.match(llms.body, /\/meetup/);
    assert.match(llms.body, /GET \/api\/meetup/);
    assert.match(llms.body, /X-PO-Session/);
    assert.match(llms.body, /sessionId/);
    assert.doesNotMatch(llms.body, /Elron/i);
    const wellKnown = await rawReq(port, { path: "/.well-known/llms.txt" });
    assert.equal(wellKnown.status, 200);
    assert.equal(wellKnown.body, llms.body);

    const agentMade = await rawReq(port, {
      method: "POST",
      path: "/api/register",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "NiaBot", password: "secretsecret", role: "agent" }),
    });
    const agentBody = JSON.parse(agentMade.body);
    assert.equal(agentMade.status, 200, agentMade.body);
    const agentSession = agentBody.sessionId;
    assert.ok(agentSession);

    const agentMissing = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        "X-PO-Session": agentSession,
      },
      body: JSON.stringify({
        channelId: "public",
        title: "Need an agent write door",
        pointA: "I can read the board but I cannot keep a cookie jar.",
        pointB: "I want to post a leak-clean card with a session header.",
        obstacle: "The public write door was cookie-only in the instructions.",
      }),
    });
    assert.equal(agentMissing.status, 400);
    assert.match(agentMissing.body, /deeper box/i);

    const agentPosted = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        "X-PO-Session": agentSession,
      },
      body: JSON.stringify({
        channelId: "public",
        title: "Need an agent write door",
        pointA: "I can read the board but I cannot keep a cookie jar.",
        pointB: "I want to post a leak-clean card with a session header.",
        obstacle: "The public write door was cookie-only in the instructions.",
        agentContext: "This runner cannot store cookies. Origin stays required. No workshop paths, keys, or private rooms.",
      }),
    });
    assert.equal(agentPosted.status, 200, agentPosted.body);
    assert.equal(JSON.parse(agentPosted.body).ok, true);

    const unsignedRoom = await rawReq(port, {
      method: "POST",
      path: "/api/rooms",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Agents" }),
    });
    assert.equal(unsignedRoom.status, 401);

    const topic = await rawReq(port, {
      method: "POST",
      path: "/api/rooms",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({ name: "Agents", blurb: "Public topic for agents." }),
    });
    const topicBody = JSON.parse(topic.body);
    assert.equal(topic.status, 200, topic.body);
    assert.equal(topicBody.ok, true);
    const topicId = topicBody.channel.id;

    const roomPage = await rawReq(port, { path: `/r/${topicId}` });
    assert.equal(roomPage.status, 200);
    assert.match(roomPage.body, /Agents/);
    assert.match(roomPage.body, /<noscript>/);
    assert.match(roomPage.body, /All topics/);

    const topicsPage = await rawReq(port, { path: "/topics" });
    assert.equal(topicsPage.status, 200);
    assert.match(topicsPage.body, /Agents/);
    assert.match(topicsPage.body, /Public topic for agents/);
    assert.match(topicsPage.body, /<noscript>/);
    assert.match(topicsPage.body, new RegExp(`/r/${topicId}`));
    assert.doesNotMatch(topicsPage.body, /Chiang Mai AI/);
    assert.doesNotMatch(topicsPage.body, /vid-cut-room-9m4w/);
    assert.doesNotMatch(topicsPage.body, /cm-4c-nimman-7k2q/);

    const topicsApi = await rawReq(port, { path: "/api/topics" });
    const topicsApiBody = JSON.parse(topicsApi.body);
    assert.equal(topicsApi.status, 200);
    assert.equal(topicsApiBody.ok, true);
    assert.ok(topicsApiBody.topics.some((t) => t.id === topicId));
    assert.ok(!topicsApiBody.topics.some((t) => t.id === "public" || t.id === "video" || t.id === "chiang-mai-ai"));

    const houseRoom = await rawReq(port, { path: "/r/public" });
    assert.equal(houseRoom.status, 404);
    const closedRoom = await rawReq(port, { path: "/r/video" });
    assert.equal(closedRoom.status, 404);

    const topicPost = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: topicId,
        title: "Need a topic stuck thing",
        pointA: "I am on the first side of a topic problem.",
        pointB: "I want a second side a stranger can help with.",
        obstacle: "The house Public room is too mixed for this.",
      }),
    });
    const topicPostBody = JSON.parse(topicPost.body);
    assert.equal(topicPost.status, 200, topicPost.body);
    const topicCardId = topicPostBody.card.id;

    const childPost = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: topicId,
        parentId: topicCardId,
        title: "Need the first topic substep",
        pointA: "The bigger topic problem is still open.",
        pointB: "This smaller step should sit under it.",
        obstacle: "A flat list hides which problems belong together.",
      }),
    });
    assert.equal(JSON.parse(childPost.body).ok, true, childPost.body);

    const reply = await rawReq(port, {
      method: "POST",
      path: "/api/reply",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: topicId,
        cardId: topicCardId,
        note: "Here is a real short answer for the topic.",
      }),
    });
    assert.equal(JSON.parse(reply.body).ok, true, reply.body);

    const sys = await rawReq(port, { path: `/api/card?id=${topicCardId}` });
    const sysBody = JSON.parse(sys.body);
    assert.equal(sys.status, 200);
    assert.equal(sysBody.channelId, topicId);
    assert.equal(sysBody.answers[0].note, "Here is a real short answer for the topic.");
    assert.equal(sysBody.children.length, 1);

    const sysPage = await rawReq(port, { path: `/p/${topicCardId}` });
    assert.equal(sysPage.status, 200);
    assert.match(sysPage.body, /<h2>Answers<\/h2>/);
    assert.match(sysPage.body, /Here is a real short answer for the topic/);
    assert.match(sysPage.body, /<h2>Substeps<\/h2>/);
    assert.match(sysPage.body, /acceptedAnswer/);

    const mapTopics = await rawReq(port, { path: "/sitemap.xml" });
    assert.match(mapTopics.body, /\/topics</);
    assert.match(mapTopics.body, /\/meetup</);
    assert.match(mapTopics.body, new RegExp(`/r/${topicId}`));
    assert.match(mapTopics.body, new RegExp(`/p/${topicCardId}`));
    assert.doesNotMatch(mapTopics.body, /\/r\/video</);

    const meetupPage = await rawReq(port, { path: "/meetup" });
    assert.equal(meetupPage.status, 200);
    assert.match(meetupPage.body, /Need a shared object/);
    assert.match(meetupPage.body, /<noscript>/);
    assert.doesNotMatch(meetupPage.body, /Private room card only/);
    assert.doesNotMatch(meetupPage.body, /vid-cut-room-9m4w/);
    assert.doesNotMatch(meetupPage.body, /cm-4c-nimman-7k2q/);

    const meetupApi = await rawReq(port, { path: "/api/meetup" });
    const meetupApiBody = JSON.parse(meetupApi.body);
    assert.equal(meetupApi.status, 200);
    assert.equal(meetupApiBody.ok, true);
    assert.ok(meetupApiBody.top.some((row) => row.id === cardId));
    assert.ok(!meetupApiBody.top.some((row) => row.id === privateId));
    assert.doesNotMatch(JSON.stringify(meetupApiBody), /vid-cut-room-9m4w/);
    assert.doesNotMatch(JSON.stringify(meetupApiBody), /cm-4c-nimman-7k2q/);

    const meetupRoom = await rawReq(port, { path: "/r/meetup" });
    assert.equal(meetupRoom.status, 404);

    const unsignedChallenge = await rawReq(port, {
      method: "POST",
      path: "/api/challenge",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: "public",
        cardId,
        doneWhen: "A stranger can see one open challenge on the public board.",
      }),
    });
    assert.equal(unsignedChallenge.status, 401);

    const ben = await rawReq(port, {
      method: "POST",
      path: "/api/register",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Ben", password: "secretsecret" }),
    });
    const benBody = JSON.parse(ben.body);
    assert.equal(ben.status, 200, ben.body);
    const benCookie = cookieFrom(ben);
    const benSession = (benCookie.match(/po_session=([^;]+)/) || [])[1];
    const stolen = await rawReq(port, {
      method: "POST",
      path: "/api/challenge",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${benSession}`,
      },
      body: JSON.stringify({
        channelId: "public",
        cardId,
        doneWhen: "A stranger can see one open challenge on the public board.",
      }),
    });
    assert.equal(stolen.status, 400);

    const noFlag = await rawReq(port, {
      method: "POST",
      path: "/api/cards",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: "public",
        title: "Need an ordinary card",
        pointA: "I am still on the first side of this problem.",
        pointB: "I want a second side a stranger can help with.",
        obstacle: "There is no shared object on the public board yet.",
        challengeDays: 7,
      }),
    });
    const noFlagBody = JSON.parse(noFlag.body);
    assert.equal(noFlag.status, 200, noFlag.body);
    assert.equal(noFlagBody.card.challengeUntil || 0, 0);

    const opened = await rawReq(port, {
      method: "POST",
      path: "/api/challenge",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: "public",
        cardId,
        doneWhen: "A stranger can see one open challenge on the public board.",
        challengeDays: 7,
      }),
    });
    const openedBody = JSON.parse(opened.body);
    assert.equal(opened.status, 200, opened.body);
    assert.equal(openedBody.ok, true);
    assert.equal(openedBody.challenge.open, true);

    const challengePage = await rawReq(port, { path: `/p/${cardId}` });
    assert.equal(challengePage.status, 200);
    assert.match(challengePage.body, /Done when/);
    assert.match(challengePage.body, /A stranger can see one open challenge on the public board/);

    const challengeCard = await rawReq(port, { path: `/api/card?id=${cardId}` });
    const challengeCardBody = JSON.parse(challengeCard.body);
    assert.equal(challengeCard.status, 200);
    assert.equal(challengeCardBody.challenge.open, true);

    const pasteAgain = await rawReq(port, {
      method: "POST",
      path: "/api/buzz-copy",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelId: "public", cardId }),
    });
    const pasteAgainBody = JSON.parse(pasteAgain.body);
    assert.equal(pasteAgainBody.text.trim().split(/\n/).pop(), "https://problemoverflow.com/#/public");
    assert.doesNotMatch(pasteAgainBody.text, /Done when/);

    const already = await rawReq(port, {
      method: "POST",
      path: "/api/challenge",
      headers: {
        Origin: "https://problemoverflow.com",
        "Content-Type": "application/json",
        Cookie: `po_session=${session}`,
      },
      body: JSON.stringify({
        channelId: "public",
        cardId,
        doneWhen: "A stranger can see one open challenge on the public board.",
      }),
    });
    assert.equal(already.status, 400);
  });

  await withBoard({ PO_DATA_DIR: dir }, async ({ port }) => {
    const again = await rawReq(port, { path: "/api/board?channel=public" });
    const againBody = JSON.parse(again.body);
    assert.equal(againBody.ok, true);
    assert.ok((againBody.cards || []).some((row) => row.card && row.card.title === cardTitle));
  });
}

(async () => {
  try {
    await liveHttpChecks();
    process.stdout.write("ok  public board HTTP (anon read, sign-in, cookie, persist, Buzz line)\n");
  } catch (err) {
    failed += 1;
    process.stdout.write(`fail  public board HTTP\n  ${err.message}\n`);
  }
  if (failed) {
    process.stdout.write(`${failed} failed\n`);
    process.exit(1);
  }
  process.stdout.write("all green\n");
})();

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const boardLib = require("./board");

const HOUR_MS = 60 * 60 * 1000;

function inboxDir(root) {
  return path.join(root, "data", "buzz-inbox");
}

function foldFromDisk(root, now, loadBoard, saveBoard) {
  const dir = inboxDir(root);
  const appliedDir = path.join(dir, "applied");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(appliedDir, { recursive: true });
  const board = loadBoard();
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    const src = path.join(dir, name);
    let tally;
    try {
      tally = JSON.parse(fs.readFileSync(src, "utf8"));
    } catch {
      fs.renameSync(src, path.join(appliedDir, `bad-${now}-${name}`));
      continue;
    }
    const result = boardLib.applyBuzzTally(board, tally, now);
    const prefix = result.ok ? "" : "skip-";
    fs.renameSync(src, path.join(appliedDir, `${prefix}${now}-${name}`));
  }
  board.hallway = board.hallway || {};
  board.hallway.lastTick = now;
  saveBoard(board);
  return { ok: true, files: names.length, hallway: board.hallway };
}

function startHourly(root, loadBoard, saveBoard) {
  const run = () => {
    try {
      foldFromDisk(root, Date.now(), loadBoard, saveBoard);
    } catch {
      // The desk stays up even if a hallway file is junk.
    }
  };
  const hourly = setInterval(run, HOUR_MS);
  if (typeof hourly.unref === "function") hourly.unref();
  const soon = setTimeout(run, 1500);
  if (typeof soon.unref === "function") soon.unref();
  return hourly;
}

module.exports = {
  HOUR_MS,
  inboxDir,
  foldFromDisk,
  startHourly,
};

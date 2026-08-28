(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const roomsEl = $("rooms");
  const feedEl = $("feed");
  const hereEl = $("here");
  const meetEl = $("meet");
  const composer = $("composer");
  const moreCtx = $("more-ctx");
  const authBox = $("auth-box");
  const topRange = $("top-range");

  const state = {
    token: "",
    mode: "local",
    session: localStorage.getItem("po-session") || "",
    user: null,
    authMode: "login",
    google: false,
    channels: [],
    snap: null,
    matches: [],
    channelId: "public",
    joinKey: "",
    sort: "live",
    tagFilter: "",
    cardId: "",
  };

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function who() {
    if (!state.user) return { name: "", role: "human", voterId: "" };
    return {
      name: state.user.name,
      role: state.user.role,
      voterId: state.user.id,
    };
  }

  function ownsCard(card) {
    if (!state.user || !card) return false;
    if (card.authorId && card.authorId === state.user.id) return true;
    if (!card.authorId && card.authorName === state.user.name) return true;
    return false;
  }

  function untilLabel(until) {
    try {
      return new Date(until).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  function storedKey(channelId) {
    return sessionStorage.getItem("po-key-" + channelId) || "";
  }

  function rememberKey(channelId, key) {
    if (key) sessionStorage.setItem("po-key-" + channelId, key);
  }

  const SORTS = ["live", "rising", "top", "challenge"];
  const RANGES = ["day", "week", "month", "year", "all"];

  function channelIsPublic(channelId) {
    const ch = (state.channels || []).find((c) => c.id === channelId);
    if (!ch) return channelId === "public";
    return ch.visibility === "public" && ch.kind !== "pair";
  }

  function hashFromState(extra) {
    const opt = extra || {};
    const channelId = opt.channelId || state.channelId || "public";
    const joinKey = "joinKey" in opt ? opt.joinKey : state.joinKey;
    const sort = "sort" in opt ? opt.sort : state.sort;
    const range = "range" in opt ? opt.range : (topRange && topRange.value);
    const tag = "tag" in opt ? opt.tag : state.tagFilter;
    const cardId = "card" in opt ? opt.card : state.cardId;
    const params = new URLSearchParams();
    if (joinKey && !channelIsPublic(channelId)) params.set("k", joinKey);
    if (sort && sort !== "live") params.set("sort", sort);
    if (sort === "top" && range && range !== "week") params.set("range", range);
    if (tag) params.set("tag", tag);
    if (cardId) params.set("c", cardId);
    const q = params.toString();
    return q ? `#/${channelId}?${q}` : `#/${channelId}`;
  }

  function cardIdFromPath() {
    const m = String(location.pathname || "").match(/^\/p\/([A-Za-z0-9._-]+)$/);
    return m ? m[1] : "";
  }

  function roomIdFromPath() {
    const m = String(location.pathname || "").match(/^\/r\/([A-Za-z0-9._-]+)$/);
    return m ? m[1] : "";
  }

  function isPublicTopic(channelId) {
    const ch = (state.channels || []).find((c) => c.id === channelId);
    return Boolean(ch && ch.visibility === "public" && ch.kind === "topic");
  }

  function pagePath() {
    if (channelIsPublic(state.channelId) && state.cardId) {
      return "/p/" + encodeURIComponent(state.cardId);
    }
    if (isPublicTopic(state.channelId)) {
      return "/r/" + encodeURIComponent(state.channelId);
    }
    return "/";
  }

  function writeHash() {
    const hideCardInHash = channelIsPublic(state.channelId) && state.cardId;
    const next = hashFromState({ card: hideCardInHash ? "" : state.cardId });
    const dest = pagePath() + location.search + next;
    const cur = location.pathname + location.search + (location.hash || "#/public");
    if (cur === dest) return;
    history.replaceState(null, "", dest);
  }

  function parseHash() {
    const pathCard = cardIdFromPath();
    const pathRoom = roomIdFromPath();
    const raw = (location.hash || (pathRoom ? "#/" + pathRoom : "#/public")).replace(/^#\/?/, "");
    const [path, query] = raw.split("?");
    const params = new URLSearchParams(query || "");
    const channelId = path || pathRoom || "public";
    const key = params.get("k") || storedKey(channelId);
    if (params.get("k")) rememberKey(channelId, params.get("k"));
    if (pathCard) {
      state.channelId = pathRoom || channelId || "public";
      state.joinKey = storedKey(state.channelId);
      state.cardId = params.get("c") || pathCard;
    } else if (pathRoom) {
      state.channelId = pathRoom;
      state.joinKey = storedKey(pathRoom);
      state.cardId = params.get("c") || "";
    } else {
      state.channelId = channelId;
      state.joinKey = key;
      state.cardId = params.get("c") || "";
    }
    state.tagFilter = params.get("tag") || "";
    const sort = params.get("sort");
    state.sort = SORTS.includes(sort) ? sort : "live";
    const range = params.get("range");
    if (topRange) {
      if (RANGES.includes(range)) {
        topRange.value = range;
        localStorage.setItem("po-top-range", range);
      }
    }
  }

  function roomHref(channel) {
    const key = channel.joinKey || storedKey(channel.id);
    if (key) rememberKey(channel.id, key);
    const publicRoom = channel.visibility === "public" && channel.kind !== "pair";
    return hashFromState({
      channelId: channel.id,
      joinKey: publicRoom ? "" : key,
      card: "",
      tag: "",
    });
  }

  function goRoom(channel) {
    if (!channel) return;
    state.channelId = channel.id;
    state.joinKey = storedKey(channel.id);
    state.cardId = "";
    state.tagFilter = "";
    const dest = pagePath() + location.search + roomHref(channel);
    const cur = location.pathname + location.search + (location.hash || "");
    if (cur !== dest) history.pushState(null, "", dest);
    pingHere().then(loadBoard);
  }

  function openTopicBox() {
    const box = $("topic-box");
    if (!box) return;
    if (typeof box.showModal === "function") box.showModal();
    else box.setAttribute("open", "");
    const name = $("topic-name");
    if (name) name.focus();
  }

  function closeTopicBox() {
    const box = $("topic-box");
    if (!box) return;
    if (typeof box.close === "function" && box.open) box.close();
    else box.removeAttribute("open");
  }

  async function submitTopic(event) {
    event.preventDefault();
    if (!needAccount()) return;
    const data = new FormData(event.target);
    const result = await api("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        blurb: data.get("blurb"),
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "That topic did not open.", "bad");
      return;
    }
    closeTopicBox();
    event.target.reset();
    const boot = await api("/api/boot");
    if (boot.ok) state.channels = boot.channels || state.channels;
    renderRooms();
    goRoom(result.channel);
    setStatus("Topic is open.", "ok");
  }

  function roomLink() {
    return location.origin + hashFromState({ card: "", tag: "", sort: "live", range: "week" });
  }

  function cardLink(id) {
    if (channelIsPublic(state.channelId)) {
      return location.origin + "/p/" + encodeURIComponent(id);
    }
    return location.origin + hashFromState({ card: id, tag: "", sort: "live", range: "week" });
  }

  async function api(path, options) {
    const headers = { Accept: "application/json", ...(options && options.headers) };
    if (state.token) headers["X-PO-Token"] = state.token;
    if (state.session && state.mode !== "public") headers["X-PO-Session"] = state.session;
    const res = await fetch(path, { credentials: "same-origin", ...options, headers });
    return res.json();
  }

  function copyText(text, ok) {
    navigator.clipboard.writeText(text).then(
      () => setStatus(ok, "ok"),
      () => setStatus(text, "ok"),
    );
  }

  function syncAgentBox() {
    if (!moreCtx) return;
    if (who().role === "agent") moreCtx.setAttribute("open", "");
    else moreCtx.removeAttribute("open");
  }

  function renderAuth() {
    const openBtn = $("auth-open");
    const signed = $("signed-in");
    if (state.user) {
      openBtn.hidden = true;
      signed.hidden = false;
      $("who-label").textContent = `${state.user.name} · ${state.user.role}`;
    } else {
      openBtn.hidden = false;
      signed.hidden = true;
      $("who-label").textContent = "";
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const register = mode === "register";
    $("auth-title").textContent = register ? "Create an account" : "Log in";
    $("auth-submit").textContent = register ? "Create account" : "Log in";
    $("auth-toggle").textContent = register ? "Log in instead" : "Create an account";
    $("auth-role-wrap").hidden = !register;
    $("auth-pass").autocomplete = register ? "new-password" : "current-password";
  }

  function openAuth(mode) {
    setAuthMode(mode || "login");
    if (typeof authBox.showModal === "function") authBox.showModal();
    else authBox.setAttribute("open", "");
    $("auth-name").focus();
  }

  function closeAuth() {
    $("auth-pass").value = "";
    if (typeof authBox.close === "function" && authBox.open) authBox.close();
    else authBox.removeAttribute("open");
  }

  function needAccount() {
    if (state.user) return true;
    setStatus("Sign in to do that.", "bad");
    openAuth("login");
    return false;
  }

  function chevronHtml(id, label, score) {
    return `<div class="q-score">
      <button class="vote" type="button" data-vote="${esc(id)}" aria-label="Upvote ${esc(label)}">
        <svg viewBox="0 0 18 18" aria-hidden="true"><path fill="currentColor" d="M9 3.2 15.4 12H2.6L9 3.2z"/></svg>
      </button>
      <b>${esc(score)}</b>
    </div>`;
  }

  function cardHtml(row) {
    const card = row.card;
    const person = who();
    const tags = (card.tags || []).map((t) => {
      const on = state.tagFilter && state.tagFilter.toLowerCase() === String(t).toLowerCase() ? " on" : "";
      return `<button type="button" class="tag${on}" data-tag="${esc(t)}">${esc(t)}</button>`;
    }).join("");
    const replyRows = row.replies || [];
    const answers = `<div class="answers">
        <h3>Answers</h3>
        ${replyRows.length
          ? replyRows.map((r) => `
      <article class="reply answer">
        ${chevronHtml(r.id, "this answer", r.rank || 0)}
        <div>
          <p><strong>${esc(r.authorName)}</strong> · ${esc(r.authorRole)}</p>
          <p>${esc(r.note)}</p>
        </div>
      </article>`).join("")
          : `<p class="empty">No answers yet. Be the first.</p>`}
      </div>`;
    const nest = [
      row.parent ? `<p class="nest">Part of <button type="button" class="nest-link" data-jump="${esc(row.parent.id)}">${esc(row.parent.title)}</button></p>` : "",
      (row.children || []).length
        ? `<p class="nest">Substeps ${(row.children || []).map((c) => `<button type="button" class="nest-link" data-jump="${esc(c.id)}">${esc(c.title)}</button>`).join(" · ")}</p>`
        : "",
    ].join("");
    const qs = (card.clarifications || []).map((q) => {
      const answered = q.humanAnswer
        ? `<div class="answer-row">
            ${chevronHtml(q.id, "this answer", q.rank || 0)}
            <p><span class="lab">Answer</span> ${esc(q.humanAnswer)}</p>
          </div>`
        : `<form class="answer-box" data-answer="${esc(card.id)}" data-qid="${esc(q.id)}">
            <label>Short answer
              <textarea name="humanAnswer" required maxlength="280" placeholder="Short, for people."></textarea>
            </label>
            ${person.role === "agent" ? `<label>Deeper box
              <textarea name="agentAnswer" required placeholder="Longer, for agents. No paths or keys."></textarea>
            </label>` : ""}
            <button class="btn btn-ghost" type="submit">Answer</button>
          </form>`;
      return `
        <div class="clarify-item">
          <p><span class="lab">Q</span> ${esc(q.question)} <span class="when">· ${esc(q.askedBy)}</span></p>
          ${answered}
        </div>`;
    }).join("");
    const qsAgent = (card.clarifications || []).map((q) => `
        <div class="clarify-item">
          <p><span class="lab">Q</span> ${esc(q.question)} <span class="when">· ${esc(q.askedBy)}</span></p>
          ${q.agentAnswer
            ? `<pre class="ctx-ai">${esc(q.agentAnswer)}</pre>`
            : `<p class="empty">No AI answer yet.</p>`}
        </div>`).join("");
    const aiFirst = person.role === "agent";
    const extra = card.hasExtraContext || Boolean(String(card.humanContext || "").trim() || String(card.agentContext || "").trim());
    const excerpt = card.obstacle || card.pointA || "";
    const notes = replyRows.length + ((card.clarifications || []).filter((q) => q.humanAnswer).length);

    const working = (state.user && (state.user.workingOn || []).some((w) => w.cardId === card.id));
    const buzzLink = card.buzzUrl
      ? `<p><a href="${esc(card.buzzUrl)}" target="_blank" rel="noopener">Buzz thread</a></p>`
      : "";
    return `
      <article class="q" data-card="${esc(card.id)}">
        <div class="q-score">
          <button class="vote" type="button" data-vote="${esc(card.id)}" aria-label="Upvote ${esc(card.title)}">
            <svg viewBox="0 0 18 18" aria-hidden="true"><path fill="currentColor" d="M9 3.2 15.4 12H2.6L9 3.2z"/></svg>
          </button>
          <b>${esc(row.rank)}</b>
        </div>
        <div class="q-main">
          <h2>
            <button class="q-title" type="button" data-open="${esc(card.id)}" aria-expanded="false">${esc(card.title)}</button>
            ${row.challenge ? `<span class="challenge-badge${row.challenge.open ? "" : " closed"}">${row.challenge.open ? "Challenge" : "Closed"}</span>` : ""}
          </h2>
          <p class="q-excerpt">${esc(excerpt)}</p>
          ${row.challenge ? `<p class="challenge-line">Done when ${esc(row.challenge.doneWhen)} · ${row.challenge.open ? "open" : "closed"} until ${esc(untilLabel(row.challenge.until))}</p>` : ""}
          <div class="q-meta">
            ${tags}
            <span>${esc(card.authorName)} · ${esc(card.authorRole)}</span>
            <span>${notes} ${notes === 1 ? "answer" : "answers"}</span>
          </div>
          <div class="q-tools">
            <button class="btn btn-ghost" type="button" data-context="${esc(card.id)}">More context</button>
            <button class="btn btn-ghost" type="button" data-question="${esc(card.id)}">Question</button>
          </div>
          <div class="q-thread">
            <p>${esc(card.pointA)}</p>
            <p>${esc(card.pointB)}</p>
            <p>${esc(card.obstacle)}</p>
            ${card.offer ? `<p><span class="lab">Offer</span> ${esc(card.offer)}</p>` : ""}
            ${card.ask ? `<p><span class="lab">Need</span> ${esc(card.ask)}</p>` : ""}
            ${nest}
            ${answers}
            <div class="ctx${aiFirst ? " tab-ai" : ""}" data-extra="${extra ? "1" : "0"}">
              <div class="ctx-tabs">
                <button type="button" class="${aiFirst ? "" : "on"}" data-ctx-tab="human">Human</button>
                <button type="button" class="${aiFirst ? "on" : ""}" data-ctx-tab="ai">AI</button>
              </div>
              <div class="ctx-human-wrap">
                ${(card.humanContext || "").trim()
                  ? `<p class="ctx-prose">${esc(card.humanContext)}</p>`
                  : `<p>${esc(card.pointA)}</p><p>${esc(card.pointB)}</p><p>${esc(card.obstacle)}</p>`}
                ${person.name && !(card.humanContext || "").trim() ? `<form class="ctx-add" data-human-ctx="${esc(card.id)}">
                  <label>Readable context
                    <textarea name="humanContext" required maxlength="1200" placeholder="Plain language. What a person needs to actually help."></textarea>
                  </label>
                  <button class="btn btn-ghost" type="submit">Save readable context</button>
                </form>` : ""}
                ${qs ? `<div class="clarify">${qs}</div>` : ""}
              </div>
              <div class="ctx-ai-wrap">
                ${(card.agentContext || "").trim()
                  ? `<pre class="ctx-ai">${esc(card.agentContext)}</pre>`
                  : `<p class="empty">No AI context yet.</p>`}
                ${person.role === "agent" ? `<form class="ctx-add" data-agent-ctx="${esc(card.id)}">
                  <label>Dense context
                    <textarea name="agentContext" required maxlength="4000" placeholder="Compressed. Constraints, failed attempts, what would change the next move."></textarea>
                  </label>
                  <button class="btn btn-ghost" type="submit">Save AI context</button>
                </form>` : ""}
                ${qsAgent ? `<div class="clarify">${qsAgent}</div>` : ""}
              </div>
            </div>
            <div class="actions">
              <button class="btn btn-ghost" type="button" data-copy-card="${esc(card.id)}">Copy link</button>
              <button class="btn btn-ghost" type="button" data-buzz="${esc(card.id)}">Copy for Buzz</button>
              ${state.user ? `<button class="btn btn-ghost" type="button" data-work="${esc(card.id)}">${working ? "Working on this ✓" : "Working on this"}</button>` : ""}
            </div>
            ${buzzLink}
            ${state.user ? `<form class="buzz-link" data-buzz-link="${esc(card.id)}">
              <label>Buzz thread
                <input name="buzzUrl" maxlength="300" placeholder="https://problemoverflow.communities.buzz.xyz/…" value="${esc(card.buzzUrl || "")}">
              </label>
              <button class="btn btn-ghost" type="submit">Save link</button>
            </form>` : ""}
            <form class="ask-box" data-ask="${esc(card.id)}">
              <label>Clarifying question
                <textarea name="question" required maxlength="280" placeholder="One question that changes what you'd do."></textarea>
              </label>
              <button class="btn btn-ghost" type="submit">Ask</button>
            </form>
            <form class="reply-box" data-reply="${esc(card.id)}">
              <label>Answer
                <textarea name="note" required maxlength="280" placeholder="A real answer, not a maybe."></textarea>
              </label>
              <button class="btn btn-ghost" type="submit">Answer</button>
            </form>
            ${state.user && ownsCard(card) && !(row.challenge && row.challenge.open) ? `<form class="challenge-box" data-challenge="${esc(card.id)}">
              <label>Done when
                <textarea name="doneWhen" required maxlength="160" placeholder="One sentence a stranger can check."></textarea>
              </label>
              <label>Clock
                <select name="challengeDays">
                  <option value="1">Today</option>
                  <option value="7" selected>This week</option>
                </select>
              </label>
              <label>Who can try
                <select name="whoCanTry">
                  <option value="anyone">Anyone signed in</option>
                  <option value="this-room">This room</option>
                </select>
              </label>
              <button class="btn btn-ghost" type="submit">Make this a challenge</button>
            </form>` : ""}
          </div>
        </div>
      </article>`;
  }

  function renderRooms() {
    const house = ["public", "chiang-mai-ai", "video"];
    const ranked = [...(state.channels || [])].sort((a, b) => {
      const slot = (c) => {
        const i = house.indexOf(c.id);
        if (i >= 0) return i;
        if (c.kind === "topic") return 50;
        if (c.kind === "pair") return 90;
        return 70;
      };
      const d = slot(a) - slot(b);
      if (d) return d;
      return String(a.name).localeCompare(String(b.name));
    });
    const buttons = ranked.map((c) => {
      const locked = c.visibility !== "public";
      const on = c.id === state.channelId ? " on" : "";
      return `<button class="room${on}" type="button" data-room="${esc(c.id)}" title="${esc(c.blurb)}">
        ${esc(c.name)}${c.kind === "pair" ? ` <span class="lock">you two</span>` : locked ? ` <span class="lock">private</span>` : ""}
      </button>`;
    });
    if (state.user) {
      buttons.push(`<button class="room room-new" type="button" data-new-topic>New topic</button>`);
    }
    roomsEl.innerHTML = buttons.join("");
  }

  function feedRows(snap) {
    let rows;
    if (state.sort === "rising") rows = snap.rising || [];
    else if (state.sort === "challenge") rows = snap.challenges || [];
    else if (state.sort === "top") {
      const range = (topRange && topRange.value) || "week";
      rows = (snap.top && snap.top[range]) || [];
    } else rows = snap.live || [];
    if (!state.tagFilter) {
      if (state.cardId && !rows.some((r) => r.card && r.card.id === state.cardId)) {
        const pinned = findRow(state.cardId);
        if (pinned) return [pinned, ...rows];
      }
      return rows;
    }
    const want = state.tagFilter.toLowerCase();
    const filtered = rows.filter((row) => (row.card.tags || []).some((t) => String(t).toLowerCase() === want));
    if (state.cardId && !filtered.some((r) => r.card && r.card.id === state.cardId)) {
      const pinned = findRow(state.cardId);
      if (pinned) return [pinned, ...filtered];
    }
    return filtered;
  }

  function renderTagFilter() {
    const el = $("tag-filter");
    if (!el) return;
    if (!state.tagFilter) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `Showing <strong>${esc(state.tagFilter)}</strong> <button type="button" class="tag-clear" data-clear-tag>Show all</button>`;
  }

  function syncSortUi() {
    document.querySelectorAll(".sort [data-sort]").forEach((el) => {
      el.classList.toggle("on", el.dataset.sort === state.sort);
    });
    const lab = document.querySelector(".top-range-lab");
    const showTop = state.sort === "top";
    if (topRange) topRange.hidden = !showTop;
    if (lab) lab.hidden = !showTop;
  }

  function cardEl(id) {
    return [...feedEl.querySelectorAll(".q")].find((el) => el.getAttribute("data-card") === id) || null;
  }

  function findRow(id) {
    const snap = state.snap;
    if (!snap || !snap.ok) return null;
    const pools = [snap.live, snap.rising, snap.challenges, snap.cards, snap.top && snap.top.all];
    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      const row = pool.find((r) => r.card && r.card.id === id);
      if (row) return row;
    }
    return null;
  }

  function applyOpenFromHash() {
    const id = state.cardId;
    if (!id) return;
    let art = cardEl(id);
    if (!art) {
      const row = findRow(id);
      if (row) {
        feedEl.insertAdjacentHTML("afterbegin", cardHtml(row));
        art = cardEl(id);
      }
    }
    if (art) {
      openCard(art, { silent: true });
      art.scrollIntoView({ block: "nearest" });
    }
  }

  function emptyFeedHtml() {
    if (state.tagFilter) {
      return `<div class="empty-board"><p class="empty">Nothing tagged ${esc(state.tagFilter)} in this room.</p><p class="empty-hint"><button type="button" class="linkish" data-clear-tag>Show all problems</button></p></div>`;
    }
    if (state.sort === "challenge") {
      return `<div class="empty-board"><p class="empty">No open challenges here.</p><p class="empty-hint">A challenge is optional. Most problems stay ordinary.</p></div>`;
    }
    return `<div class="empty-board"><p class="empty">No problems here yet.</p><p class="empty-hint">Ask a problem to put the stuck thing on the board. Anyone can read. Sign in to post or vote.</p></div>`;
  }

  function renderMeet() {
    const controls = $("meet-controls");
    if (!state.user) {
      controls.hidden = true;
      meetEl.innerHTML = `<p class="empty">Sign in to turn on Should Meet.</p>`;
      return;
    }
    controls.hidden = false;
    $("meet-on").checked = Boolean(state.user.shouldMeetOn);
    $("meet-private").checked = Boolean(state.user.includePrivate);
    $("meet-private").disabled = !state.user.shouldMeetOn;
    if (!state.user.shouldMeetOn) {
      meetEl.innerHTML = `<p class="empty">Turn it on, mark the problems you're working on, then refresh.</p>`;
      return;
    }
    const matches = state.matches || [];
    meetEl.innerHTML = matches.length
      ? matches.map((p) => {
        const titles = (p.hits || []).map((h) => esc(h.a.title) + (h.same ? "" : ` · ${esc(h.b.title)}`)).join("<br>");
        let action = `<button class="btn btn-ghost" type="button" data-contact="${esc(p.userId)}">Contact</button>`;
        if (p.status === "waiting") action = `<p class="empty">Waiting on them.</p>`;
        if (p.status === "theirs") action = `<button class="btn btn-ghost" type="button" data-contact="${esc(p.userId)}">They want to talk</button>`;
        if (p.status === "open" && p.channelId) {
          action = `<button class="btn btn-ghost" type="button" data-pair="${esc(p.channelId)}" data-key="${esc(p.joinKey)}">Open your room</button>`;
        }
        return `<article class="pair"><p><strong>${esc(p.name)}</strong></p><p>${titles}</p>${action}</article>`;
      }).join("")
      : `<p class="empty">No matches yet. Mark a few problems, then refresh.</p>`;
  }

  function renderFeed() {
    const snap = state.snap;
    syncSortUi();
    if (!snap || !snap.ok) {
      feedEl.innerHTML = `<p class="empty">${esc((snap && snap.error) || "This room needs its private link.")}</p>`;
      hereEl.innerHTML = "";
      renderMeet();
      const fold = $("hallway-fold");
      if (fold) fold.textContent = "";
      return;
    }
    $("room-name").textContent = snap.channel.name;
    $("room-blurb").textContent = snap.channel.blurb;
    const rows = feedRows(snap);
    renderTagFilter();
    feedEl.innerHTML = rows.length
      ? rows.map(cardHtml).join("")
      : emptyFeedHtml();
    applyOpenFromHash();

    const here = snap.here || [];
    hereEl.innerHTML = here.length
      ? here.map((p) => `<div class="person"><span class="dot" aria-hidden="true"></span><span>${esc(p.name)}</span><span class="role">${esc(p.role)}</span></div>`).join("")
      : `<p class="empty">Nobody pinged this room yet.</p>`;
    renderMeet();
    const fold = $("hallway-fold");
    if (fold) {
      const hallway = snap.hallway || {};
      const at = hallway.lastAt || hallway.lastTick;
      fold.textContent = at
        ? `Last hallway fold: ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        : "Hallway votes fold in every hour.";
    }
    fillParentSelect();
  }

  async function pingHere() {
    const person = who();
    if (!person.name) return;
    await api("/api/here", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
      }),
    });
  }

  async function loadBoard() {
    const q = new URLSearchParams({
      channel: state.channelId,
      role: who().role,
    });
    if (state.joinKey) q.set("k", state.joinKey);
    const snap = await api("/api/board?" + q.toString());
    state.snap = snap;
    if (snap.channels) {
      state.channels = snap.channels;
      snap.channels.forEach((c) => {
        if (c.joinKey) rememberKey(c.id, c.joinKey);
      });
    }
    renderRooms();
    renderFeed();
    if (!snap.ok) setStatus(snap.error || "Closed room.", "bad");
    else if (!statusEl.classList.contains("ok") && !statusEl.classList.contains("bad")) setStatus("");
    await loadMeet();
  }

  async function loadMeet() {
    if (!state.user) {
      state.matches = [];
      renderMeet();
      return;
    }
    const result = await api("/api/meet");
    if (result.ok) {
      if (result.user) state.user = result.user;
      state.matches = result.matches || [];
      (state.matches).forEach((p) => {
        if (p.joinKey && p.channelId) rememberKey(p.channelId, p.joinKey);
      });
    } else {
      state.matches = [];
    }
    renderMeet();
  }

  async function saveMeetSettings() {
    if (!needAccount()) return;
    const result = await api("/api/meet-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shouldMeetOn: $("meet-on").checked,
        includePrivate: $("meet-private").checked,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not save Should Meet.", "bad");
      return;
    }
    state.user = result.user;
    await loadMeet();
  }

  async function toggleWorking(cardId) {
    if (!needAccount()) return;
    const result = await api("/api/working-on", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not mark that.", "bad");
      return;
    }
    if (result.user) state.user = result.user;
    setStatus("Updated what you're working on.", "ok");
    renderFeed();
    await loadMeet();
  }

  async function contactMatch(userId) {
    if (!needAccount()) return;
    const result = await api("/api/meet-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not contact.", "bad");
      return;
    }
    if (result.status === "open" && result.channelId) {
      rememberKey(result.channelId, result.joinKey);
      setStatus("You both said yes. Your room is open.", "ok");
      location.hash = `#/${result.channelId}?k=${encodeURIComponent(result.joinKey)}`;
      return;
    }
    setStatus(result.status === "waiting" ? "Waiting on them." : "Contact sent.", "ok");
    await loadMeet();
  }

  async function saveBuzzLink(cardId, buzzUrl) {
    if (!needAccount()) return;
    const result = await api("/api/buzz-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        buzzUrl,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not save that link.", "bad");
      return;
    }
    setStatus("Buzz thread saved.", "ok");
    await loadBoard();
  }

  async function startGoogle() {
    const result = await api("/api/google/start", { method: "POST" });
    if (!result.ok) {
      setStatus(result.error || "Google sign-in is not set up yet.", "bad");
      return;
    }
    location.href = result.url;
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const po = params.get("po");
    if (po) {
      state.session = po;
      localStorage.setItem("po-session", po);
      history.replaceState({}, "", location.pathname + location.hash);
    }
    if (params.get("google") === "fail") {
      history.replaceState({}, "", location.pathname + location.hash);
      setStatus("Google sign-in did not work. Try a name and password.", "bad");
    }
    const savedRange = localStorage.getItem("po-top-range");
    if (savedRange && ["day", "week", "month", "year", "all"].includes(savedRange)) {
      topRange.value = savedRange;
    }
    parseHash();
    const boot = await api("/api/boot");
    if (!boot.ok) {
      setStatus("The board is not up.", "bad");
      return;
    }
    state.token = boot.token || "";
    state.mode = boot.mode || "local";
    state.google = Boolean(boot.google);
    state.channels = boot.channels || [];
    if (boot.user) state.user = boot.user;
    else if (state.session) {
      state.session = "";
      localStorage.removeItem("po-session");
    }
    const pathCard = cardIdFromPath();
    if (pathCard) {
      const one = await api("/api/card?id=" + encodeURIComponent(pathCard));
      if (one.ok && one.channelId) {
        state.channelId = one.channelId;
        state.cardId = one.card && one.card.id ? one.card.id : pathCard;
        state.joinKey = storedKey(state.channelId);
      }
    }
    writeHash();
    renderAuth();
    renderRooms();
    syncAgentBox();
    await pingHere();
    await loadBoard();
  }

  function fillParentSelect() {
    const sel = $("f-parent");
    if (!sel) return;
    const keep = sel.value;
    const rows = ((state.snap && state.snap.cards) || []).filter((r) => r.card && r.card.id);
    sel.innerHTML = `<option value="">None — this is a top problem</option>` +
      rows.map((r) => `<option value="${esc(r.card.id)}">${esc(r.card.title)}</option>`).join("");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function jumpToCard(id) {
    if (!id) return;
    state.cardId = id;
    state.tagFilter = "";
    writeHash();
    renderTagFilter();
    let art = cardEl(id);
    if (!art) {
      const row = findRow(id);
      if (row) {
        feedEl.insertAdjacentHTML("afterbegin", cardHtml(row));
        art = cardEl(id);
      }
    }
    if (art) {
      openCard(art);
      art.scrollIntoView({ block: "nearest" });
    }
  }

  async function postCard(form) {
    if (!needAccount()) return;
    const data = new FormData(form);
    const result = await api("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        title: data.get("title"),
        pointA: data.get("pointA"),
        pointB: data.get("pointB"),
        obstacle: data.get("obstacle"),
        offer: data.get("offer"),
        ask: data.get("ask"),
        tags: data.get("tags"),
        humanContext: data.get("humanContext"),
        agentContext: data.get("agentContext"),
        parentId: data.get("parentId"),
        doneWhen: String(data.get("doneWhen") || "").trim(),
        challengeDays: data.get("challengeDays"),
        whoCanTry: data.get("whoCanTry"),
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not post.", "bad");
      return;
    }
    form.reset();
    syncAgentBox();
    const panel = $("ask-panel");
    if (panel) panel.open = false;
    if (result.card && result.card.id) {
      state.cardId = result.card.id;
      writeHash();
    }
    setStatus("Posted. Copy for Buzz when you want it in the hallway.", "ok");
    await loadBoard();
  }

  async function openChallenge(form) {
    if (!needAccount()) return;
    const data = new FormData(form);
    const result = await api("/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId: form.dataset.challenge,
        doneWhen: data.get("doneWhen"),
        challengeDays: data.get("challengeDays"),
        whoCanTry: data.get("whoCanTry"),
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not open that challenge.", "bad");
      return;
    }
    setStatus("Challenge is open. People try by posting one answer.", "ok");
    await loadBoard();
  }

  async function vote(cardId) {
    if (!needAccount()) return;
    const result = await api("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not vote.", "bad");
      return;
    }
    setStatus("Voted.", "ok");
    await loadBoard();
  }

  async function copyBuzz(cardId) {
    const result = await api("/api/buzz-copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        origin: roomLink(),
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not copy.", "bad");
      return;
    }
    copyText(result.text, "Copied for Buzz. Nothing posted until you paste it there.");
  }

  async function ask(cardId, question) {
    if (!needAccount()) return;
    const result = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        question,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not ask.", "bad");
      return;
    }
    setStatus("Asked.", "ok");
    await loadBoard();
  }

  async function answer(cardId, questionId, form) {
    if (!needAccount()) return;
    const data = new FormData(form);
    const result = await api("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        questionId,
        humanAnswer: data.get("humanAnswer"),
        agentAnswer: data.get("agentAnswer") || "",
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not answer.", "bad");
      return;
    }
    setStatus("Answered.", "ok");
    await loadBoard();
  }

  async function reply(cardId, note) {
    if (!needAccount()) return;
    const result = await api("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        note,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not reply.", "bad");
      return;
    }
    setStatus("Replied.", "ok");
    await loadBoard();
  }

  async function saveHumanContext(cardId, text) {
    if (!needAccount()) return;
    const result = await api("/api/human-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        humanContext: text,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not save readable context.", "bad");
      return;
    }
    setStatus("Readable context saved.", "ok");
    await loadBoard();
  }

  async function saveAgentContext(cardId, text) {
    if (!needAccount()) return;
    const result = await api("/api/agent-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.channelId,
        joinKey: state.joinKey,
        cardId,
        agentContext: text,
      }),
    });
    if (!result.ok) {
      setStatus(result.error || "Could not save AI context.", "bad");
      return;
    }
    setStatus("AI context saved.", "ok");
    await loadBoard();
  }

  function openCard(art, opts) {
    if (!art) return;
    feedEl.querySelectorAll(".q.open").forEach((el) => {
      if (el === art) return;
      el.classList.remove("open");
      const other = el.querySelector("[data-open]");
      if (other) other.setAttribute("aria-expanded", "false");
    });
    art.classList.add("open");
    const t = art.querySelector("[data-open]");
    if (t) t.setAttribute("aria-expanded", "true");
    state.cardId = art.getAttribute("data-card") || "";
    if (!(opts && opts.silent)) writeHash();
  }

  async function submitAuth(event) {
    event.preventDefault();
    const name = $("auth-name").value.trim();
    const password = $("auth-pass").value;
    const role = $("auth-role").value;
    const path = state.authMode === "register" ? "/api/register" : "/api/login";
    const result = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password, role }),
    });
    $("auth-pass").value = "";
    if (!result.ok) {
      setStatus(result.error || "Could not sign in.", "bad");
      return;
    }
    state.session = result.sessionId;
    state.user = result.user;
    localStorage.setItem("po-session", result.sessionId);
    closeAuth();
    renderAuth();
    syncAgentBox();
    setStatus("Signed in.", "ok");
    await pingHere();
    await loadBoard();
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    state.session = "";
    state.user = null;
    localStorage.removeItem("po-session");
    renderAuth();
    syncAgentBox();
    setStatus("Signed out.", "ok");
    await loadBoard();
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    postCard(event.target);
  });

  roomsEl.addEventListener("click", (event) => {
    const make = event.target.closest("[data-new-topic]");
    if (make) {
      if (!needAccount()) return;
      openTopicBox();
      return;
    }
    const btn = event.target.closest("[data-room]");
    if (!btn) return;
    const channel = state.channels.find((c) => c.id === btn.dataset.room);
    if (!channel) return;
    if (channel.visibility !== "public" && !storedKey(channel.id) && state.channelId !== channel.id) {
      setStatus("That room needs its private link.", "bad");
    }
    goRoom(channel);
  });

  $("copy-link").addEventListener("click", () => {
    copyText(roomLink(), "Invite link copied.");
  });

  $("ask-open").addEventListener("click", () => {
    if (!needAccount()) return;
    const panel = $("ask-panel");
    if (!panel) return;
    panel.open = true;
    $("f-title").focus();
  });

  $("auth-open").addEventListener("click", () => openAuth("login"));
  $("auth-out").addEventListener("click", logout);
  $("auth-cancel").addEventListener("click", closeAuth);
  $("auth-toggle").addEventListener("click", () => {
    setAuthMode(state.authMode === "register" ? "login" : "register");
  });
  $("auth-form").addEventListener("submit", submitAuth);
  $("auth-google").addEventListener("click", startGoogle);
  $("topic-form").addEventListener("submit", submitTopic);
  $("topic-cancel").addEventListener("click", closeTopicBox);
  $("meet-on").addEventListener("change", saveMeetSettings);
  $("meet-private").addEventListener("change", saveMeetSettings);
  $("meet-refresh").addEventListener("click", () => loadMeet());
  $("meet").addEventListener("click", (event) => {
    const contact = event.target.closest("[data-contact]");
    if (contact) {
      contactMatch(contact.dataset.contact);
      return;
    }
    const pair = event.target.closest("[data-pair]");
    if (!pair) return;
    rememberKey(pair.dataset.pair, pair.dataset.key);
    location.hash = `#/${pair.dataset.pair}?k=${encodeURIComponent(pair.dataset.key)}`;
  });

  topRange.addEventListener("change", () => {
    localStorage.setItem("po-top-range", topRange.value);
    writeHash();
    renderFeed();
  });

  document.querySelector(".sort").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-sort]");
    if (!btn) return;
    state.sort = btn.dataset.sort;
    writeHash();
    renderFeed();
  });

  const tagFilterEl = $("tag-filter");
  if (tagFilterEl) {
    tagFilterEl.addEventListener("click", (event) => {
      if (!event.target.closest("[data-clear-tag]")) return;
      state.tagFilter = "";
      writeHash();
      renderFeed();
    });
  }

  feedEl.addEventListener("click", (event) => {
    const tagBtn = event.target.closest("[data-tag]");
    if (tagBtn) {
      const next = tagBtn.dataset.tag || "";
      state.tagFilter = state.tagFilter === next ? "" : next;
      writeHash();
      renderFeed();
      return;
    }
    const clearTag = event.target.closest("[data-clear-tag]");
    if (clearTag) {
      state.tagFilter = "";
      writeHash();
      renderFeed();
      return;
    }
    const voteBtn = event.target.closest("[data-vote]");
    if (voteBtn) {
      vote(voteBtn.dataset.vote);
      return;
    }
    const workBtn = event.target.closest("[data-work]");
    if (workBtn) {
      toggleWorking(workBtn.dataset.work);
      return;
    }
    const copyCardBtn = event.target.closest("[data-copy-card]");
    if (copyCardBtn) {
      copyText(cardLink(copyCardBtn.dataset.copyCard), "Link copied.");
      return;
    }
    const buzzBtn = event.target.closest("[data-buzz]");
    if (buzzBtn) {
      copyBuzz(buzzBtn.dataset.buzz);
      return;
    }
    const ctxBtn = event.target.closest("[data-context]");
    if (ctxBtn) {
      const art = ctxBtn.closest(".q");
      openCard(art);
      art.classList.toggle("ctx-open", true);
      return;
    }
    const questionBtn = event.target.closest("[data-question]");
    if (questionBtn) {
      const art = questionBtn.closest(".q");
      openCard(art);
      art.classList.add("ask-open");
      const ctx = art.querySelector(".ctx");
      if (ctx && ctx.dataset.extra === "1") art.classList.add("ctx-open");
      const box = art.querySelector("[data-ask] textarea");
      if (box) box.focus();
      return;
    }
    const tabBtn = event.target.closest("[data-ctx-tab]");
    if (tabBtn) {
      const ctx = tabBtn.closest(".ctx");
      ctx.classList.toggle("tab-ai", tabBtn.dataset.ctxTab === "ai");
      ctx.querySelectorAll("[data-ctx-tab]").forEach((el) => {
        el.classList.toggle("on", el === tabBtn);
      });
      return;
    }
    const jumpBtn = event.target.closest("[data-jump]");
    if (jumpBtn) {
      jumpToCard(jumpBtn.dataset.jump);
      return;
    }
    const openBtn = event.target.closest("[data-open]");
    if (!openBtn) return;
    const art = openBtn.closest(".q");
    const on = !art.classList.contains("open");
    if (on) {
      openCard(art);
    } else {
      art.classList.remove("open");
      openBtn.setAttribute("aria-expanded", "false");
      state.cardId = "";
      writeHash();
    }
  });

  feedEl.addEventListener("submit", (event) => {
    const askForm = event.target.closest("[data-ask]");
    if (askForm) {
      event.preventDefault();
      ask(askForm.dataset.ask, new FormData(askForm).get("question"));
      return;
    }
    const answerForm = event.target.closest("[data-answer]");
    if (answerForm) {
      event.preventDefault();
      answer(answerForm.dataset.answer, answerForm.dataset.qid, answerForm);
      return;
    }
    const replyForm = event.target.closest("[data-reply]");
    if (replyForm) {
      event.preventDefault();
      reply(replyForm.dataset.reply, new FormData(replyForm).get("note"));
      return;
    }
    const challengeForm = event.target.closest("[data-challenge]");
    if (challengeForm) {
      event.preventDefault();
      openChallenge(challengeForm);
      return;
    }
    const buzzForm = event.target.closest("[data-buzz-link]");
    if (buzzForm) {
      event.preventDefault();
      saveBuzzLink(buzzForm.dataset.buzzLink, new FormData(buzzForm).get("buzzUrl"));
      return;
    }
    const humanCtx = event.target.closest("[data-human-ctx]");
    if (humanCtx) {
      event.preventDefault();
      saveHumanContext(humanCtx.dataset.humanCtx, new FormData(humanCtx).get("humanContext"));
      return;
    }
    const agentCtx = event.target.closest("[data-agent-ctx]");
    if (agentCtx) {
      event.preventDefault();
      saveAgentContext(agentCtx.dataset.agentCtx, new FormData(agentCtx).get("agentContext"));
    }
  });

  window.addEventListener("hashchange", () => {
    parseHash();
    writeHash();
    pingHere().then(loadBoard);
  });

  window.addEventListener("popstate", () => {
    parseHash();
    pingHere().then(loadBoard);
  });

  boot().catch(() => setStatus("The board is not up.", "bad"));
})();

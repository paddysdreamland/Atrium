// ─── Config ───────────────────────────────────────────────────────────────
const CHANNEL = "paddysdreamland";
const FALLBACK_COLOR = "rgb(192, 192, 192)";
const MAX_MESSAGES = 40;

// ─── Helper Functions ───────────────────────────────────────────────────
const CHAT_SOUND = new Audio("sounds/buttonrollover.wav");
CHAT_SOUND.volume = 1;
CHAT_SOUND.currentTime = 0;

function playChatSound() {
    CHAT_SOUND.play().catch(() => {});
}

// Bots to hide from the overlay (case-insensitive)
const BOT_USERNAMES = new Set([
    "nightbot", "streamelements", "streamlabs", "soundalerts",
    "moobot", "fossabot", "wizebot", "deepbot"
]);

// Chat commands that replay the music toast (case-insensitive, exact match)
const NOWPLAYING_COMMANDS = new Set(["!nowplaying", "!np"]);

// Emote CDN templates
const TWITCH_EMOTE_URL = (id) =>
    `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;

// ─── Presence (JOIN) events ─────────────────────────────────────────────
const SHOW_PRESENCE       = true;   // master toggle for "someone wandered in"
const JOIN_GRACE_MS       = 2000;   // ignore the startup/reconnect JOIN flood
const PRESENCE_MIN_GAP_MS = 500;    // min spacing so bursts drift in, not dump

// {user} is replaced with the (lowercase) login. One is picked at random.
const PRESENCE_MESSAGES = [
    "{user}'s presence radiates through the stream",
    "{user} drifts into the dreamland",
    "{user} materializes among the stars",
    "a faint signal from {user} reaches the united planet",
    "{user} settles in beneath the two moons",
    "{user} phases quietly into orbit",
    "the dreamland senses {user} nearby",
    "{user} wanders in from the cosmos",
    "{user} tunes into the frequency",
    "somewhere in ventara, {user} blinks into view",
    "{user} slips through the atmosphere",
    "{user} arrives, trailing stardust",
    "a presence stirs — it's {user}",
    "{user} fades comfortably into the room",
];
// ─────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    const chatWrapper = document.getElementById("chat-wrapper");
    // No chat on this page (a widgets-only overlay) → nothing to render into.
    // Bail like the other widget scripts do, rather than throwing on first log.
    if (!chatWrapper) return;

    // ─── Presence state (closure scope — survives reconnects) ─────────────
    // announced: dedup + flood absorber. Lives out here so a dropped socket
    //   doesn't re-announce the whole audience on reconnect.
    // joinGraceUntil: re-armed inside ws.onopen on every (re)connect.
    const announced     = new Set();
    let   joinGraceUntil = 0;
    let   selfNick       = "";
    let   presenceQueue  = [];
    let   presenceTimer  = null;

    // ─── IRC Parsing ──────────────────────────────────────────────────────

    function parseIRCTags(raw) {
        const tags = {};
        raw.split(";").forEach(part => {
            const [key, ...rest] = part.split("=");
            tags[key] = rest.join("=");
        });
        return tags;
    }

    function parseMessage(line) {
        const tagMatch = line.match(/^@([^ ]+) /);
        const tags = tagMatch ? parseIRCTags(tagMatch[1]) : {};
        const rest = tagMatch ? line.slice(tagMatch[0].length) : line;

        const privmsgMatch = rest.match(/^:(\w+)!\w+@\S+ PRIVMSG #\S+ :(.+)$/);
        if (!privmsgMatch) return null;

        let message = privmsgMatch[2];
        let isAction = false;

        // /me action format: \x01ACTION text\x01
        const actionMatch = message.match(/^\x01ACTION (.+)\x01$/);
        if (actionMatch) {
            isAction = true;
            message = actionMatch[1];
        }

        return {
            platform:    "twitch",
            username:    tags["display-name"] || privmsgMatch[1],
            message,
            color:       tags["color"] || FALLBACK_COLOR,
            emotes:      tags["emotes"] || "",
            badges:      tags["badges"] || "",
            msgId:       tags["id"] || "",
            userId:      tags["user-id"] || "",
            isFirstMsg:  tags["first-msg"] === "1",
            isHighlight: tags["msg-id"] === "highlighted-message",
            bits:        parseInt(tags["bits"], 10) || 0,
            isAction,
        };
    }

    // ─── Emote Rendering ──────────────────────────────────────────────────

    // Twitch sends emotes as: emoteId:start-end,start-end/emoteId:start-end
    // We need to splice them into the message text as <img> tags.
    function renderMessageWithEmotes(message, emotesRaw) {
        if (!emotesRaw) {
            return [{ type: "text", value: message }];
        }

        // Build a flat list of { start, end, id } ranges
        const ranges = [];
        emotesRaw.split("/").forEach(emoteBlock => {
            const [id, positions] = emoteBlock.split(":");
            if (!positions) return;
            positions.split(",").forEach(range => {
                const [start, end] = range.split("-").map(Number);
                ranges.push({ start, end, id });
            });
        });

        // Sort by start position so we can walk through linearly
        ranges.sort((a, b) => a.start - b.start);

        // Twitch uses code-point indices, not UTF-16 indices.
        // Convert to a code-point array first to handle emoji safely.
        const codePoints = Array.from(message);
        const parts = [];
        let cursor = 0;

        for (const { start, end, id } of ranges) {
            if (start > cursor) {
                parts.push({
                    type: "text",
                    value: codePoints.slice(cursor, start).join("")
                });
            }
            parts.push({
                type: "emote",
                id,
                name: codePoints.slice(start, end + 1).join("")
            });
            cursor = end + 1;
        }

        if (cursor < codePoints.length) {
            parts.push({
                type: "text",
                value: codePoints.slice(cursor).join("")
            });
        }

        return parts;
    }

    // ─── Badge Rendering ──────────────────────────────────────────────────

    // Badges format: broadcaster/1,subscriber/12,bits/100
    // Real badge images require the badge URL list from Helix; for an MVP we
    // use simple text/symbol fallbacks. Replace with image URLs later when you
    // wire up the Helix badge list endpoint.
    // Explicit image paths for badges we render locally (no Helix involvement)
    const BADGE_LOCAL = {
        youtube: "images/badges/youtube.png",
    };

    const BADGE_MISSING = "images/badges/missing.png";

    function renderBadges(badgesRaw) {
        if (!badgesRaw) return [];
        return badgesRaw.split(",").map(b => {
            const [name, version] = b.split("/");
            const localUrl = BADGE_LOCAL[name];
            const cached = BADGE_CACHE[name]?.[version];
            return {
                name,
                version,
                url:   localUrl || cached?.url_2x || BADGE_MISSING,
                title: localUrl ? name : (cached?.title || `${name}/${version}`),
            };
        });
    }

    // ─── DOM Building ─────────────────────────────────────────────────────
    // Two-helper entrance, nested INSIDE one flex child so the flex layout is
    // never touched:
    //   .msg-slot        (outer, the flex child) — vertical OPEN via max-height,
    //                     which the column-reverse stack turns into an upward push.
    //   .msg-slot-inner  (inner) — horizontal SLIDE; the fully-assembled message
    //                     flies in from off the left edge. overflow stays visible.
    // max-height is measured per message (not a fixed 9999px) so the open
    // animates over the full duration instead of snapping.
    // A Range's bounding rect spans only the rendered line boxes, so its width
    // is the longest line after wrapping.
    // Every wrapping text block a message can have: chat and log content, and
    // the single line of a presence event.
    const FIT_SELECTOR = ".msg-content, .presence-text";

    function shrinkToLines(el) {
        el.style.width = "";
        const range = document.createRange();
        range.selectNodeContents(el);
        const w = range.getBoundingClientRect().width;
        if (w > 0 && w < el.clientWidth) el.style.width = Math.ceil(w) + "px";
    }

    // The width shrinkToLines pins is only right for the wrapper width it was
    // measured at. A layer switch (#layers=desktoponly takes the chat from
    // 100vw to 384px) or an OBS source resize changes where every line wraps,
    // so re-fit everything already on screen. Same logic as shrinkToLines, but
    // in batched passes - clear all, measure all, set all - so 40 messages cost
    // one reflow rather than 40.
    function reshrinkAll() {
        const els = [...chatWrapper.querySelectorAll(FIT_SELECTOR)];
        els.forEach(el => el.style.width = "");
        const widths = els.map(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return [range.getBoundingClientRect().width, el.clientWidth];
        });
        els.forEach((el, i) => {
            const [w, full] = widths[i];
            if (w > 0 && w < full) el.style.width = Math.ceil(w) + "px";
        });

        // Slots still mid-open are heading for a height measured at the old
        // width - re-aim them. Finished ones have no cap left to fix.
        chatWrapper.querySelectorAll(".msg-slot").forEach(slot => {
            if (slot.style.maxHeight === "none") return;
            const h = slot.querySelector(".msg-slot-inner > *")?.offsetHeight;
            if (h > 0) slot.style.setProperty("--open-h", h + "px");
        });
    }

    // Width only: height changes every time a message comes in, and the
    // wrapper's own width never depends on its children (it's 100vw or a
    // layer's fixed size), so re-fitting can't feed back into another resize.
    let lastChatWidth = chatWrapper.clientWidth;
    new ResizeObserver(() => {
        const w = chatWrapper.clientWidth;
        if (w === lastChatWidth) return;
        lastChatWidth = w;
        reshrinkAll();
    }).observe(chatWrapper);

    function appendToChat(wrapper) {
        const slot = document.createElement("div");
        slot.classList.add("msg-slot");

        const inner = document.createElement("div");
        inner.classList.add("msg-slot-inner");
        inner.appendChild(wrapper);
        slot.appendChild(inner);
        chatWrapper.prepend(slot);

        // Wrapped text leaves the wrapper at full available width, not the
        // longest line's — clamp each content block to its rendered lines.
        wrapper.querySelectorAll(FIT_SELECTOR).forEach(el => {
            shrinkToLines(el);
            // Emotes have no width until loaded, so re-measure once they arrive.
            el.querySelectorAll("img").forEach(img => {
                if (!img.complete) img.addEventListener("load", () => shrinkToLines(el), { once: true });
            });
        });

        // Read the assembled message's natural height (forces layout) and feed
        // it to the open. overflow is visible, so this is unaffected by max-height.
        const h = wrapper.offsetHeight;
        if (h > 0) slot.style.setProperty("--open-h", h + "px");

        // Once the open finishes, drop the cap so the row tracks natural height
        // (guards against any later reflow being clipped by a stale max-height,
        // e.g. a narrower wrapper making the message wrap onto more lines).
        // The animation itself has to go: a "forwards" fill outranks inline
        // styles in the cascade, so max-height:none alone would never apply.
        slot.addEventListener("animationend", function done(e) {
            if (e.animationName === "slot-open") {
                slot.style.animation = "none";
                slot.style.maxHeight = "none";
                slot.removeEventListener("animationend", done);
            }
        });

        while (chatWrapper.children.length > MAX_MESSAGES) {
            chatWrapper.removeChild(chatWrapper.lastChild);
        }
    }

    function addMessage(data) {
        if (BOT_USERNAMES.has(data.username.toLowerCase())) return;

        // Chat command → replay the music toast. Still renders the message
        // normally; add `return;` here if you'd rather hide the command itself.
        // The toast usually lives on ANOTHER overlay page now, so this goes over
        // the bus as well as locally. The hub never echoes a message back to its
        // sender, so a toast sharing this page can't fire twice.
        if (NOWPLAYING_COMMANDS.has(data.message.trim().toLowerCase())) {
            window.dispatchEvent(new CustomEvent("overlay:nowplaying-request"));
            if (window.overlayPublish) {
                window.overlayPublish({ type: "nowplaying-request" });
            }
        }

        playChatSound();

        const msgWrapper = document.createElement("div");
        msgWrapper.classList.add("msg-wrapper");
        msgWrapper.dataset.msgId = data.msgId;
        msgWrapper.dataset.userId = data.userId;
        msgWrapper.dataset.username = data.username.toLowerCase();
        msgWrapper.style.borderLeftColor = data.color;
        msgWrapper.style.setProperty("--msg-user-color", data.color);

        if (data.isHighlight)  msgWrapper.classList.add("msg-highlight");
        if (data.isFirstMsg)   msgWrapper.classList.add("msg-firstmsg");
        if (data.isAction)     msgWrapper.classList.add("msg-action");
        if (data.bits > 0)     msgWrapper.classList.add("msg-bits");

        // Badges
        const badges = renderBadges(data.badges);
        const badgeContainer = document.createElement("span");
        badgeContainer.classList.add("msg-badges");
        badges.forEach(b => {
            const img = document.createElement("img");
            img.classList.add("msg-badge", "msg-badge-img", `msg-badge-${b.name}`);
            img.src = b.url;
            img.alt = b.title;
            img.title = b.title;
            badgeContainer.appendChild(img);
        });

        // Author line
        const author = document.createElement("div");
        author.classList.add("msg-author", "text", "bold");

        if (badges.length) author.appendChild(badgeContainer);

        const nameSpan = document.createElement("span");
        nameSpan.classList.add("msg-username");
        nameSpan.textContent = data.username;
        nameSpan.style.color = data.color;
        author.appendChild(nameSpan);

        // First-msg badge tag
        if (data.isFirstMsg) {
            const firstTag = document.createElement("span");
            firstTag.classList.add("msg-firstmsg-tag");
            firstTag.textContent = "FIRST TIME";
            author.appendChild(firstTag);
        }

        // Bits indicator
        if (data.bits > 0) {
            const bitsTag = document.createElement("span");
            bitsTag.classList.add("msg-bits-tag");
            bitsTag.textContent = `+${data.bits} Bits`;
            author.appendChild(bitsTag);
        }

        // Content with emotes interleaved
        const content = document.createElement("div");
        content.classList.add("msg-content", "text");
        //if (data.isAction) content.style.color = data.color;

        const parts = renderMessageWithEmotes(data.message, data.emotes);
        parts.forEach(part => {
            if (part.type === "text") {
                content.appendChild(document.createTextNode(part.value));
            } else {
                const img = document.createElement("img");
                img.classList.add("msg-emote");
                img.src = TWITCH_EMOTE_URL(part.id);
                img.alt = part.name;
                img.title = part.name;
                content.appendChild(img);
            }
        });

        msgWrapper.appendChild(author);
        msgWrapper.appendChild(content);

        appendToChat(msgWrapper);
    }

    // ─── Moderation Handling ──────────────────────────────────────────────

    function handleClearChat(line) {
        // :tmi.twitch.tv CLEARCHAT #channel :username   → user timed out/banned
        // :tmi.twitch.tv CLEARCHAT #channel             → entire chat cleared
        const match = line.match(/CLEARCHAT #\S+(?: :(.+))?$/);
        if (!match) return;

        const targetUser = match[1];
        if (!targetUser) {
            // Full chat clear
            Array.from(chatWrapper.querySelectorAll(".msg-wrapper"))
                .forEach(el => el.classList.add("msg-deleted"));
            return;
        }

        // Mark all messages from that user as deleted
        const target = targetUser.toLowerCase();
        chatWrapper.querySelectorAll(`.msg-wrapper[data-username="${target}"]`)
            .forEach(el => el.classList.add("msg-deleted"));
    }

    function handleClearMsg(line) {
        // @login=user;target-msg-id=UUID :tmi.twitch.tv CLEARMSG #channel :text
        const tagMatch = line.match(/^@([^ ]+) /);
        if (!tagMatch) return;
        const tags = parseIRCTags(tagMatch[1]);
        const targetId = tags["target-msg-id"];
        if (!targetId) return;

        const el = chatWrapper.querySelector(`.msg-wrapper[data-msg-id="${targetId}"]`);
        if (el) el.classList.add("msg-deleted");
    }

    // ─── Presence Handling ────────────────────────────────────────────────

    function handleJoin(line) {
        if (!SHOW_PRESENCE) return;

        const m = line.match(/^:(\w+)!\w+@\S+ JOIN #/);
        if (!m) return;

        const login = m[1].toLowerCase();
        if (login === selfNick) return;        // our own justinfan join
        if (BOT_USERNAMES.has(login)) return;  // same bot filter as addMessage
        if (announced.has(login)) return;      // already greeted this session
        announced.add(login);               // record even during grace…

        if (Date.now() < joinGraceUntil) return;  // …but stay silent in the flood

        presenceQueue.push(login);
        if (!presenceTimer) drainPresence();
    }

    function drainPresence() {
        const login = presenceQueue.shift();
        if (login === undefined) { presenceTimer = null; return; }
        announcePresence(login);
        presenceTimer = setTimeout(drainPresence, PRESENCE_MIN_GAP_MS);
    }

    function announcePresence(login) {
        playChatSound();

        const template = PRESENCE_MESSAGES[
            Math.floor(Math.random() * PRESENCE_MESSAGES.length)
        ];

        const wrapper = document.createElement("div");
        wrapper.classList.add("msg-wrapper", "presence-event");
        wrapper.dataset.username = login;

        const lineEl = document.createElement("div");
        lineEl.classList.add("presence-text", "text");

        // Split on {user} and drop a styled span where the name goes.
        const segments = template.split("{user}");
        segments.forEach((seg, i) => {
            if (seg) lineEl.appendChild(document.createTextNode(seg));
            if (i < segments.length - 1) {
                const userSpan = document.createElement("span");
                userSpan.classList.add("presence-user");
                userSpan.textContent = login;   // kept lowercase, by design
                lineEl.appendChild(userSpan);
            }
        });

        wrapper.appendChild(lineEl);
        appendToChat(wrapper);
    }

    // ─── Log Events (RENDERER) ────────────────────────────────────────────
    // The capture side (console mirror, error handlers, fetch/WebSocket
    // wrappers) lives in jte_log.js, which runs on EVERY overlay page and emits
    // "overlay:log" events. This file is the only place that draws them, so the
    // chat overlay acts as the on-stream console for the whole system —
    // including logs relayed from other overlay pages via jte_control.js.
    //
    //   <div class="msg-wrapper log-event log-hint">
    //     <div class="msg-icon"></div>
    //     <div class="msg-content">…</div>
    //   </div>
    // Levels: "hint" | "warn" | "error".
    const LOG_LEVELS = new Set(["hint", "warn", "error"]);

    // DOM-only: builds and inserts the notice. Never touches the console, so
    // it's safe to call from inside the mirror.
    function renderLog(level, message, source) {
        if (!LOG_LEVELS.has(level)) level = "hint";

        //playChatSound();

        const wrapper = document.createElement("div");
        wrapper.classList.add("msg-wrapper", "log-event", `log-${level}`);

        const icon = document.createElement("div");
        icon.classList.add("msg-icon");

        // Tag logs that came from another overlay page, e.g. "[music] Uncaught…"
        const remote = source && source !== window.OVERLAY_SOURCE;

        const content = document.createElement("div");
        content.classList.add("msg-content");
        if (remote) wrapper.classList.add("log-remote");
        content.textContent = remote ? `[${source}] ${message}` : message;

        wrapper.appendChild(icon);
        wrapper.appendChild(content);
        appendToChat(wrapper);
    }

    const renderLogEvent = (d) => renderLog(d.level, d.message, d.source);

    // Drain anything captured before we were listening (parse-time errors),
    // THEN subscribe — draining first avoids double-rendering the same event.
    if (window.overlayLogDrain) window.overlayLogDrain().forEach(renderLogEvent);
    window.addEventListener("overlay:log", (e) => renderLogEvent(e.detail || {}));

    // ─── Dev: manual presence trigger (safe to delete before release) ─────
    // From the OBS source / browser console:
    //   testPresence()             → random sample name
    //   testPresence("paddy")   → specific name
    // Or press Ctrl+Alt+P in a focused browser tab.
    // Calls announcePresence directly, so it ignores the grace window, the
    // dedup Set, and the bot filter — it always renders.
    const PRESENCE_TEST_NAMES = [
        "paddy", "stardust_wanderer", "moonlit_lurker", "cozy_viewer",
    ];

    function firePresenceTest(name) {
        const login = (name || PRESENCE_TEST_NAMES[
            Math.floor(Math.random() * PRESENCE_TEST_NAMES.length)
        ]).toLowerCase();
        announcePresence(login);
        return `presence fired for "${login}"`;
    }

    window.testPresence = firePresenceTest;

    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && e.code === "KeyP") {
            e.preventDefault();
            firePresenceTest();
        }
    });

    // ─── WebSocket Connection ─────────────────────────────────────────────
    // Slow, quiet auto-retry: on a drop we reconnect every RETRY_MS (logging is
    // deduped by the WebSocket wrapper above, so no spam). An "overlay:retry"
    // event — fired by the Stream Deck OSC button via jte_control.js — forces an
    // immediate reconnect of whatever's currently down.
    const RETRY_MS = 30000;

    let twitchWs    = null;
    let twitchTimer = null;

    function connect() {
        clearTimeout(twitchTimer);
        const ws = new WebSocket("wss://irc-ws.chat.twitch.tv");
        twitchWs = ws;

        ws.onopen = () => {
            console.log("Twitch chat connected.");
            selfNick = `justinfan${Math.floor(Math.random() * 99999)}`;
            joinGraceUntil = Date.now() + JOIN_GRACE_MS;  // re-armed each connect
            ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
            ws.send("PASS SCHMOOPIIE");
            ws.send(`NICK ${selfNick}`);
            ws.send(`JOIN #${CHANNEL}`);
        };

        ws.onmessage = (event) => {
            const lines = event.data.trim().split("\r\n");

            for (const line of lines) {
                if (line.startsWith("PING")) {
                    ws.send("PONG :tmi.twitch.tv");
                    continue;
                }

                if (line.includes("PRIVMSG")) {
                    const parsed = parseMessage(line);
                    if (parsed) addMessage(parsed);
                } else if (line.includes("CLEARCHAT")) {
                    handleClearChat(line);
                } else if (line.includes("CLEARMSG")) {
                    handleClearMsg(line);
                } else if (line.includes(" JOIN #")) {
                    handleJoin(line);
                }
            }
        };

        ws.onclose = () => {
            twitchTimer = setTimeout(connect, RETRY_MS);
        };

        ws.onerror = () => ws.close();
    }

    function retryTwitch() {
        const s = twitchWs && twitchWs.readyState;
        if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
        connect();
    }

    let BADGE_CACHE = {};

    async function init() {
        try {
            const r = await fetch("badges.json");
            // fetch only rejects on network failure, NOT on 404/500 — the
            // browser logs "GET ... 404" itself but never throws, so check.
            if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
            BADGE_CACHE = await r.json();
        } catch (e) {
            console.warn("badges.json missing. Using \"missing texture\" as fallback.");
            console.warn(e);
        }
        connect();
    }

    init();

    // YouTube chat now rides the shared bus: the OverlayHub's youtube subsystem
    // waits for the stream, attaches pytchat, and broadcasts each normalized
    // message as {type:"chat"}, which jte_control.js relays here as an
    // "overlay:chat" event. No direct socket to fail on launch anymore.
    window.addEventListener("overlay:chat", (e) => {
        if (e.detail) addMessage(e.detail);
    });

    // Stream Deck OSC button → jte_control.js → "overlay:retry": reconnect
    // Twitch IRC if it's currently down (YouTube reconnection is the hub's job).
    window.addEventListener("overlay:retry", retryTwitch);
});
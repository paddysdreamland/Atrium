import { createMap, horizontalDistance, spatialDistance } from "./glassguessr_map.js";
import { LOCATIONS, locationPosition, validateLocations } from "./glassguessr_locations.js";

/* A run is ROUNDS screenshots, drawn without repeats from the locations that
   have a position. Fewer locations than that just makes a shorter run. */
const ROUNDS = 5;

/* Points fall off exponentially with the miss, GeoGuessr style: every
   SCORE_FALLOFF metres off keeps about 37% of what was left. Glass is roughly
   2.5 km across, so 300 m keeps a right-district guess worth having.

   PERFECT_RADIUS is the answer's zone: a guess inside it scores in full, and
   deductions start at its edge. It is also the red waypoint region the map
   pulses around the answer once revealed, so what is shown is the rule. By
   default it is a cylinder, like the game's waypoints - distance across the
   ground, height ignored - so the right spot on the wrong floor still counts.
   The Count height modifier measures in 3D instead, making it a sphere. */
const MAX_POINTS = 5000;
const SCORE_FALLOFF = 300;
const PERFECT_RADIUS = 20;

/* Modifiers - optional rules picked on the menu, fixed for the length of a
   run and remembered per browser (storage can be unavailable, so every
   access is guarded). */
const MODIFIERS_KEY = "glgModifiers";
const modifiers = { countHeight: false };
try {
    const saved = JSON.parse(localStorage.getItem(MODIFIERS_KEY) || "{}");
    modifiers.countHeight = saved.countHeight === true;
} catch (err) { /* defaults */ }

/* The guess reveal, in order: the accept sound and the camera easing in on
   the guess marker (REVEAL_FLY_SECONDS), a short hold once it settles
   (REVEAL_HOLD_SECONDS), then the line reaching out to the hidden answer over
   exactly the length of the text sound that plays with it, the camera pulling
   back and turning with it until both markers are in frame. */
const REVEAL_FLY_SECONDS = 1.2;
const REVEAL_HOLD_SECONDS = 0.35;
const LINE_FALLBACK_SECONDS = 0.872;  // ME_UI_Gen_Text_Long, if the audio cannot play

const SOUNDS = {
    accept: "sounds/ui/ME_UI_challenge_accept.wav",
    line: "sounds/ui/ME_UI_Gen_Text_Long.wav"
};

const $ = (id) => document.getElementById(id);

/* Web Audio rather than <audio> elements, so a sound starts on the frame it
   is asked for and its exact length is known up front. Browsers only let an
   AudioContext start from a click or key press, so sounds are decoded in an
   offline context at load - decoded buffers play in any context - and the
   real one is created by unlock() on the Start click. */
const sound = (() => {
    let context = null;
    let output = null;
    const buffers = {};

    function ensureContext() {
        if (!context) {
            context = new AudioContext();
            output = context.createGain();
            output.gain.value = 0.8;
            output.connect(context.destination);
        }
        if (context.state === "suspended") context.resume();
        return context;
    }

    return {
        load() {
            const decoder = new OfflineAudioContext(2, 1, 48000);
            return Promise.all(Object.entries(SOUNDS).map(async ([name, url]) => {
                try {
                    const data = await (await fetch(url)).arrayBuffer();
                    buffers[name] = await decoder.decodeAudioData(data);
                } catch (err) {
                    console.warn("sound " + name + " failed to load:", err);
                }
            }));
        },

        /* Call from a click or key handler. */
        unlock() {
            ensureContext();
        },

        /* Plays a sound and returns its length in seconds, or 0 if it
           could not play. */
        play(name) {
            const buffer = buffers[name];
            if (!buffer) return 0;
            const ctx = ensureContext();
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(output);
            source.start();
            return buffer.duration;
        }
    };
})();

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const ui = {
    loading: $("loading-holder"),
    loadingLabel: $("loading-label"),
    menuSubtitle: $("menu-subtitle"),
    start: $("start-button"),
    countHeight: $("count-height-toggle"),
    roundPlate: $("round-plate"),
    roundCount: $("round-count"),
    roundClock: $("round-clock"),
    photoPanel: $("photo-panel"),
    photo: $("photo"),
    resultPlate: $("result-plate"),
    resultDistance: $("result-distance"),
    resultPoints: $("result-points"),
    guess: $("guess-button"),
    next: $("next-button"),
    summaryTotal: $("summary-total"),
    summaryOutOf: $("summary-out-of"),
    summaryRounds: $("summary-rounds"),
    again: $("again-button")
};

const map = createMap($("map-holder"));

/* Exposed so addMarker can be driven from the console. */
window.glgMap = map;

function showModifiers() {
    ui.countHeight.setAttribute("aria-pressed", String(modifiers.countHeight));
}

function toggleCountHeight() {
    modifiers.countHeight = !modifiers.countHeight;
    try { localStorage.setItem(MODIFIERS_KEY, JSON.stringify(modifiers)); } catch (err) { /* not remembered */ }
    showModifiers();
}

showModifiers();

const playable = LOCATIONS.filter((l) => Array.isArray(l.position));

let run = null;        // { rounds: [location], results: [{ distance, points, time }] }
let roundIndex = 0;
let guess = null;      // model-space position of the current marker
let roundStart = 0;
let clockFrame = 0;

function setScreen(name) {
    document.body.dataset.screen = name;
    /* A button that was just clicked keeps focus after its screen hides, and
       would then catch the next Space or Enter meant for the game. */
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function scoreFor(distance) {
    if (distance <= PERFECT_RADIUS) return MAX_POINTS;
    return Math.round(MAX_POINTS * Math.exp(-(distance - PERFECT_RADIUS) / SCORE_FALLOFF));
}

function formatDistance(metres) {
    return metres < 1000
        ? Math.round(metres) + " m"
        : (metres / 1000).toFixed(2) + " km";
}

function formatPoints(points) {
    return points.toLocaleString("en-GB");
}

/* mm:ss.cc, the way Catalyst's own run timers read. */
function formatClock(ms) {
    const cs = Math.floor(ms / 10);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(Math.floor(cs / 6000)) + ":" + pad(Math.floor(cs / 100) % 60) + "." + pad(cs % 100);
}

/* Restarts the FX_timerBlink flash, which only plays when the class is added. */
function blink(el) {
    el.classList.remove("ar-blink");
    void el.offsetWidth;
    el.classList.add("ar-blink");
}

function tickClock() {
    ui.roundClock.textContent = formatClock(performance.now() - roundStart);
    clockFrame = requestAnimationFrame(tickClock);
}

function stopClock() {
    cancelAnimationFrame(clockFrame);
    return performance.now() - roundStart;
}

function setPhotoExpanded(expanded) {
    ui.photoPanel.classList.toggle("expanded", expanded);
    ui.photoPanel.title = expanded ? "Shrink (Space)" : "Enlarge (Space)";
}

function showMenu() {
    stopClock();
    map.onPick(null);
    map.clearMarkers();
    map.orbit();
    setScreen("menu");
}

function startRun() {
    if (!playable.length) return;
    sound.unlock();
    run = { rounds: shuffle(playable).slice(0, ROUNDS), results: [], countHeight: modifiers.countHeight };
    roundIndex = 0;
    startRound();
}

function startRound() {
    const location = run.rounds[roundIndex];
    guess = null;

    ui.photo.src = location.image;
    setPhotoExpanded(false);
    /* Fetch the next screenshot while this round is played. */
    const upcoming = run.rounds[roundIndex + 1];
    if (upcoming) new Image().src = upcoming.image;

    ui.roundCount.textContent = (roundIndex + 1) + "/" + run.rounds.length;
    ui.resultPlate.hidden = true;
    ui.next.hidden = true;
    ui.guess.hidden = false;
    ui.guess.disabled = true;
    ui.guess.textContent = "Place a marker";

    map.clearMarkers();
    map.release();
    map.onPick((pos) => {
        guess = pos;
        ui.guess.disabled = false;
        ui.guess.textContent = "Submit";
    });

    setScreen("round");
    blink(ui.roundPlate);
    roundStart = performance.now();
    tickClock();
}

async function submitGuess() {
    if (!guess || document.body.dataset.screen !== "round") return;

    const time = stopClock();
    const answer = locationPosition(run.rounds[roundIndex]);
    const distance = run.countHeight ? spatialDistance(guess, answer) : horizontalDistance(guess, answer);
    const points = scoreFor(distance);
    run.results.push({ distance, points, time });

    /* "reveal" keeps the HUD up but takes Guess away, so the sequence below
       cannot be started twice or skipped into the next round. */
    map.onPick(null);
    setPhotoExpanded(false);
    ui.guess.hidden = true;
    setScreen("reveal");
    blink(ui.roundPlate);

    sound.play("accept");
    await map.focusGuess(REVEAL_FLY_SECONDS);
    await wait(REVEAL_HOLD_SECONDS);
    await map.revealAnswer(answer, sound.play("line") || LINE_FALLBACK_SECONDS, PERFECT_RADIUS, run.countHeight);

    /* Left the run while it played (there is no way to yet, but cheap to guard). */
    if (document.body.dataset.screen !== "reveal") return;

    ui.resultDistance.textContent = formatDistance(distance);
    ui.resultPoints.textContent = formatPoints(points);
    ui.resultPlate.hidden = false;
    ui.next.hidden = false;
    ui.next.textContent = roundIndex + 1 < run.rounds.length ? "Next Location" : "Results";

    setScreen("result");
    blink(ui.resultPlate);
}

function nextRound() {
    roundIndex++;
    if (roundIndex < run.rounds.length) startRound();
    else showSummary();
}

function showSummary() {
    const total = run.results.reduce((sum, r) => sum + r.points, 0);
    ui.summaryTotal.textContent = formatPoints(total);
    ui.summaryOutOf.textContent = "points out of " + formatPoints(run.rounds.length * MAX_POINTS)
        + (run.countHeight ? ", height counted" : "");

    ui.summaryRounds.replaceChildren(...run.results.map((r, i) => {
        const row = document.createElement("li");
        for (const text of ["Round " + (i + 1), formatDistance(r.distance), formatPoints(r.points) + " pts"]) {
            const cell = document.createElement("span");
            cell.textContent = text;
            row.append(cell);
        }
        return row;
    }));

    map.onPick(null);
    map.clearMarkers();
    map.orbit();
    setScreen("summary");
}

ui.start.addEventListener("click", startRun);
ui.countHeight.addEventListener("click", toggleCountHeight);
ui.guess.addEventListener("click", submitGuess);
ui.next.addEventListener("click", nextRound);
ui.again.addEventListener("click", showMenu);
ui.photoPanel.addEventListener("click", () => setPhotoExpanded(!ui.photoPanel.classList.contains("expanded")));

window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    /* A focused button already acts on Space and Enter itself. */
    if (e.target instanceof HTMLButtonElement) return;
    const screen = document.body.dataset.screen;
    const inRun = screen === "round" || screen === "reveal" || screen === "result";

    if (e.code === "Space" && inRun) {
        e.preventDefault();
        setPhotoExpanded(!ui.photoPanel.classList.contains("expanded"));
    } else if (e.code === "Escape" && inRun) {
        setPhotoExpanded(false);
    } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        if (screen === "round") submitGuess();
        else if (screen === "result") nextRound();
        else if (screen === "menu") startRun();
        else if (screen === "summary") showMenu();
    }
});

map.load((p) => {
    ui.loadingLabel.textContent = p === null
        ? "Loading Glass"
        : "Loading Glass " + Math.round(p * 100) + "%";
}).then((info) => {
    console.log("model size", info.size, "center", info.center);
    console.log("pan bounds", info.panBounds.min, info.panBounds.max);
    console.log(
        "%cglgMap.addMarker(x, y, z) drops a debug pointer in model space.",
        "color:#39ff6a"
    );
    console.log("  glgMap.addFrostbiteMarker(x, y, z) takes raw in-game coordinates instead.");
    console.log("  glgMarkAll() drops a pointer on every location in glassguessr_locations.js.");

    /* Run on load rather than on demand: a mistyped coordinate is
       invisible until that round comes up in play. */
    const problems = validateLocations();
    if (problems.length) {
        console.warn("location data problems:");
        for (const problem of problems) console.warn("  " + problem);
    } else {
        console.log("location data: " + LOCATIONS.length + " entries, all inside Glass");
    }

    window.glgMarkAll = () => playable.map((l) => map.addMarker(locationPosition(l)));

    const rounds = Math.min(ROUNDS, playable.length);
    if (rounds === 0) {
        ui.menuSubtitle.textContent = "No locations have a position yet.";
        ui.start.disabled = true;
    } else {
        ui.menuSubtitle.textContent = rounds + ui.menuSubtitle.textContent;
    }

    showMenu();
    ui.loading.classList.add("hidden");
    sound.load();
}).catch((err) => {
    ui.loadingLabel.textContent = "Failed to load Glass";
    console.error(err);
});

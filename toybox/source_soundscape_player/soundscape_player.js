// Source Soundscape Player - interface. Drives the SoundscapeSystem in soundscape_engine.js and
// draws what it's doing: the deck with its radar, a row per sound, and the recent sounds log.

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const engine = new SoundscapeSystem(audioContext, { scriptsRoot: "hl2/scripts", soundRoot: "hl2/sound" });

const soundscapeSelect = document.getElementById("ssp-select");
const playButton = document.getElementById("ssp-play");
const stopButton = document.getElementById("ssp-stop");
const statusLabel = document.getElementById("ssp-status");
const rowsElement = document.getElementById("ssp-rows");
const logElement = document.getElementById("ssp-log");
const loadingElement = document.getElementById("ssp-loading");

let playing = false;
let loading = false;
let soundscapeCount = null; // null until the scripts have loaded

// Readable names for each soundscape file's group in the picker.
const fileLabels = {
    "soundscapes.txt": "General",
    "soundscapes_canals.txt": "Route Kanal & Water Hazard",
    "soundscapes_klab.txt": "Kleiner's Lab",
    "soundscapes_elab.txt": "Black Mesa East",
    "soundscapes_streetwar.txt": "Street War",
    "soundscapes_citadel.txt": "Citadel",
    "soundscapes_town.txt": "Ravenholm",
    "soundscapes_coast.txt": "Highway 17 & Sandtraps",
    "soundscapes_prison.txt": "Nova Prospekt",
    "soundscapes_trainyard.txt": "Point Insertion & Trainyard"
};

function fileLabel(file) {
    return fileLabels[file] || file.replace(/^soundscapes_?|\.txt$/g, "") || "General";
}

function waveLabel(waveName) {
    return soundFilePath(waveName).split("/").pop();
}

/* Picker */

engine.loadScripts().then(soundscapes => {
    const groups = new Map();
    soundscapes.forEach(soundscape => {
        if (!groups.has(soundscape.file)) {
            const group = document.createElement("optgroup");
            group.label = fileLabel(soundscape.file);
            groups.set(soundscape.file, group);
            soundscapeSelect.appendChild(group);
        }
        const option = document.createElement("option");
        option.value = soundscape.name;
        option.textContent = soundscape.name;
        groups.get(soundscape.file).appendChild(option);
    });
    soundscapeCount = soundscapes.length;
}).catch(error => {
    console.error("Couldn't load the soundscape scripts:", error);
    soundscapeCount = 0;
});

// The title shows the picked soundscape; the subtitle where it's from and what it's made of.
function updateTitle() {
    const soundscape = engine.findSoundscape(soundscapeSelect.value);
    const title = document.getElementById("ssp-title");
    const subtitle = document.getElementById("ssp-subtitle");
    title.classList.toggle("is-empty", !soundscape);
    if (!soundscape) {
        title.textContent = "Choose a soundscape";
        subtitle.textContent = "Click the title to pick one and begin";
        return;
    }
    title.textContent = soundscape.name;

    const shown = playing && engine.currentSoundscape === soundscape;
    const loops = engine.loopingSounds.filter(slot => slot.volumeTarget > 0).length;
    subtitle.textContent = `${fileLabel(soundscape.file)} · ${soundscape.file}` +
        (shown ? ` · ${loops} loop${loops === 1 ? "" : "s"}, ${engine.randomSounds.length} random` : "");
}

async function startSoundscape(name) {
    audioContext.resume(); // while the click still counts as a user gesture
    const started = await engine.playSoundscape(name);
    if (!started) return;
    playing = true;
    playButton.hidden = true;
    stopButton.hidden = false;
    updateTitle();
}

soundscapeSelect.addEventListener("change", () => {
    updateTitle();
    if (playing && soundscapeSelect.value) startSoundscape(soundscapeSelect.value);
});

playButton.addEventListener("click", () => {
    if (!soundscapeSelect.value) {
        alert("Please choose a soundscape to play.");
        return;
    }
    startSoundscape(soundscapeSelect.value);
});

stopButton.addEventListener("click", () => {
    engine.stop();
    playing = false;
    playButton.hidden = false;
    stopButton.hidden = true;
    updateTitle();
});

engine.on("status", status => {
    loading = status.loading;
    loadingElement.hidden = !status.loading;
    if (status.loading) {
        const percent = Math.round((status.progress || 0) * 100);
        document.getElementById("ssp-loading-fill").style.width = `${percent}%`;
        document.getElementById("ssp-loading-text").textContent = `${percent}%`;
    }
});

/* Controls */

const volumeSlider = document.getElementById("ssp-volume");
const updateVolume = () => {
    const position = volumeSlider.value / 100;
    engine.setMasterVolume(position * position); // squared, so the travel feels even to the ear
    document.getElementById("ssp-volume-value").textContent = `${volumeSlider.value}%`;
    volumeSlider.style.setProperty("--fill", `${volumeSlider.value}%`);
};
volumeSlider.addEventListener("input", updateVolume);
volumeSlider.addEventListener("dblclick", () => { volumeSlider.value = 80; updateVolume(); });
updateVolume();

const dspCheckbox = document.getElementById("ssp-dsp");
dspCheckbox.addEventListener("change", () => engine.setDspEnabled(dspCheckbox.checked));
engine.setDspEnabled(dspCheckbox.checked);

const fadeSelect = document.getElementById("ssp-fade");
fadeSelect.addEventListener("change", () => engine.setFadeTime(Number(fadeSelect.value)));
engine.setFadeTime(Number(fadeSelect.value));

const rangeSelect = document.getElementById("ssp-range");
let radarRange = Number(rangeSelect.value);
rangeSelect.addEventListener("change", () => {
    radarRange = Number(rangeSelect.value);
    document.getElementById("ssp-radar-scale").textContent = `${radarRange} units`;
});

/* Sound rows */

const rowElements = new Map(); // engine row -> its DOM pieces

function describeRow(row) {
    const parts = [];
    if (row.kind === "loop") {
        parts.push(row.isAmbient ? "Ambient" : `Position ${row.positionIndex}`);
        parts.push(`vol ${row.volumeTarget.toFixed(2)}`, `pitch ${row.pitch}`);
        if (!row.isAmbient) parts.push(`${row.soundLevel} dB`);
    } else {
        parts.push(row.isAmbient ? "Ambient" : row.isRandom ? "Random position" : `Position ${row.positionIndex}`);
        parts.push(`${row.waves.length} wave${row.waves.length === 1 ? "" : "s"}`);
        const range = interval => interval.range ? `${+interval.start.toFixed(2)}-${+(interval.start + interval.range).toFixed(2)}` : `${+interval.start.toFixed(2)}`;
        parts.push(`every ${range(row.time)}s`, `vol ${range({ start: row.volume.start * row.masterVolume, range: row.volume.range * row.masterVolume })}`);
    }
    if (row.via) parts.push(`via ${row.via}`);
    return parts.join(" · ");
}

function createRowElement(row) {
    const element = document.createElement("div");
    element.className = "ssp-row";
    element.dataset.kind = row.kind;
    element.innerHTML = `
        <span class="ssp-badge">${row.kind === "loop" ? "Loop" : "Random"}</span>
        <div class="ssp-row-main">
            <div class="ssp-row-name"></div>
            <div class="ssp-row-details"></div>
        </div>
        <div class="ssp-row-meter"><div class="ssp-row-meter-fill"></div></div>
        <div class="ssp-row-state"></div>
        <div class="ssp-row-buttons">
            <label class="ssp-toggle ssp-toggle-mute" title="Mute this sound"><input type="checkbox">Mute</label>
            <label class="ssp-toggle ssp-toggle-solo" title="Hear only soloed sounds"><input type="checkbox">Solo</label>
        </div>`;
    const [mute, solo] = element.querySelectorAll("input");
    mute.checked = row.muted;
    solo.checked = row.soloed;
    mute.addEventListener("change", () => engine.setMuted(row, mute.checked));
    solo.addEventListener("change", () => engine.setSoloed(row, solo.checked));
    return {
        element,
        name: element.querySelector(".ssp-row-name"),
        details: element.querySelector(".ssp-row-details"),
        fill: element.querySelector(".ssp-row-meter-fill"),
        state: element.querySelector(".ssp-row-state"),
        level: 0
    };
}

// Rebuilds the row list when the engine's set of sounds changes (keeping existing rows' elements).
function renderRows() {
    const rows = engine.rows();
    rowElements.forEach((pieces, row) => { if (!rows.includes(row)) { pieces.element.remove(); rowElements.delete(row); } });
    rows.forEach(row => {
        if (!rowElements.has(row)) rowElements.set(row, createRowElement(row));
        const pieces = rowElements.get(row);
        pieces.name.textContent = row.kind === "loop" ? waveLabel(row.waveName) : (row.lastWave ? waveLabel(row.lastWave) : waveLabel(row.waves[0]));
        pieces.name.title = row.kind === "loop" ? soundFilePath(row.waveName) : row.waves.map(soundFilePath).join("\n");
        pieces.details.textContent = describeRow(row);
        rowsElement.appendChild(pieces.element); // keeps them in engine order
    });

    const empty = rowsElement.querySelector(".ssp-rows-empty");
    if (!rows.length && !empty) rowsElement.insertAdjacentHTML("afterbegin", '<div class="ssp-rows-empty">Nothing playing yet.</div>');
    if (rows.length && empty) empty.remove();

    document.getElementById("ssp-loop-count").textContent = engine.loopingSounds.filter(slot => slot.volumeTarget > 0).length;
    document.getElementById("ssp-random-count").textContent = engine.randomSounds.length;
    document.getElementById("ssp-room").textContent = engine.roomName();
    updateTitle();
}

engine.on("rows", renderRows);

/* Recent sounds log */

const recentPlays = [];

engine.on("play", event => {
    recentPlays.unshift(event);
    recentPlays.length = Math.min(recentPlays.length, 8);

    const where = event.position ? (event.row.isRandom ? "random position" : `position ${event.row.positionIndex}`) : "ambient";
    logElement.querySelector(".ssp-log-empty")?.remove();
    const item = document.createElement("li");
    item.innerHTML = `<b></b><small></small>`;
    item.querySelector("b").textContent = waveLabel(event.waveName);
    item.querySelector("small").textContent = `${where} · vol ${event.volume.toFixed(2)} · pitch ${event.pitch}`;
    item.title = soundFilePath(event.waveName);
    logElement.prepend(item);
    while (logElement.children.length > 8) logElement.lastElementChild.remove();

    radarBlips.push({ ...event, born: performance.now() });
    const pieces = rowElements.get(event.row);
    if (pieces) pieces.name.textContent = waveLabel(event.waveName);
});

/* Meters */

const meterSamples = new Float32Array(1024);

// Peak of a row's latest audio block, as 0..1 on a 48 dB scale.
function rowLevel(row) {
    row.analyser.getFloatTimeDomainData(meterSamples);
    let peak = 0;
    for (let i = 0; i < meterSamples.length; i++) peak = Math.max(peak, Math.abs(meterSamples[i]));
    return peak > 0 ? Math.max(0, Math.min(1, 1 + (20 * Math.log10(peak)) / 48)) : 0;
}

function renderMeters(deltaSeconds) {
    const now = audioContext.currentTime;
    rowElements.forEach((pieces, row) => {
        pieces.level = Math.max(rowLevel(row), pieces.level - deltaSeconds * 1.5);
        pieces.fill.style.width = `${(pieces.level * 100).toFixed(1)}%`;

        let state = "";
        if (row.kind === "loop") {
            if (row.missing) state = "Missing file";
            else if (row.ended) state = "Played once (no loop point)";
            else if (row.volumeTarget === 0) state = "Fading out";
            else if (row.fade && now < row.fade.end) state = "Fading in";
        } else {
            state = `Next in ${Math.max(0, row.nextPlayTime - now).toFixed(1)}s`;
        }
        if (pieces.state.textContent !== state) pieces.state.textContent = state;
        pieces.element.classList.toggle("is-fading-out", row.kind === "loop" && row.volumeTarget === 0);
    });
}

/* Radar */

const radar = document.getElementById("ssp-radar");
const radarContext = radar.getContext("2d");
const radarBlips = []; // recent random sound plays, drawn as ripples
let customColor = "0, 255, 192";
let customColorCheckedAt = -Infinity;
let draggedPosition = -1;
let hoveredPosition = -1;

// Radar layout: the listener sits in the middle facing up (forward), right is right.
function radarMetrics() {
    const size = radar.clientWidth;
    return { size, center: size / 2, scale: (size / 2 - 14) / radarRange };
}

function toScreen(point, metrics) {
    const clamp = value => Math.max(-radarRange, Math.min(radarRange, value));
    return { x: metrics.center + clamp(point.x) * metrics.scale, y: metrics.center - clamp(point.y) * metrics.scale };
}

function positionAt(event) {
    const rect = radar.getBoundingClientRect();
    const metrics = radarMetrics();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (let index = engine.positions.length - 1; index >= 0; index--) {
        const point = toScreen(engine.positions[index], metrics);
        if (Math.abs(point.x - x) <= 11 && Math.abs(point.y - y) <= 11) return index;
    }
    return -1;
}

radar.addEventListener("pointerdown", event => {
    draggedPosition = positionAt(event);
    if (draggedPosition >= 0) radar.setPointerCapture(event.pointerId);
});

radar.addEventListener("pointermove", event => {
    if (draggedPosition < 0) {
        hoveredPosition = positionAt(event);
        radar.style.cursor = hoveredPosition >= 0 ? "grab" : "";
        return;
    }
    const rect = radar.getBoundingClientRect();
    const metrics = radarMetrics();
    const clamp = value => Math.max(-radarRange, Math.min(radarRange, value));
    const x = clamp((event.clientX - rect.left - metrics.center) / metrics.scale);
    const y = clamp((metrics.center - (event.clientY - rect.top)) / metrics.scale);
    engine.setPosition(draggedPosition, Math.round(x), Math.round(y));
    radar.style.cursor = "grabbing";
});

const endDrag = () => { draggedPosition = -1; radar.style.cursor = ""; };
radar.addEventListener("pointerup", endDrag);
radar.addEventListener("pointercancel", endDrag);
radar.addEventListener("dblclick", () => engine.resetPositions());

function renderRadar(now) {
    const metrics = radarMetrics();
    const pixelRatio = window.devicePixelRatio || 1;
    if (radar.width !== Math.round(metrics.size * pixelRatio)) {
        radar.width = Math.round(metrics.size * pixelRatio);
        radar.height = Math.round(metrics.size * pixelRatio);
    }
    if (now - customColorCheckedAt > 500) {
        customColor = getComputedStyle(document.documentElement).getPropertyValue("--custom-color").trim() || customColor;
        customColorCheckedAt = now;
    }
    const accent = alpha => `rgba(${customColor}, ${alpha})`;
    const ctx = radarContext;
    const { size, center, scale } = metrics;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Grid: quarter-range lines, the centre cross, and the radius random sounds play at.
    ctx.lineWidth = 1;
    for (let step = -4; step <= 4; step++) {
        const offset = center + step * (radarRange / 4) * scale;
        ctx.strokeStyle = step === 0 ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.05)";
        ctx.beginPath(); ctx.moveTo(offset, 0); ctx.lineTo(offset, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, offset); ctx.lineTo(size, offset); ctx.stroke();
    }
    if (36 * scale > 6) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = accent(0.25);
        ctx.beginPath(); ctx.arc(center, center, 36 * scale, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
    }

    // Ambient sounds have no direction: a halo around the listener, as loud as they are.
    let ambientLevel = 0;
    rowElements.forEach((pieces, row) => { if (row.isAmbient) ambientLevel = Math.max(ambientLevel, pieces.level); });
    if (ambientLevel > 0.01) {
        const gradient = ctx.createRadialGradient(center, center, 4, center, center, 26 + ambientLevel * 34);
        gradient.addColorStop(0, accent(0.28 * ambientLevel));
        gradient.addColorStop(1, accent(0));
        ctx.fillStyle = gradient;
        ctx.beginPath(); ctx.arc(center, center, 26 + ambientLevel * 34, 0, Math.PI * 2); ctx.fill();
    }

    // Random sound ripples, for as long as the sound plays (at least a second, at most four).
    for (let i = radarBlips.length - 1; i >= 0; i--) {
        const blip = radarBlips[i];
        const life = Math.min(4, Math.max(1, blip.duration));
        const age = (now - blip.born) / 1000 / life;
        if (age >= 1) { radarBlips.splice(i, 1); continue; }
        const point = blip.position ? toScreen(blip.position, metrics) : { x: center, y: center };
        ctx.strokeStyle = blip.position ? `rgba(255, 210, 90, ${1 - age})` : accent(0.6 * (1 - age));
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(point.x, point.y, 4 + age * (blip.position ? 26 : 50), 0, Math.PI * 2); ctx.stroke();
        if (blip.position) {
            ctx.fillStyle = `rgba(255, 210, 90, ${1 - age})`;
            ctx.beginPath(); ctx.arc(point.x, point.y, 3, 0, Math.PI * 2); ctx.fill();
            ctx.font = "11px Lato";
            ctx.fillText(waveLabel(blip.waveName), point.x + 8, point.y - 8);
        }
    }

    // Positional loops glow at their positions with their level, labelled, so even quiet ones show.
    const labelled = new Map(); // position -> labels already drawn there, to stack them
    rowElements.forEach((pieces, row) => {
        if (row.kind !== "loop" || row.isAmbient) return;
        const point = toScreen(engine.positions[row.positionIndex], metrics);
        const strength = row.volumeTarget > 0 ? 1 : 0.4; // fading-out loops dim down
        const radius = 14 + pieces.level * 26;
        const gradient = ctx.createRadialGradient(point.x, point.y, 2, point.x, point.y, radius);
        gradient.addColorStop(0, accent((0.3 + 0.5 * pieces.level) * strength));
        gradient.addColorStop(1, accent(0));
        ctx.fillStyle = gradient;
        ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill();

        const stack = labelled.get(row.positionIndex) || 0;
        labelled.set(row.positionIndex, stack + 1);
        ctx.fillStyle = accent(0.9 * strength);
        ctx.font = "11px Lato";
        ctx.fillText(waveLabel(row.waveName), point.x + 12, point.y + 18 + stack * 13);
    });

    // The eight positions; the ones this soundscape uses are lit.
    const used = new Set();
    engine.rows().forEach(row => { if (!row.isAmbient && !row.isRandom && row.positionIndex >= 0) used.add(row.positionIndex); });
    ctx.font = "bold 10px Lato";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    engine.positions.forEach((position, index) => {
        const point = toScreen(position, metrics);
        const lit = used.has(index);
        const active = index === draggedPosition || index === hoveredPosition;
        ctx.fillStyle = lit ? accent(active ? 0.5 : 0.3) : `rgba(255, 255, 255, ${active ? 0.15 : 0.05})`;
        ctx.strokeStyle = lit ? accent(0.9) : "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.rect(point.x - 8, point.y - 8, 16, 16); ctx.fill(); ctx.stroke();
        ctx.fillStyle = lit ? "rgb(240, 240, 240)" : "rgba(255, 255, 255, 0.45)";
        ctx.fillText(String(index), point.x, point.y + 0.5);
    });
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    // The listener, facing forward.
    ctx.fillStyle = "rgb(240, 240, 240)";
    ctx.beginPath();
    ctx.moveTo(center, center - 9);
    ctx.lineTo(center + 6, center + 6);
    ctx.lineTo(center, center + 3);
    ctx.lineTo(center - 6, center + 6);
    ctx.closePath();
    ctx.fill();
}

/* Frame loop */

let lastFrame = performance.now();

function renderFrame(now) {
    requestAnimationFrame(renderFrame);
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;

    renderMeters(deltaSeconds);
    renderRadar(now);
    renderStatus();
}

function renderStatus() {
    let state = "stopped";
    let text = `Stopped · ${soundscapeCount} soundscapes`;
    if (soundscapeCount === null) { state = "busy"; text = "Loading soundscapes"; }
    else if (soundscapeCount === 0) text = "Couldn't load the soundscapes";
    else if (loading) { state = "busy"; text = "Loading sounds"; }
    else if (playing) { state = "playing"; text = "Playing"; }
    if (statusLabel.dataset.state !== state) statusLabel.dataset.state = state;
    if (statusLabel.textContent !== text) statusLabel.textContent = text;
}

requestAnimationFrame(renderFrame);

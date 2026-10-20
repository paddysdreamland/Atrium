// Experimental mixer version of pd_music.js. The playback engine (tempo-matching, beat-synced
// transitions, dynamic layer handling, 8-channel export) is the same; on top of it this adds a
// persistent mixer graph (channel faders, solo, master filter and volume), real level meters, a
// spectrum display, a beat clock, bar-quantized toggles, fade-out stop and a stereo mixdown export.
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

const musicButton = document.getElementById("music-start");
const musicTransition = document.getElementById("music-transition");
const musicReset = document.getElementById("music-reset");
const musicDownload = document.getElementById("music-download");
const mixdownDownload = document.getElementById("mixer-download-stereo");
const shuffleButton = document.getElementById("mixer-shuffle");

var trackName;
var trackNameClean;

const trackSelector = document.getElementById("track-selector");
const layerSelectors = [
    document.getElementById("layers-selector1"),
    document.getElementById("layers-selector2"),
    document.getElementById("layers-selector3"),
    document.getElementById("layers-selector4")
];
const loadingIndicator = document.getElementById("volume-loading");
const currentBPMDisplay = document.getElementById("current-bpm");

const quantizeCheckbox = document.getElementById("mixer-quantize");
const fadeStopCheckbox = document.getElementById("mixer-fade-stop");
const transitionLengthSelector = document.getElementById("mixer-transition-length");

const volumeBars = [
    document.getElementById("volume-bar1"),
    document.getElementById("volume-bar2"),
    document.getElementById("volume-bar3"),
    document.getElementById("volume-bar4"),
    document.getElementById("volume-bar5"),
    document.getElementById("volume-bar6"),
    document.getElementById("volume-bar7"),
    document.getElementById("volume-bar8")
];

var alreadyPlaying = false;
var trackLength;
let gainNodes = [];
let sourceNodes = [];
let retiredNodeSets = []; // outgoing node sets still fading out from transitions, pending cleanup

// Bumped by Stop, so a Start or Transition that was still loading when Stop was pressed throws
// its sources away instead of starting to play into a stopped mixer.
let playbackToken = 0;
let loadingTrack = false;
let renderingMix = false;
let transitionEndsAt = 0;     // audioContext time the current crossfade finishes
let playingSelection = null;  // [main, layer1..4] values of what is actually playing

// Stops and disconnects a set of sources and gains (safe to call more than once).
function disposeNodeSet(sources, gains) {
    sources.forEach(source => {
        try { source.stop(); } catch (e) { /* already stopped */ }
        source.disconnect();
    });
    gains.forEach(gainNode => gainNode.disconnect());
}
var currentTrackBPM = null;    // effective (sounding) tempo of the mix, used for selector coloring

// Tempo-mixing state. The mix runs at masterTempo (BPM); every track is played at
// playbackRate = masterTempo / nativeBPM so differing-BPM tracks stay beat-locked.
// A running beat count lets new tracks be dropped in on the beat.
var masterTempo = null;
var beatRefTime = 0;           // audioContext time of the beat reference
var beatRefBeats = 0;          // beats elapsed at beatRefTime (mix runs at constant masterTempo since then)
var tempoGlideToken = 0;       // invalidates pending tempo-glide re-anchors when superseded
const tempoGlideDuration = 4;  // seconds to glide the mix to a new track's native tempo (Adapt mode)
const stopFadeDuration = 1.5;  // seconds Stop takes to ease the mix out when Fade Out on Stop is on
var mixLoop = null;            // { beats, octave } of the master group's loop, for the loop position bar

/* Mixer Graph */

// Persistent mixer graph, built once. Each track's per-layer fade gains feed a layer bus (channel
// fader and solo), which is metered, then everything runs through the master filter (a low-pass
// into a high-pass) and the master fader to the speakers. Transitions just plug a new set of
// sources into the same buses, so fader and filter settings carry across tracks.
const filterResonance = 4; // dB of resonance on the master filter, gives the sweep some bite

function createMeterAnalyser(context) {
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    return analyser;
}

const layerBuses = [];
const layerAnalysers = [];
const masterLowpass = audioContext.createBiquadFilter();
const masterHighpass = audioContext.createBiquadFilter();
const masterGain = audioContext.createGain();
const masterSplitter = audioContext.createChannelSplitter(2);
const masterAnalysers = [createMeterAnalyser(audioContext), createMeterAnalyser(audioContext)];
const spectrumAnalyser = audioContext.createAnalyser();

masterLowpass.type = "lowpass";
masterHighpass.type = "highpass";
masterLowpass.frequency.value = audioContext.sampleRate / 2; // start fully open, not at the 350Hz default
masterHighpass.frequency.value = 10;
masterLowpass.Q.value = filterResonance;
masterHighpass.Q.value = filterResonance;
spectrumAnalyser.fftSize = 2048;
spectrumAnalyser.smoothingTimeConstant = 0.8;
spectrumAnalyser.minDecibels = -90;
spectrumAnalyser.maxDecibels = -15; // more headroom than the -30dB default, which pins loud mixes to the top

for (let i = 0; i < 8; i++) {
    const bus = audioContext.createGain();
    const analyser = createMeterAnalyser(audioContext);
    bus.connect(analyser).connect(masterLowpass);
    layerBuses.push(bus);
    layerAnalysers.push(analyser);
}

masterLowpass.connect(masterHighpass).connect(masterGain).connect(audioContext.destination);
masterGain.connect(masterSplitter);
masterSplitter.connect(masterAnalysers[0], 0);
masterSplitter.connect(masterAnalysers[1], 1);
masterGain.connect(spectrumAnalyser);

const channelFaderGains = [1, 1, 1, 1];
const channelSoloed = [false, false, false, false];
const channelQueuedUntil = [0, 0, 0, 0]; // audioContext time a quantized toggle actually starts
const channelLocked = [false, false, false, false]; // locked channels are left alone by Dynamic Layer Handling

// The layer pairs every soundtrack is split into. Each channel plays one of them from its own
// track, by default the pair matching its position, but any channel can be set to any pair (two
// percussion channels from different tracks, say). The channel's position still decides its bus,
// toggles and download channels; its role only decides which layer files it loads.
const channelRoles = [
    { name: "Percussion", layers: "Layers 1 & 2", description: "Typically drums and snares" },
    { name: "Drones", layers: "Layers 3 & 4", description: "Commonly background drones and humming tones" },
    { name: "Variety", layers: "Layers 5 & 6", description: "Varied sound elements" },
    { name: "Ambience", layers: "Layers 7 & 8", description: "Generally ambient sounds" }
];
const channelRoleIndices = [0, 1, 2, 3];

// The layer file keys a channel loads from a track, e.g. ["layer1", "layer2"] for percussion.
function channelLayerKeys(groupIndex) {
    const role = channelRoleIndices[groupIndex];
    return [`layer${(role * 2) + 1}`, `layer${(role * 2) + 2}`];
}
var masterFaderGain = 1;
var filterPosition = 0;                  // -100 (full low-pass) .. 0 (off) .. 100 (full high-pass)

// Fader position (0-100) to gain, on a squared curve so the travel feels even to the ear.
function faderToGain(position) {
    const x = position / 100;
    return x * x;
}

function formatGainDB(gain) {
    if (gain <= 0.0001) return "-∞ dB";
    const db = 20 * Math.log10(gain);
    return `${db > -0.05 ? "0.0" : db.toFixed(1)} dB`;
}

// What a channel's bus should be at: its fader, or silent when another channel is soloed.
function channelBusGain(groupIndex) {
    if (channelSoloed.some(Boolean) && !channelSoloed[groupIndex]) return 0;
    return channelFaderGains[groupIndex];
}

function applyChannelGains() {
    const now = audioContext.currentTime;
    for (let groupIndex = 0; groupIndex < 4; groupIndex++) {
        const target = channelBusGain(groupIndex);
        layerBuses[groupIndex * 2].gain.setTargetAtTime(target, now, 0.02);
        layerBuses[(groupIndex * 2) + 1].gain.setTargetAtTime(target, now, 0.02);
    }
}

// A DJ-style single filter knob: left sweeps a low-pass down from 20kHz to 200Hz, right sweeps a
// high-pass up from 20Hz to 6kHz, both exponentially so the knob travel sounds even.
function filterFrequencies(position, sampleRate) {
    const amount = Math.abs(position) / 100;
    const nyquist = sampleRate / 2;
    if (position < 0) return { lowpass: Math.min(20000, nyquist) * Math.pow(200 / 20000, amount), highpass: 10 };
    if (position > 0) return { lowpass: nyquist, highpass: 20 * Math.pow(6000 / 20, amount) };
    return { lowpass: nyquist, highpass: 10 };
}

function formatFrequency(frequency) {
    return frequency >= 1000 ? `${(frequency / 1000).toFixed(1)} kHz` : `${Math.round(frequency)} Hz`;
}

function applyFilter() {
    const { lowpass, highpass } = filterFrequencies(filterPosition, audioContext.sampleRate);
    masterLowpass.frequency.setTargetAtTime(lowpass, audioContext.currentTime, 0.03);
    masterHighpass.frequency.setTargetAtTime(highpass, audioContext.currentTime, 0.03);

    let label = "Filter Off";
    if (filterPosition < 0) label = `LPF ${formatFrequency(lowpass)}`;
    else if (filterPosition > 0) label = `HPF ${formatFrequency(highpass)}`;
    document.getElementById("mixer-filter-value").textContent = label;
}

// Mirrors a range input's position into --fill so the track can show how far it is pushed.
function updateRangeFill(input) {
    const percent = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty("--fill", `${percent}%`);
}

const mixerElement = document.querySelector(".mixer");
const mixerStrips = Array.from(document.querySelectorAll(".mixer-strip[data-group]"));
const masterStrip = document.querySelector(".mixer-strip-master");

mixerStrips.forEach(strip => {
    const groupIndex = Number(strip.dataset.group);
    const fader = strip.querySelector(".mixer-fader");
    const faderValue = strip.querySelector(".mixer-fader-value");
    const solo = strip.querySelector(".mixer-solo");
    const lock = strip.querySelector(".mixer-lock");

    const updateFader = () => {
        channelFaderGains[groupIndex] = faderToGain(fader.value);
        faderValue.textContent = formatGainDB(channelFaderGains[groupIndex]);
        updateRangeFill(fader);
        applyChannelGains();
    };

    fader.addEventListener("input", updateFader);
    fader.addEventListener("dblclick", () => { fader.value = 100; updateFader(); });
    solo.addEventListener("change", () => {
        channelSoloed[groupIndex] = solo.checked;
        applyChannelGains();
    });

    lock.addEventListener("change", () => channelLocked[groupIndex] = lock.checked);

    // Browsers can restore form values on reload, so sync the graph to whatever the inputs show.
    channelSoloed[groupIndex] = solo.checked;
    channelLocked[groupIndex] = lock.checked;
    updateFader();
});

/* Channel Roles */

// Shows a channel's role on its strip: name, layer numbers, selector tooltip and the menu's tick.
function applyChannelRole(groupIndex) {
    const strip = mixerStrips[groupIndex];
    const role = channelRoles[channelRoleIndices[groupIndex]];
    strip.querySelector(".mixer-strip-name").textContent = role.name;
    strip.querySelector(".mixer-strip-layers").textContent = role.layers;
    layerSelectors[groupIndex].title = `Track used for ${role.layers.toLowerCase()}, ${role.description.toLowerCase()}`;
    strip.querySelectorAll(".mixer-role-option").forEach(item => {
        item.setAttribute("aria-checked", String(Number(item.dataset.role) === channelRoleIndices[groupIndex]));
    });
}

// Opens one strip's role menu (closing any other), or closes them all when strip is null.
function setRoleMenuOpen(strip, open) {
    mixerStrips.forEach(other => {
        const isOpen = open && other === strip;
        other.querySelector(".mixer-role-menu").hidden = !isOpen;
        other.querySelector(".mixer-strip-role").setAttribute("aria-expanded", String(isOpen));
        other.classList.toggle("is-menu-open", isOpen);
    });
    if (open && strip) strip.querySelector('.mixer-role-option[aria-checked="true"]').focus();
}

mixerStrips.forEach((strip, groupIndex) => {
    const head = strip.querySelector(".mixer-strip-head");
    const toggle = head.querySelector(".mixer-strip-role");
    const menu = document.createElement("div");
    menu.className = "mixer-role-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    channelRoles.forEach((role, roleIndex) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "mixer-role-option";
        item.setAttribute("role", "menuitemradio");
        item.dataset.role = roleIndex;
        item.innerHTML = `<b>${role.name}</b><small>${role.layers} · ${role.description}</small>`;
        item.addEventListener("click", () => {
            channelRoleIndices[groupIndex] = roleIndex;
            applyChannelRole(groupIndex);
            updateNowPlaying();
            setRoleMenuOpen(null, false);
            toggle.focus();
        });
        menu.appendChild(item);
    });

    // Arrow keys move through the options, Escape closes back to the arrow button.
    menu.addEventListener("keydown", event => {
        const items = Array.from(menu.querySelectorAll(".mixer-role-option"));
        const index = items.indexOf(document.activeElement);
        if (event.key === "ArrowDown") items[(index + 1) % items.length].focus();
        else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length].focus();
        else if (event.key === "Escape") { setRoleMenuOpen(null, false); toggle.focus(); }
        else return;
        event.preventDefault();
    });

    head.appendChild(menu);
    toggle.addEventListener("click", () => setRoleMenuOpen(strip, menu.hidden));
    applyChannelRole(groupIndex);
});

document.addEventListener("click", event => {
    if (!event.target.closest(".mixer-strip-head")) setRoleMenuOpen(null, false);
});

(() => {
    const fader = document.getElementById("mixer-master");
    const faderValue = masterStrip.querySelector(".mixer-fader-value");
    const updateMaster = () => {
        masterFaderGain = faderToGain(fader.value);
        masterGain.gain.setTargetAtTime(masterFaderGain, audioContext.currentTime, 0.02);
        faderValue.textContent = formatGainDB(masterFaderGain);
        updateRangeFill(fader);
    };
    fader.addEventListener("input", updateMaster);
    fader.addEventListener("dblclick", () => { fader.value = 100; updateMaster(); });
    updateMaster();

    const filter = document.getElementById("mixer-filter");
    const updateFilter = () => {
        // Small dead zone around the centre so it's easy to land back on "off".
        filterPosition = Math.abs(filter.value) < 3 ? 0 : Number(filter.value);
        updateRangeFill(filter);
        applyFilter();
    };
    filter.addEventListener("input", updateFilter);
    filter.addEventListener("dblclick", () => { filter.value = 0; updateFilter(); });
    updateFilter();
})();

const volumeLoadingBar = document.getElementById("volume-loading-bar");
const volumeLoadingPercentage = document.getElementById("volume-loading-percentage");
var loadPercentage = 0;

function resetLoadingBar() {
    loadPercentage = 0;
    volumeLoadingBar.style.width = "0%";
    volumeLoadingPercentage.innerHTML = "0%";
}

async function loadAudio(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();

    loadPercentage += 12.5;
    volumeLoadingBar.style.width = parseInt(loadPercentage) + "%";
    volumeLoadingPercentage.innerHTML = parseInt(loadPercentage) + "%";

    return await audioContext.decodeAudioData(arrayBuffer);
}

// What a group inside each top-level category of `music` is called in the selector headers.
// Categories not listed here fall back to their own name with a trailing "s" trimmed.
const categoryGroupLabels = {
    Districts: "District",
    Missions: "Mission",
    Experiments: "Experimental"
};

function groupLabelForCategory(category) {
    return categoryGroupLabels[category] || category.replace(/s$/, "");
}

function populateTrackSelector() {
    for (const category in music) {
        const groupLabel = groupLabelForCategory(category);

        for (const district in music[category]) {
            const titleOption = document.createElement("option");
            titleOption.text = `${groupLabel}: ${district}`;
            titleOption.disabled = true;
            titleOption.style.fontWeight = "bold";
            titleOption.style.color = "gray";

            trackSelector.appendChild(titleOption);
            layerSelectors.forEach(layerSelector => layerSelector.appendChild(titleOption.cloneNode(true)));

            for (const track in music[category][district]) {
                const option = document.createElement("option");
                option.value = `${category}.${district}.${track}`;
                // Readable names, so the narrow channel selectors still show which track is which.
                const trackBPM = getBPMFromTrackName(track);
                option.text = prettyTrackName(track) + (trackBPM ? ` · ${trackBPM} BPM` : "");
                option.title = track;

                trackSelector.appendChild(option);
                layerSelectors.forEach(layerSelector => layerSelector.appendChild(option.cloneNode(true)));
            }
        }
    }
}

function getBPMFromTrackName(trackName) {
    const bpmMatch = trackName.match(/(\d+_?\d*)BPM/);
    return bpmMatch ? parseFloat(bpmMatch[1].replace("_", ".")) : null;
}

// "Districts.Anchor.ME_Music_Anchor_Act1_Combat_8CH_138BPM" -> "Anchor · Act 1 · Combat"
function prettyTrackName(trackKey) {
    return trackKey.split(".").pop()
        .replace(/^ME_Music_/, "")
        .replace(/_\d+CH_.*$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/Act(\d|All)/g, "Act $1")
        .split("_").join(" · ");
}

// While playing, shows the mix's current (maintained/adapted) tempo; when stopped, shows the BPM
// the main-selected track would start at.
function updateCurrentBPMDisplay() {
    const bpm = (alreadyPlaying && currentTrackBPM) ? currentTrackBPM : getBPMFromTrackName(trackSelector.value);
    currentBPMDisplay.innerHTML = `<span class="mixer-bpm-value">${bpm ? bpm : "N/A"}</span> BPM`;
}

// How a BPM relates to a reference BPM: "exact", "octave" (half/double) or "off".
function bpmRelation(bpm, referenceBPM) {
    if (!bpm || !referenceBPM) return "";

    // Apply a tolerance for floating-point comparisons
    if (Math.abs(bpm - referenceBPM) < 0.01) return "exact";
    if (Math.abs(bpm - referenceBPM / 2) < 0.01 || Math.abs(bpm - referenceBPM * 2) < 0.01) return "octave";
    return "off";
}

// Colors a select's track options by how their BPM relates to a reference BPM:
// green = exact match, yellow = half/double, red = anything else. Options without a
// BPM (district/mission headers) are left untouched; a null reference clears coloring.
function colorSelectorByBPM(selectorElement, referenceBPM) {
    const relationColors = {
        exact: "rgb(128, 255, 128)",  // Greenish for exact match
        octave: "rgb(255, 255, 128)", // Yellowish for half or double
        off: "rgb(255, 128, 128)"     // Reddish for other
    };

    Array.from(selectorElement.options).forEach(option => {
        const optionBPM = getBPMFromTrackName(option.value);
        if (!optionBPM) return;
        option.style.color = relationColors[bpmRelation(optionBPM, referenceBPM)] || "";
    });
}

function updateLayerSelectorColors() {
    const mainTrackBPM = getBPMFromTrackName(trackSelector.value);
    if (!mainTrackBPM) return;

    layerSelectors.forEach(layerSelector => colorSelectorByBPM(layerSelector, mainTrackBPM));
}

// During playback, colors the main track selector relative to the playing track's BPM
// so green/yellow options flag beat-syncable transition targets. Clears when stopped.
function updateTrackSelectorColors() {
    colorSelectorByBPM(trackSelector, alreadyPlaying ? currentTrackBPM : null);
}

// Each channel strip shows its track's tempo, tinted by how it sits against the main soundtrack.
function updateChannelBadges() {
    const mainBPM = getBPMFromTrackName(trackSelector.value);
    mixerStrips.forEach((strip, groupIndex) => {
        const badge = strip.querySelector(".mixer-strip-badge");
        const bpm = getBPMFromTrackName(layerSelectors[groupIndex].value || trackSelector.value);
        badge.innerHTML = bpm ? `${bpm}<span class="mixer-badge-unit"> BPM</span>` : "";
        badge.dataset.match = bpmRelation(bpm, mainBPM);
    });
}

// [main, track1..4, role1..4]: everything that decides what a Start or Transition loads.
function currentSelection() {
    return [trackSelector.value, ...layerSelectors.map(selector => selector.value), ...channelRoleIndices.map(String)];
}

// The deck's title area: what's playing (or what Start would play), and where it's from.
function updateNowPlaying() {
    const selection = (alreadyPlaying && playingSelection) ? playingSelection : currentSelection();
    const title = document.getElementById("mixer-title");
    const subtitle = document.getElementById("mixer-subtitle");

    if (!selection[0]) {
        title.textContent = "No soundtrack selected";
        subtitle.textContent = "Pick a main soundtrack to begin";
        return;
    }

    const [category, district] = selection[0].split(".");
    const borrowed = selection.slice(1, 5).filter(layerKey => layerKey && layerKey !== selection[0]).length;
    const rearranged = selection.slice(5).some((role, groupIndex) => Number(role) !== groupIndex);
    title.textContent = prettyTrackName(selection[0]);
    subtitle.textContent = `${groupLabelForCategory(category)}: ${district}` +
        (borrowed ? ` · ${borrowed} channel${borrowed > 1 ? "s" : ""} from other tracks` : "") +
        (rearranged ? " · Custom channel layout" : "");
}

trackSelector.addEventListener("change", () => {
    const selectedTrackValue = trackSelector.value;
    if (selectedTrackValue) {
        layerSelectors.forEach(layerSelector => layerSelector.value = selectedTrackValue);
    }
    updateLayerSelectorColors(); // Update colors based on the selected track BPM
    updateCurrentBPMDisplay();
    updateChannelBadges();
    updateNowPlaying();
});

layerSelectors.forEach(layerSelector => layerSelector.addEventListener("change", () => {
    updateChannelBadges();
    updateNowPlaying();
}));

// Total beats elapsed on the running mix clock (the mix runs at constant masterTempo since beatRefTime).
function currentBeats() {
    if (!masterTempo) return 0;
    return beatRefBeats + (audioContext.currentTime - beatRefTime) * masterTempo / 60;
}

// Seconds until the next bar line on the mix clock (bars taken as 4 beats) when Quantize to Bar
// is on and the mix has a tempo; otherwise 0, so changes start straight away.
function quantizeDelay() {
    if (!quantizeCheckbox.checked || !alreadyPlaying || !masterTempo) return 0;
    const beats = currentBeats();
    const nextBar = (Math.floor(beats / 4) + 1) * 4;
    return (nextBar - beats) * 60 / masterTempo;
}

// Remembers the master group's loop so the deck can draw its position on the mix clock.
function setMixLoop(loopSeconds, bpm, rate) {
    mixLoop = (masterTempo && bpm && loopSeconds > 0)
        ? { beats: loopSeconds * bpm / 60, octave: rate * bpm / masterTempo }
        : null;
}

// The power-of-two multiple of mixTempo nearest (geometrically) to nativeBPM. Octave multiples stay
// beat-aligned, so matching to the nearest octave keeps a layer near its own speed while staying synced.
function nearestOctaveTempo(mixTempo, nativeBPM) {
    const k = Math.round(Math.log2(nativeBPM / mixTempo));
    return mixTempo * Math.pow(2, k);
}

// The exact musical length of a decoded loop, in seconds. MP3 decoding leaves the encoder's delay
// and padding on the buffer, so its raw duration overshoots a whole number of beats by ~50-70ms
// (e.g. 160.135 beats instead of 160). Rounding to the nearest beat count recovers the length the
// music was actually written to, and trims that padding off the end of the loop.
function musicalLoopLength(bufferDuration, bpm) {
    if (!bpm || bufferDuration <= 0) return bufferDuration;
    const beats = bufferDuration * bpm / 60;
    if (beats < 1) return bufferDuration;
    const loop = Math.round(beats) * 60 / bpm;
    // Only ever trim: if the buffer is a touch short of the beat boundary, loop all of it.
    return loop <= bufferDuration ? loop : bufferDuration;
}

// Loads all 8 layers for the given track (respecting per-layer selector overrides),
// creates panned/looping sources started at volume 0, and returns the new node sets.
// options:
//   targetTempo – tempo to play it at; with the native BPM this sets playbackRate (pitch-shifts)
//   sync        – when true, the loops start on the current mix beat so they stay beat-locked
async function loadTrackSources(trackKey, { targetTempo = null, sync = false } = {}) {
    // Each layer group can be a different track with its own BPM. The first group is the
    // master loop (it defines the loop length and the mix's native tempo). Every group is
    // tempo-matched to the mix tempo *independently*, so only off-tempo layers get pitch-shifted.
    const groupKeys = layerSelectors.map(selector => selector.value || trackKey);
    const groupBPMs = groupKeys.map(getBPMFromTrackName);
    const nativeBPM = groupBPMs[0];

    const layers = await Promise.all(groupKeys.map(async (groupKey, groupIndex) => {
        const selectedLayerKeys = groupKey.split('.');
        const selectedLayerTrack = music[selectedLayerKeys[0]][selectedLayerKeys[1]][selectedLayerKeys[2]];
        const [firstLayer, secondLayer] = channelLayerKeys(groupIndex); // the pair this channel's role plays

        return [
            await loadAudio(selectedLayerTrack[firstLayer]),
            await loadAudio(selectedLayerTrack[secondLayer])
        ];
    }));

    const duration = layers[0][0]?.duration || 0;
    const startTime = audioContext.currentTime;

    // Mix tempo to play at: an explicit target (a transition), else the master group's own BPM.
    const mixTempo = targetTempo || nativeBPM;

    const sources = [];
    const gains = [];
    const groupRates = [];
    const groupOffsets = [];
    const groupLoops = [];

    layers.forEach((bufferPair, groupIndex) => {
        const groupBPM = groupBPMs[groupIndex];
        const groupDuration = bufferPair[0]?.duration || 0;

        // Loop each group over its exact musical length. Looping the raw buffer instead replays the
        // MP3 padding every pass, so a group slips ~50-70ms further off the beat grid each time
        // round, and groups of differing length smear against each other until the mix is mush.
        const groupLoop = musicalLoopLength(groupDuration, groupBPM);
        const loopBeats = (groupBPM && groupLoop > 0) ? groupLoop * groupBPM / 60 : 0;
        groupLoops.push(groupLoop);

        // Tempo-match to the nearest octave of the mix tempo (not the mix tempo itself), so a fast
        // layer plays near its own speed at double/quad time instead of being dragged way down.
        const matchedTempo = (groupBPM && mixTempo) ? nearestOctaveTempo(mixTempo, groupBPM) : mixTempo;
        const groupRate = (groupBPM && matchedTempo) ? matchedTempo / groupBPM : 1;
        groupRates.push(groupRate);

        // Beat-align each group's loop start to the running mix clock. The group runs at `octave`
        // times the grid's beat rate (its tempo is octave*mixTempo), so scale the beat phase by it.
        let groupOffset = 0;
        if (sync && groupBPM && loopBeats > 0) {
            const octave = mixTempo ? matchedTempo / mixTempo : 1;
            let phase = (currentBeats() * octave) % loopBeats;
            if (phase < 0) phase += loopBeats;
            groupOffset = (phase * 60 / groupBPM) % groupLoop;
        }
        groupOffsets.push(groupOffset);

        bufferPair.forEach((buffer, index) => {
            const source = audioContext.createBufferSource();
            const gainNode = audioContext.createGain();
            source.buffer = buffer;
            source.playbackRate.value = groupRate;

            const panner = audioContext.createStereoPanner();
            panner.pan.value = index === 0 ? -1 : 1;

            // Into this layer's bus on the mixer graph, rather than straight to the speakers.
            gainNode.gain.value = 0;
            source.connect(panner).connect(gainNode).connect(layerBuses[(groupIndex * 2) + index]);
            source.loop = true;
            if (groupLoop > 0 && groupLoop <= buffer.duration) {
                source.loopStart = 0;
                source.loopEnd = groupLoop;
            }
            source.start(startTime, groupOffset);

            sources.push(source);
            gains.push(gainNode);
        });
    });

    // Report the audible loop period (group 0's musical length), which is what the fade timings and
    // the dynamic-handling interval are measured against.
    return { sources, gains, duration: groupLoops[0] || duration, startTime, startOffset: groupOffsets[0], rate: groupRates[0], nativeBPM, groupBPMs, groupRates };
}

// Fades each layer group toward its current muted state (0 if muted, 1 if active).
function applyMuteStateWithFade(fadeDuration, delay = 0) {
    for (let groupIndex = 0; groupIndex < 4; groupIndex++) {
        const targetVolume = layerGroupsMuted[groupIndex] ? 0 : 1;
        fadeLayerVolume(groupIndex * 2, targetVolume, fadeDuration, delay);
        fadeLayerVolume((groupIndex * 2) + 1, targetVolume, fadeDuration, delay);
    }
}

async function playSelectedTrack(trackKey, sessionToken) {
    const mainBPM = getBPMFromTrackName(trackKey);
    const { sources, gains, duration, startTime, nativeBPM, groupBPMs, groupRates } = await loadTrackSources(trackKey, { targetTempo: mainBPM, sync: false });

    // Stopped while loading: throw the freshly loaded sources away.
    if (sessionToken !== playbackToken) {
        disposeNodeSet(sources, gains);
        return;
    }

    loadingTrack = false;
    loadingIndicator.style.display = "none";
    sourceNodes = sources;
    gainNodes = gains;
    trackLength = duration;

    // The main selector defines the mix tempo (not the first layer, which may be overridden);
    // reset the beat clock to the downbeat every group starts on.
    masterTempo = mainBPM || nativeBPM;
    beatRefTime = startTime;
    beatRefBeats = 0;
    tempoGlideToken++;
    currentTrackBPM = masterTempo;
    setMixLoop(duration, groupBPMs[0], groupRates[0]);
    updateTrackSelectorColors();
    updateCurrentBPMDisplay();
    updateNowPlaying();

    applyMuteStateWithFade(trackLength / 32);

    if (document.getElementById("starter-layer-checkbox5").checked == true) {
        startDynamicHandling();
    }
}

const instantFadeDuration = 0.02; // an "instant" cut still ramps for 20ms, so it doesn't click

// How long a crossfade takes, from the Transition Length option.
function transitionFadeDuration(loopDuration) {
    const choice = transitionLengthSelector.value;
    if (choice === "instant") return instantFadeDuration;
    if (choice === "short" && masterTempo) return 8 * 60 / masterTempo; // two bars on the mix clock
    if (choice === "long") return loopDuration / 4;
    return loopDuration / 8;
}

// Crossfades from the currently playing track to the newly selected one,
// keeping the active/muted layer groups consistent across the transition.
async function transitionToTrack() {
    if (!alreadyPlaying) return;

    const selectedTrack = trackSelector.value;
    if (!selectedTrack) {
        alert("Please select a track to transition to.");
        return;
    }

    const sessionToken = playbackToken;
    const selection = currentSelection();

    resetLoadingBar();
    loadingIndicator.style.display = "block";
    loadingTrack = true;

    trackName = selectedTrack.trim();
    trackNameClean = trackName.split('.').pop();

    const maintainBPM = document.getElementById("starter-layer-checkbox6").checked;

    // Play the incoming track at the current mix tempo (when we have one) so it beat-locks;
    // its native BPM is resolved from the first layer inside loadTrackSources.
    const { sources, gains, duration, startTime, startOffset, nativeBPM, groupBPMs, groupRates } =
        await loadTrackSources(selectedTrack, { targetTempo: masterTempo, sync: !!masterTempo });

    if (sessionToken !== playbackToken || !alreadyPlaying) {
        disposeNodeSet(sources, gains);
        return;
    }

    const oldSources = sourceNodes;
    const oldGainNodes = gainNodes;

    // The mix tempo follows the main track selector, not the (possibly overridden) first layer.
    const incomingBPM = getBPMFromTrackName(selectedTrack) || nativeBPM;
    const canTempoMatch = !!(masterTempo && incomingBPM);

    loadingTrack = false;
    loadingIndicator.style.display = "none";

    const fadeDuration = transitionFadeDuration(duration);
    const fadeDelay = quantizeDelay(); // with Quantize to Bar, the crossfade starts on the next bar line

    // Swap globals to the new nodes, then crossfade old out and new in together.
    sourceNodes = sources;
    gainNodes = gains;
    trackLength = duration;
    playingSelection = selection;
    transitionEndsAt = audioContext.currentTime + fadeDelay + fadeDuration;

    applyMuteStateWithFade(fadeDuration, fadeDelay);
    oldGainNodes.forEach(gainNode => rampGain(gainNode, 0, fadeDuration, fadeDelay));

    // Track the outgoing set so Stop can kill it immediately; otherwise let it finish fading out.
    const retiredSet = { sources: oldSources, gains: oldGainNodes };
    retiredNodeSets.push(retiredSet);
    setTimeout(() => {
        disposeNodeSet(oldSources, oldGainNodes);
        retiredNodeSets = retiredNodeSets.filter(set => set !== retiredSet);
    }, ((fadeDelay + fadeDuration) * 1000) + 100);

    const token = ++tempoGlideToken; // invalidates any pending glide; identifies this transition

    if (maintainBPM || !canTempoMatch || Math.abs(incomingBPM - masterTempo) < 0.01) {
        // Maintain BPM (or the incoming tempo already equals the mix tempo): keep the mix tempo,
        // so the beat clock continues uninterrupted. Bootstrap it if we had no tempo yet.
        if (!masterTempo && incomingBPM) {
            masterTempo = incomingBPM;
            beatRefTime = startTime;
            beatRefBeats = 0;
            currentTrackBPM = masterTempo;
        }
        setMixLoop(duration, groupBPMs[0], groupRates[0]);
    } else {
        // Adapt: after the crossfade, glide the mix from the current tempo to the incoming track's
        // tempo (each group to its nearest-octave rate for the new tempo), then re-anchor the clock.
        // An Instant transition jumps straight to the new tempo instead of gliding into it.
        const glideDuration = transitionLengthSelector.value === "instant" ? 0 : tempoGlideDuration;
        const now = audioContext.currentTime;
        const startGlide = now + fadeDelay + fadeDuration;
        const endGlide = startGlide + glideDuration;

        const endRates = groupBPMs.map(bpm => bpm ? nearestOctaveTempo(incomingBPM, bpm) / bpm : 1);

        sources.forEach((source, i) => {
            const group = Math.floor(i / 2);
            if (glideDuration > 0) {
                source.playbackRate.setValueAtTime(groupRates[group], startGlide);
                source.playbackRate.linearRampToValueAtTime(endRates[group], endGlide);
            } else {
                source.playbackRate.setValueAtTime(endRates[group], startGlide);
            }
        });

        setMixLoop(duration, groupBPMs[0], groupRates[0]);

        // Group 0's buffer position when the glide ends (integral of its rate ramp), converted to
        // master beats — group 0 ends running at endRate0 = octave x the new grid beat rate.
        const startRate0 = groupRates[0];
        const endRate0 = endRates[0];
        const posAtEnd = (startOffset + startRate0 * (startGlide - startTime) + ((startRate0 + endRate0) / 2) * glideDuration) % duration;
        setTimeout(() => {
            if (token !== tempoGlideToken) return; // superseded by a newer transition
            masterTempo = incomingBPM;
            beatRefTime = audioContext.currentTime;
            beatRefBeats = posAtEnd * incomingBPM / (60 * endRate0);
            currentTrackBPM = masterTempo;
            setMixLoop(duration, groupBPMs[0], endRate0);
            updateTrackSelectorColors();
            updateCurrentBPMDisplay();
        }, (endGlide - now) * 1000 + 50);
    }

    updateTrackSelectorColors();
    updateCurrentBPMDisplay();
    updateNowPlaying();

    // Restart dynamic handling so its interval matches the new track length.
    if (document.getElementById("starter-layer-checkbox5").checked == true) {
        startDynamicHandling();
    }
}

// Ramps a gain to targetVolume over fadeDuration, optionally holding its current value for
// `delay` seconds first (used to land quantized changes on the next bar).
function rampGain(gainNode, targetVolume, fadeDuration, delay = 0) {
    const currentTime = audioContext.currentTime;
    const startTime = currentTime + delay;
    gainNode.gain.cancelScheduledValues(currentTime);
    gainNode.gain.setValueAtTime(gainNode.gain.value, currentTime);
    if (delay > 0) gainNode.gain.setValueAtTime(gainNode.gain.value, startTime);
    gainNode.gain.linearRampToValueAtTime(targetVolume, startTime + fadeDuration);
}

function fadeLayerVolume(layerIndex, targetVolume, fadeDuration, delay = 0) {
    if (gainNodes[layerIndex]) {
        rampGain(gainNodes[layerIndex], targetVolume, fadeDuration, delay);
    }
}

function setLayerVolume(layerIndex, volume) {
    if (gainNodes[layerIndex]) {
        gainNodes[layerIndex].gain.value = volume;
    }
}

var layerGroup1Muted;
var layerGroup2Muted;
var layerGroup3Muted;
var layerGroup4Muted;
var layerGroupsForFade = 0;
let previousSelectedLayerGroups = [];
var layerGroupsMuted = [];
let dynamicHandlingInterval;

function startDynamicHandling() {
    clearInterval(dynamicHandlingInterval);

    dynamicHandlingInterval = setInterval( () => {
        function countPlayingGroups() {
            return layerGroupsMuted.filter(muted => !muted).length;
        }

        function toggleLayerGroup1() {
            if (layerGroup1Muted == true) {
                layerGroup1Muted = false;
                fadeLayerVolume(0, 1, trackLength / 4);
                fadeLayerVolume(1, 1, trackLength / 4);
            } else if (countPlayingGroups() > 2) {
                layerGroup1Muted = true;
                fadeLayerVolume(0, 0, trackLength / 4);
                fadeLayerVolume(1, 0, trackLength / 4);
            }
            layerGroupsMuted[0] = layerGroup1Muted;
        }

        function toggleLayerGroup2() {
            if (layerGroup2Muted == true) {
                layerGroup2Muted = false;
                fadeLayerVolume(2, 1, trackLength / 4);
                fadeLayerVolume(3, 1, trackLength / 4);
            } else if (countPlayingGroups() > 2) {
                layerGroup2Muted = true;
                fadeLayerVolume(2, 0, trackLength / 4);
                fadeLayerVolume(3, 0, trackLength / 4);
            }
            layerGroupsMuted[1] = layerGroup2Muted;
        }

        function toggleLayerGroup3() {
            if (layerGroup3Muted == true) {
                layerGroup3Muted = false;
                fadeLayerVolume(4, 1, trackLength / 4);
                fadeLayerVolume(5, 1, trackLength / 4);
            } else if (countPlayingGroups() > 2) {
                layerGroup3Muted = true;
                fadeLayerVolume(4, 0, trackLength / 4);
                fadeLayerVolume(5, 0, trackLength / 4);
            }
            layerGroupsMuted[2] = layerGroup3Muted;
        }

        function toggleLayerGroup4() {
            if (layerGroup4Muted == true) {
                layerGroup4Muted = false;
                fadeLayerVolume(6, 1, trackLength / 4);
                fadeLayerVolume(7, 1, trackLength / 4);
            } else if (countPlayingGroups() > 2) {
                layerGroup4Muted = true;
                fadeLayerVolume(6, 0, trackLength / 4);
                fadeLayerVolume(7, 0, trackLength / 4);
            }
            layerGroupsMuted[3] = layerGroup4Muted;
        }

        function selectRandomLayerGroup() {
            // Locked channels are never picked. If the recently picked ones are all that's left
            // unlocked, allow them again; with every channel locked there's nothing to pick.
            const unlockedLayerGroups = [0, 1, 2, 3].filter(group => !channelLocked[group]);
            let availableLayerGroups = unlockedLayerGroups.filter(group => !previousSelectedLayerGroups.includes(group));
            if (!availableLayerGroups.length) availableLayerGroups = unlockedLayerGroups;
            if (!availableLayerGroups.length) return undefined;

            let selectedLayerGroup = availableLayerGroups[Math.floor(Math.random() * availableLayerGroups.length)];
            if (previousSelectedLayerGroups.length >= 2) {
                previousSelectedLayerGroups.shift();
            }
            previousSelectedLayerGroups.push(selectedLayerGroup);
            return selectedLayerGroup;
        }

        function toggleLayerGroupWithCheck() {
            let attempts = 0;
            let selectedGroup;
            do {
                selectedGroup = selectRandomLayerGroup();
                attempts++;
            } while (countPlayingGroups() === 2 && layerGroupsMuted[selectedGroup] === false && attempts < 10);

            return selectedGroup;
        }

        layerGroupsForFade = Math.ceil(Math.random() * 2);

        for (let i = 0; i < layerGroupsForFade; i++) {
            let selectedLayerGroup = toggleLayerGroupWithCheck();

            if (selectedLayerGroup == 0) {
                toggleLayerGroup1();
            } else if (selectedLayerGroup == 1) {
                toggleLayerGroup2();
            } else if (selectedLayerGroup == 2) {
                toggleLayerGroup3();
            } else if (selectedLayerGroup == 3) {
                toggleLayerGroup4();
            }
        }

        console.log("--[Current Muted Layers]----------------\n" + "Layer 1: " + layerGroupsMuted[0] + "\n" + "Layer 2: " + layerGroupsMuted[1] + "\n" + "Layer 3: " + layerGroupsMuted[2] + "\n" + "Layer 4: " + layerGroupsMuted[3] + "\n" + "----------------------------------------");

    }, (trackLength * 1000));
}

document.addEventListener("DOMContentLoaded", () => {
    populateTrackSelector();
    updateCurrentBPMDisplay();
    updateChannelBadges();
    updateNowPlaying();
    requestAnimationFrame(renderMixer);
});

function resetVariables() {
    if (document.getElementById("starter-layer-checkbox1").checked == false) {
        layerGroup1Muted = true;
        layerGroupsMuted[0] = true;
    } else {
        layerGroup1Muted = false;
        layerGroupsMuted[0] = false;
    }

    if (document.getElementById("starter-layer-checkbox2").checked == false) {
        layerGroup2Muted = true;
        layerGroupsMuted[1] = true;
    } else {
        layerGroup2Muted = false;
        layerGroupsMuted[1] = false;
    }

    if (document.getElementById("starter-layer-checkbox3").checked == false) {
        layerGroup3Muted = true;
        layerGroupsMuted[2] = true;
    } else {
        layerGroup3Muted = false;
        layerGroupsMuted[2] = false;
    }

    if (document.getElementById("starter-layer-checkbox4").checked == false) {
        layerGroup4Muted = true;
        layerGroupsMuted[3] = true;
    } else {
        layerGroup4Muted = false;
        layerGroupsMuted[3] = false;
    }
}

musicButton.addEventListener("click", async function () {
    if (alreadyPlaying) return;

    const selectedTrack = trackSelector.value;
    if (selectedTrack) {
        audioContext.resume();
        alreadyPlaying = true;
        resetVariables();
        resetLoadingBar();
        loadingIndicator.style.display = "block";
        loadingTrack = true;
        playingSelection = currentSelection();

        musicButton.style.display = "none";
        musicTransition.style.display = "";
        musicReset.style.display = "";

        trackName = selectedTrack.trim();
        trackNameClean = trackName.split('.').pop();

        try {
            await playSelectedTrack(selectedTrack, ++playbackToken);
        } catch (error) {
            console.error("Couldn't load the soundtrack:", error);
            musicReset.click();
        }
    } else {
        alert("Please select a track to play.");
    }
});

// A failed load (a missing file, say) leaves the current track playing rather than the loader stuck.
function transitionSafely() {
    transitionToTrack().catch(error => {
        console.error("Couldn't load the transition:", error);
        loadingTrack = false;
        loadingIndicator.style.display = "none";
    });
}

musicTransition.addEventListener("click", transitionSafely);

function setLayerGroupMuted(groupIndex, muted) {
    const targetVolume = muted ? 0 : 1;
    const delay = quantizeDelay();
    channelQueuedUntil[groupIndex] = audioContext.currentTime + delay;
    fadeLayerVolume(groupIndex * 2, targetVolume, trackLength / 8, delay);
    fadeLayerVolume((groupIndex * 2) + 1, targetVolume, trackLength / 8, delay);

    layerGroupsMuted[groupIndex] = muted;
    if (groupIndex === 0) layerGroup1Muted = muted;
    else if (groupIndex === 1) layerGroup2Muted = muted;
    else if (groupIndex === 2) layerGroup3Muted = muted;
    else if (groupIndex === 3) layerGroup4Muted = muted;
}

[1, 2, 3, 4].forEach(groupNumber => {
    document.getElementById(`starter-layer-checkbox${groupNumber}`).addEventListener("change", function () {
        if (!alreadyPlaying) return;
        setLayerGroupMuted(groupNumber - 1, !this.checked);
    });
});

document.getElementById("starter-layer-checkbox5").addEventListener("change", function () {
    if (!alreadyPlaying) return;
    if (this.checked) {
        startDynamicHandling();
    } else {
        clearInterval(dynamicHandlingInterval);
    }
});

musicReset.addEventListener("click", function () {
    playbackToken++;
    loadingTrack = false;
    loadingIndicator.style.display = "none";
    resetLoadingBar();

    // Everything currently sounding, including tracks still mid-crossfade from a transition.
    const soundingSets = [{ sources: sourceNodes, gains: gainNodes }, ...retiredNodeSets];
    if (fadeStopCheckbox.checked && sourceNodes.length) {
        soundingSets.forEach(set => set.gains.forEach(gainNode => rampGain(gainNode, 0, stopFadeDuration)));
        setTimeout(() => soundingSets.forEach(set => disposeNodeSet(set.sources, set.gains)), (stopFadeDuration * 1000) + 100);
    } else {
        soundingSets.forEach(set => disposeNodeSet(set.sources, set.gains));
    }

    sourceNodes = [];
    gainNodes = [];
    retiredNodeSets = [];
    alreadyPlaying = false;
    playingSelection = null;
    transitionEndsAt = 0;
    clearInterval(dynamicHandlingInterval);
    resetVariables();

    masterTempo = null;
    mixLoop = null;
    tempoGlideToken++;
    currentTrackBPM = null;
    updateTrackSelectorColors();
    updateCurrentBPMDisplay();
    updateNowPlaying();

    musicButton.style.display = "";
    musicTransition.style.display = "none";
    musicReset.style.display = "none";
});

/* Shuffle Layers */

// Points every channel at a random track whose tempo matches the main soundtrack (exactly, or at
// half/double time), so the shuffled mix stays beat-locked. Picks a main soundtrack first if there
// isn't one. While playing, the result is heard on the next Transition.
function shuffleLayers() {
    // Group headers are disabled options with no value attribute, so their .value is their text.
    const trackOptions = Array.from(trackSelector.options).filter(option => option.value && !option.disabled);
    if (!trackOptions.length) return;

    if (!trackSelector.value) {
        trackSelector.value = trackOptions[Math.floor(Math.random() * trackOptions.length)].value;
        trackSelector.dispatchEvent(new Event("change"));
    }

    const mainBPM = getBPMFromTrackName(trackSelector.value);
    const compatible = trackOptions.filter(option => ["exact", "octave"].includes(bpmRelation(getBPMFromTrackName(option.value), mainBPM)));
    const pool = compatible.length ? compatible : trackOptions;

    layerSelectors.forEach(layerSelector => {
        layerSelector.value = pool[Math.floor(Math.random() * pool.length)].value;
    });

    updateLayerSelectorColors();
    updateChannelBadges();
    updateNowPlaying();
}

shuffleButton.addEventListener("click", shuffleLayers);

/* Keyboard Shortcuts */

// Only while the soundtrack section is open, and never while typing or on a focused control that
// already uses the key (Space on a checkbox, letters in a select). The mixer's own buttons are
// taken over, so Space after clicking Download stops the music instead of downloading again.
document.addEventListener("keydown", event => {
    if (mixerElement.offsetParent === null) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

    const target = event.target;
    const tag = target.tagName;
    if (target.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") return;
    if (tag === "BUTTON" && !mixerElement.contains(target)) return;
    if (target.closest(".mixer-strip-head")) return; // the role menus handle their own keys
    if (tag === "INPUT" && target.type !== "range") return;

    const key = event.key.toLowerCase();
    if (key === " ") {
        (alreadyPlaying ? musicReset : musicButton).click();
    } else if (["1", "2", "3", "4"].includes(key)) {
        const checkbox = document.getElementById(`starter-layer-checkbox${key}`);
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
    } else if (key === "t") {
        if (alreadyPlaying) transitionSafely();
    } else if (key === "r") {
        shuffleLayers();
    } else {
        return;
    }
    event.preventDefault();
});

/* Visuals */

// One entry per meter: 8 layer meters (two per channel strip), then the master left/right pair.
// Layers are hard-panned and an analyser reads a mono downmix, which halves them, hence the boost.
const meterFloorDB = -48;
const meterSamples = new Float32Array(1024);
const meters = [
    ...mixerStrips.flatMap(strip => Array.from(strip.querySelectorAll(".mixer-meter"))),
    ...masterStrip.querySelectorAll(".mixer-meter")
].map((element, index) => ({
    fill: element.querySelector(".mixer-meter-fill"),
    peakMarker: element.querySelector(".mixer-meter-peak"),
    analyser: index < 8 ? layerAnalysers[index] : masterAnalysers[index - 8],
    boost: index < 8 ? 2 : 1,
    level: 0,
    peak: 0,
    peakHeldAt: 0
}));

// Peak sample of the analyser's latest block, as a 0..1 meter height on a dB scale.
function readMeterLevel(meter) {
    meter.analyser.getFloatTimeDomainData(meterSamples);
    let peak = 0;
    for (let i = 0; i < meterSamples.length; i++) {
        const sample = Math.abs(meterSamples[i]);
        if (sample > peak) peak = sample;
    }
    peak *= meter.boost;
    if (peak <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - (20 * Math.log10(peak)) / meterFloorDB));
}

// Meters jump up instantly and fall back smoothly; the peak marker holds for a second, then drops.
function renderMeters(now, deltaSeconds) {
    meters.forEach(meter => {
        const target = readMeterLevel(meter);
        meter.level = Math.max(target, meter.level - deltaSeconds * 1.5);

        if (meter.level >= meter.peak) {
            meter.peak = meter.level;
            meter.peakHeldAt = now;
        } else if (now - meter.peakHeldAt > 1000) {
            meter.peak = Math.max(meter.level, meter.peak - deltaSeconds * 0.6);
        }

        meter.fill.style.clipPath = `inset(${((1 - meter.level) * 100).toFixed(1)}% 0 0 0)`;
        meter.peakMarker.style.bottom = `${(meter.peak * 100).toFixed(1)}%`;
        meter.peakMarker.style.opacity = meter.peak > 0.01 ? "1" : "0";
    });
}

// The thin hazard bars under each fader: each layer's fade automation, as the original player showed.
function renderFadeBars() {
    volumeBars.forEach((volumeBar, index) => {
        const gainNode = gainNodes[index];
        volumeBar.style.width = gainNode ? `${gainNode.gain.value * 100}%` : "0%";
    });
}

function renderStripStates() {
    const anySolo = channelSoloed.some(Boolean);
    mixerStrips.forEach((strip, groupIndex) => {
        strip.classList.toggle("is-silent", alreadyPlaying && layerGroupsMuted[groupIndex] === true);
        strip.classList.toggle("is-soloed-out", anySolo && !channelSoloed[groupIndex]);
        strip.classList.toggle("is-queued", alreadyPlaying && audioContext.currentTime < channelQueuedUntil[groupIndex]);
    });
}

const mixerStatus = document.getElementById("mixer-status");
const mixerPosition = document.getElementById("mixer-position");
const mixerLoopBar = document.getElementById("mixer-loop-bar");
const beatLeds = Array.from(document.querySelectorAll(".mixer-led"));

function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

function renderStatus() {
    const pending = alreadyPlaying && playingSelection && currentSelection().some((value, i) => value !== playingSelection[i]);
    musicTransition.classList.toggle("is-pending", !!pending);

    let state = "stopped";
    let text = "Stopped";
    if (renderingMix) {
        state = "busy"; text = "Rendering download";
    } else if (loadingTrack) {
        state = "busy"; text = "Loading layers";
    } else if (alreadyPlaying && audioContext.currentTime < transitionEndsAt) {
        state = "busy"; text = "Transitioning";
    } else if (alreadyPlaying) {
        state = "playing"; text = pending ? "Playing · Changes pending" : "Playing";
    }

    if (mixerStatus.dataset.state !== state) mixerStatus.dataset.state = state;
    setText(mixerStatus, text);
}

// Beat LEDs, bar.beat counter and loop position, all read off the mix clock.
function renderBeatClock() {
    if (!alreadyPlaying || !masterTempo || !sourceNodes.length) {
        beatLeds.forEach(led => led.classList.remove("is-on"));
        setText(mixerPosition, "0.0");
        mixerLoopBar.style.width = "0%";
        return;
    }

    const beats = Math.max(0, currentBeats());
    const beatInBar = Math.floor(beats) % 4;
    beatLeds.forEach((led, index) => {
        led.classList.toggle("is-on", index === beatInBar);
        if (index === beatInBar) led.style.setProperty("--pulse", (1 - (beats % 1)).toFixed(2));
    });
    setText(mixerPosition, `${Math.floor(beats / 4) + 1}.${beatInBar + 1}`);

    if (mixLoop) {
        const progress = ((beats * mixLoop.octave) % mixLoop.beats) / mixLoop.beats;
        mixerLoopBar.style.width = `${(progress * 100).toFixed(2)}%`;
    }
}

// Log-spaced spectrum bars of the master output, tinted with the site's custom color.
const spectrumCanvas = document.getElementById("mixer-spectrum");
const spectrumContext = spectrumCanvas.getContext("2d");
const spectrumData = new Uint8Array(spectrumAnalyser.frequencyBinCount);
const spectrumBands = 64;
let customColor = "0, 255, 192";
let customColorCheckedAt = -Infinity;

function renderSpectrum(now) {
    const width = spectrumCanvas.clientWidth;
    const height = spectrumCanvas.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    if (spectrumCanvas.width !== Math.round(width * pixelRatio) || spectrumCanvas.height !== Math.round(height * pixelRatio)) {
        spectrumCanvas.width = Math.round(width * pixelRatio);
        spectrumCanvas.height = Math.round(height * pixelRatio);
    }

    // The custom color can be changed from Customization at any time; re-read it now and then.
    if (now - customColorCheckedAt > 500) {
        customColor = getComputedStyle(document.documentElement).getPropertyValue("--custom-color").trim() || customColor;
        customColorCheckedAt = now;
    }

    spectrumContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    spectrumContext.clearRect(0, 0, width, height);
    spectrumAnalyser.getByteFrequencyData(spectrumData);

    const binHz = audioContext.sampleRate / spectrumAnalyser.fftSize;
    const gap = 2;
    const barWidth = (width - gap * (spectrumBands - 1)) / spectrumBands;

    for (let band = 0; band < spectrumBands; band++) {
        const lowBin = Math.floor(30 * Math.pow(16000 / 30, band / spectrumBands) / binHz);
        const highBin = Math.max(lowBin + 1, Math.ceil(30 * Math.pow(16000 / 30, (band + 1) / spectrumBands) / binHz));

        let value = 0;
        for (let bin = lowBin; bin < highBin && bin < spectrumData.length; bin++) {
            value = Math.max(value, spectrumData[bin]);
        }
        value /= 255;

        const barHeight = Math.max(2, value * height);
        spectrumContext.fillStyle = `rgba(${customColor}, ${(0.2 + value * 0.8).toFixed(2)})`;
        spectrumContext.fillRect(band * (barWidth + gap), height - barHeight, barWidth, barHeight);
    }
}

let lastFrameTime = performance.now();

function renderMixer(now) {
    requestAnimationFrame(renderMixer);
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    if (mixerElement.offsetParent === null) return; // section closed, nothing to draw

    renderMeters(now, deltaSeconds);
    renderFadeBars();
    renderStripStates();
    renderStatus();
    renderBeatClock();
    renderSpectrum(now);
}

// Download Feature

// Bakes the current selection. "multichannel" is the 8-channel WAV for replacing the game's music
// (raw layers, one per channel, in channel-strip order, so a rearranged channel layout is baked as
// arranged); "stereo" is a mixdown of what you hear, with the channel faders,
// solo, panning, master filter and master fader applied.
async function renderAndDownloadMix(mode) {
    if (renderingMix || loadingTrack) return;

    const selectedTrack = trackSelector.value;
    if (!selectedTrack) {
        alert("Please select a track to download.");
        return;
    }
    trackNameClean = selectedTrack.split('.').pop();

    renderingMix = true;
    resetLoadingBar();
    loadingIndicator.style.display = "block";

    try {
        // Bake at the maintained mix tempo (the live tempo when playing, else the main selection's BPM).
        const mixTempo = (alreadyPlaying && masterTempo) ? masterTempo : getBPMFromTrackName(selectedTrack);

        const groupKeys = layerSelectors.map(selector => selector.value || selectedTrack);
        const groupBPMs = groupKeys.map(getBPMFromTrackName);
        const groupRates = groupBPMs.map(bpm => (bpm && mixTempo) ? nearestOctaveTempo(mixTempo, bpm) / bpm : 1);

        // Load every layer up front (we need durations to size the render).
        const groupBuffers = await Promise.all(groupKeys.map(async (groupKey, index) => {
            const keys = groupKey.split('.');
            const track = music[keys[0]][keys[1]][keys[2]];
            const [firstLayer, secondLayer] = channelLayerKeys(index);
            return [
                await loadAudio(track[firstLayer]),
                await loadAudio(track[secondLayer])
            ];
        }));

        // Stack each active layer's loop to a shared length so none cut off mid-loop. Each layer is
        // tempo-matched to the grid, so its loop is a whole number of beats; the LCM of those beat
        // counts is the shortest length where every active layer ends on a clean loop boundary.
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const lcm = (a, b) => a / gcd(a, b) * b;

        const activeLoops = [];
        groupBuffers.forEach((bufferPair, index) => {
            if (!document.getElementById(`starter-layer-checkbox${index + 1}`).checked) return;
            const bufferDuration = musicalLoopLength(bufferPair[0]?.duration || 0, groupBPMs[index]);
            if (bufferDuration <= 0) return;
            const loopSeconds = bufferDuration / (groupRates[index] || 1); // audible loop length at its play rate
            const beats = mixTempo ? Math.max(1, Math.round(loopSeconds * mixTempo / 60)) : null;
            activeLoops.push({ loopSeconds, beats });
        });

        let renderDuration;
        if (mixTempo && activeLoops.length && activeLoops.every(loop => loop.beats)) {
            let totalBeats = activeLoops.reduce((acc, loop) => lcm(acc, loop.beats), 1);
            // Safety cap so near-coprime loop lengths can't produce an enormous file (~10 min max).
            const maxBeats = Math.ceil(600 * mixTempo / 60);
            if (totalBeats > maxBeats) totalBeats = activeLoops[0].beats;
            renderDuration = totalBeats * 60 / mixTempo;
        } else {
            // No tempo reference: fall back to the longest active loop (or the master group's loop).
            const longestActive = activeLoops.reduce((max, loop) => Math.max(max, loop.loopSeconds), 0);
            renderDuration = longestActive || musicalLoopLength(groupBuffers[0][0]?.duration || 0, groupBPMs[0]) / (groupRates[0] || 1);
        }

        if (renderDuration <= 0) {
            alert("Could not determine track length to download.");
            return;
        }

        const stereo = mode === "stereo";
        const sampleRate = audioContext.sampleRate;
        const offlineContext = new OfflineAudioContext(stereo ? 2 : 8, Math.ceil(sampleRate * renderDuration), sampleRate);

        // Where each layer ends up: its own channel of the merger, or the offline copy of the mixer graph.
        let merger;
        let mixInput;
        if (stereo) {
            const lowpass = offlineContext.createBiquadFilter();
            const highpass = offlineContext.createBiquadFilter();
            const output = offlineContext.createGain();
            const { lowpass: lowpassFrequency, highpass: highpassFrequency } = filterFrequencies(filterPosition, sampleRate);
            lowpass.type = "lowpass";
            highpass.type = "highpass";
            lowpass.frequency.value = lowpassFrequency;
            highpass.frequency.value = highpassFrequency;
            lowpass.Q.value = filterResonance;
            highpass.Q.value = filterResonance;
            output.gain.value = masterFaderGain;
            lowpass.connect(highpass).connect(output).connect(offlineContext.destination);
            mixInput = lowpass;
        } else {
            merger = offlineContext.createChannelMerger(8);
            merger.connect(offlineContext.destination);
        }

        groupBuffers.forEach((bufferPair, index) => {
            // Only bake the layers whose Active Layers checkbox is ticked; the rest stay silent.
            if (!document.getElementById(`starter-layer-checkbox${index + 1}`).checked) return;

            bufferPair.forEach((buffer, sub) => {
                const source = offlineContext.createBufferSource();
                source.buffer = buffer;
                source.playbackRate.value = groupRates[index]; // tempo-match, preserving the maintained BPM
                source.loop = true;                            // fill the whole render window
                const bakedLoop = musicalLoopLength(buffer.duration, groupBPMs[index]);
                if (bakedLoop > 0 && bakedLoop <= buffer.duration) {
                    source.loopStart = 0;                      // trim MP3 padding so repeats stay on the beat
                    source.loopEnd = bakedLoop;
                }

                if (stereo) {
                    const panner = offlineContext.createStereoPanner();
                    const channelGain = offlineContext.createGain();
                    panner.pan.value = sub === 0 ? -1 : 1;
                    channelGain.gain.value = channelBusGain(index);
                    source.connect(panner).connect(channelGain).connect(mixInput);
                } else {
                    source.connect(merger, 0, (index * 2) + sub);
                }
                source.start(0);
            });
        });

        const renderedBuffer = await offlineContext.startRendering();
        downloadWAV(renderedBuffer, stereo ? "_Mixdown.wav" : "_Custom.wav");
    } finally {
        renderingMix = false;
        if (!loadingTrack) loadingIndicator.style.display = "none";
    }
}

// Function to download the multi-channel WAV file
function downloadWAV(buffer, fileSuffix) {
    const wavData = encodeMultiChannelWAV(buffer);
    const blob = new Blob([wavData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.download = trackNameClean + fileSuffix;
    downloadLink.style.display = "none";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(downloadLink);
}

// Updated WAV encoding function for multi-channel support
function encodeMultiChannelWAV(buffer) {
    const numberOfChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numberOfChannels * 2 + 44;
    const wav = new DataView(new ArrayBuffer(length));

    // RIFF header
    writeString(wav, 0, 'RIFF');
    wav.setUint32(4, length - 8, true);
    writeString(wav, 8, 'WAVE');
    writeString(wav, 12, 'fmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, numberOfChannels, true);
    wav.setUint32(24, sampleRate, true);
    wav.setUint32(28, sampleRate * numberOfChannels * 2, true);
    wav.setUint16(32, numberOfChannels * 2, true);
    wav.setUint16(34, 16, true);
    writeString(wav, 36, 'data');
    wav.setUint32(40, length - 44, true);

    // Audio data: Write each sample from each channel
    let offset = 44;
    const channels = Array.from({ length: numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    for (let i = 0; i < buffer.length; i++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const sample = Math.max(-1, Math.min(1, channels[channel][i]));
            wav.setInt16(offset, sample * 32767, true);
            offset += 2;
        }
    }

    return wav;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Attach to download buttons
musicDownload.addEventListener("click", () => renderAndDownloadMix("multichannel"));
mixdownDownload.addEventListener("click", () => renderAndDownloadMix("stereo"));

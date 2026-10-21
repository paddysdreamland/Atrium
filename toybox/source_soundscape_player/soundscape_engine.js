// Source Soundscape Player - engine.
//
// A port of the Source SDK 2013 client soundscape system (src/game/client/c_soundscape.cpp) to the
// Web Audio API. The soundscape logic follows the SDK code closely: script parsing, playlooping /
// playrandom / playsoundscape, intervals, sound levels, slot reuse between soundscapes, the linear
// soundscape_fadetime crossfade and the random sound scheduling. What the SDK leaves to the closed
// engine (distance falloff, stereo panning, DSP room effects) is approximated, and marked as such.
//
// No DOM access in here; soundscape_player.js drives it and draws what it reports.

/* KeyValues */

// Parses Valve KeyValues text into [{ key, value }] / [{ key, children }] nodes, keeping order and
// duplicate keys (soundscapes repeat "playlooping", "wave" and so on). Handles quoted and bare
// tokens, // comments and [$PLATFORM] conditionals.
function parseKeyValues(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
        if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
        if (c === "{" || c === "}") { tokens.push({ type: c }); i++; continue; }
        if (c === "[") {
            const end = text.indexOf("]", i);
            tokens.push({ type: "condition", text: text.slice(i + 1, end < 0 ? text.length : end) });
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        if (c === "\"") {
            const end = text.indexOf("\"", i + 1);
            tokens.push({ type: "string", text: text.slice(i + 1, end < 0 ? text.length : end) });
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        let j = i;
        while (j < text.length && !" \t\r\n{}\"[".includes(text[j])) j++;
        tokens.push({ type: "string", text: text.slice(i, j) });
        i = j;
    }

    // This is a PC build: Windows-only conditionals pass, console/other-OS ones don't.
    const conditionHolds = condition => condition.split("||").some(part => {
        const negated = part.trim().startsWith("!");
        const platform = part.replace(/[!$\s]/g, "").toUpperCase();
        const holds = ["WIN32", "WINDOWS", "PC"].includes(platform);
        return negated ? !holds : holds;
    });

    let position = 0;
    const parseBlock = () => {
        const nodes = [];
        while (position < tokens.length) {
            const token = tokens[position];
            if (token.type === "}") { position++; break; }
            if (token.type !== "string") { position++; continue; }
            const key = token.text;
            position++;
            let keep = true;
            if (tokens[position]?.type === "condition") keep = conditionHolds(tokens[position++].text) && keep;

            let node = null;
            if (tokens[position]?.type === "{") {
                position++;
                node = { key, children: parseBlock() };
            } else if (tokens[position]?.type === "string") {
                node = { key, value: tokens[position++].text };
            }
            if (tokens[position]?.type === "condition") keep = conditionHolds(tokens[position++].text) && keep;
            if (node && keep) nodes.push(node);
        }
        return nodes;
    };
    return parseBlock();
}

/* Source helpers (interval.cpp, soundflags.h, soundchars.h, SoundEmitterSystem) */

// ReadInterval: "start,end" -> { start, range }, parsed like atof (so junk reads as 0).
function readInterval(text) {
    const parts = String(text).split(",");
    const start = parseFloat(parts[0]) || 0;
    const range = parts.length > 1 ? (parseFloat(parts[1]) || 0) - start : 0;
    return { start, range };
}

function randomInterval(interval) {
    return interval.start + (interval.range !== 0 ? Math.random() * interval.range : 0);
}

// ATTN_TO_SNDLVL, including the int cast.
function attenuationToSoundLevel(attenuation) {
    return attenuation ? Math.trunc(50 + 20 / attenuation) : 0;
}

const namedSoundLevels = { SNDLVL_NONE: 0, SNDLVL_IDLE: 60, SNDLVL_TALKING: 80, SNDLVL_STATIC: 66, SNDLVL_NORM: 75, SNDLVL_GUNFIRE: 140 };

// TextToSoundLevel: a named level, else the number after "SNDLVL_" (1-180), else SNDLVL_NORM.
function textToSoundLevel(text) {
    const upper = String(text).toUpperCase();
    if (upper in namedSoundLevels) return namedSoundLevels[upper];
    if (upper.startsWith("SNDLVL_")) {
        const level = parseInt(upper.slice(7), 10);
        if (level > 0 && level <= 180) return level;
    }
    return 75;
}

const soundChars = "*?!#@><^)}";

// PSkipSoundChars, plus the path clean-up the Source filesystem does for us: forward slashes and
// lower case (every file on disk is lower case, and the host's filesystem is case-sensitive).
function soundFilePath(waveName) {
    let start = 0;
    while (start < waveName.length && soundChars.includes(waveName[start])) start++;
    return waveName.slice(start).replace(/\\/g, "/").toLowerCase();
}

// "#" anywhere in the leading sound chars means the wave skips the DSP (room) effect.
function isDryMix(waveName) {
    for (const c of waveName) {
        if (!soundChars.includes(c)) return false;
        if (c === "#") return true;
    }
    return false;
}

/* WAV decoding */

// Reads the RIFF chunks Source cares about: the format, the sample data and the loop point. Source
// loops a wave only if it has a cue point or a smpl loop, and loops from there to the end of the
// file; browsers ignore both chunks, so they're read here.
function parseWav(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const tag = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    if (arrayBuffer.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

    const info = { loopStart: null };
    let offset = 12;
    while (offset + 8 <= arrayBuffer.byteLength) {
        const id = tag(offset);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === "fmt ") {
            info.formatTag = view.getUint16(body, true);
            info.channels = view.getUint16(body + 2, true);
            info.sampleRate = view.getUint32(body + 4, true);
            info.blockAlign = view.getUint16(body + 12, true);
            info.bitsPerSample = view.getUint16(body + 14, true);
            if (info.formatTag === 2 && size >= 22) {
                info.samplesPerBlock = view.getUint16(body + 18, true);
                const coefficientCount = view.getUint16(body + 20, true);
                info.coefficients = [];
                for (let i = 0; i < coefficientCount; i++) {
                    info.coefficients.push([view.getInt16(body + 22 + i * 4, true), view.getInt16(body + 24 + i * 4, true)]);
                }
            }
        } else if (id === "data") {
            info.dataOffset = body;
            info.dataLength = Math.min(size, arrayBuffer.byteLength - body);
        } else if (id === "cue " && size >= 28 && view.getUint32(body, true) > 0) {
            info.loopStart = view.getUint32(body + 4 + 20, true); // first cue point's dwSampleOffset
        } else if (id === "smpl" && size >= 60 && view.getUint32(body + 28, true) > 0 && info.loopStart === null) {
            info.loopStart = view.getUint32(body + 36 + 8, true); // first loop's dwStart
        }
        offset = body + size + (size & 1);
    }
    return info;
}

// Microsoft ADPCM (format 2), which no browser decodes. A few HL2 waves use it.
const adpcmAdaptation = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

function decodeMsAdpcm(context, arrayBuffer, info) {
    const bytes = new Uint8Array(arrayBuffer, info.dataOffset, info.dataLength);
    const view = new DataView(arrayBuffer, info.dataOffset, info.dataLength);
    const channels = info.channels;
    const blockAlign = info.blockAlign;
    const headerSize = 7 * channels;

    // Every whole block holds samplesPerBlock frames; a short last block holds what fits.
    const blockFrames = remaining => remaining >= blockAlign ? info.samplesPerBlock : Math.max(0, 2 + Math.floor((remaining - headerSize) * 2 / channels));
    let totalFrames = 0;
    for (let start = 0; start + headerSize <= bytes.length; start += blockAlign) totalFrames += blockFrames(bytes.length - start);

    const output = context.createBuffer(channels, Math.max(1, totalFrames), info.sampleRate);
    const data = Array.from({ length: channels }, (_, c) => output.getChannelData(c));
    let frame = 0;

    for (let start = 0; start + headerSize <= bytes.length; start += blockAlign) {
        const frames = blockFrames(bytes.length - start);
        const predictor = [], delta = [], sample1 = [], sample2 = [];
        let p = start;
        for (let c = 0; c < channels; c++) predictor[c] = Math.min(bytes[p++], info.coefficients.length - 1);
        for (let c = 0; c < channels; c++) { delta[c] = view.getInt16(p, true); p += 2; }
        for (let c = 0; c < channels; c++) { sample1[c] = view.getInt16(p, true); p += 2; }
        for (let c = 0; c < channels; c++) { sample2[c] = view.getInt16(p, true); p += 2; }

        // The header's two samples come out oldest first.
        for (let c = 0; c < channels; c++) {
            data[c][frame] = sample2[c] / 32768;
            if (frames > 1) data[c][frame + 1] = sample1[c] / 32768;
        }

        let written = 2;
        let channel = 0;
        const decodeNibble = nibble => {
            const [c1, c2] = info.coefficients[predictor[channel]];
            const signed = nibble >= 8 ? nibble - 16 : nibble;
            let sample = ((sample1[channel] * c1 + sample2[channel] * c2) >> 8) + signed * delta[channel];
            sample = Math.max(-32768, Math.min(32767, sample));
            sample2[channel] = sample1[channel];
            sample1[channel] = sample;
            delta[channel] = Math.max(16, (adpcmAdaptation[nibble] * delta[channel]) >> 8);
            if (written < frames) data[channel][frame + written] = sample / 32768;
            channel++;
            if (channel === channels) { channel = 0; written++; }
        };

        const end = Math.min(start + blockAlign, bytes.length);
        for (; p < end && written < frames; p++) {
            decodeNibble(bytes[p] >> 4);
            decodeNibble(bytes[p] & 0x0f);
        }
        frame += frames;
    }
    return output;
}

// Decodes a Source wave/mp3 to { buffer, loopStart (seconds) or null }.
async function decodeSourceSound(context, arrayBuffer, path) {
    if (path.endsWith(".wav")) {
        const info = parseWav(arrayBuffer);
        if (info && info.formatTag === 2) {
            const buffer = decodeMsAdpcm(context, arrayBuffer, info);
            return { buffer, loopStart: info.loopStart !== null ? info.loopStart / info.sampleRate : null };
        }
        const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
        const loopStart = info && info.loopStart !== null ? info.loopStart / (info.sampleRate || buffer.sampleRate) : null;
        return { buffer, loopStart };
    }
    // Source never loops mp3s.
    return { buffer: await context.decodeAudioData(arrayBuffer), loopStart: null };
}

/* Spatialization (approximated: this is the closed engine's job) */

const soundReferenceDB = 60;       // snd_refdb
const soundReferenceDistance = 36; // snd_refdist, in units

// Source's distance falloff: gain = 1 / (distance * multiplier), where the multiplier comes from
// the sound level (louder sound levels carry further), capped at full volume.
function distanceGain(soundLevel, distance) {
    if (!soundLevel) return 1;
    const multiplier = (Math.pow(10, soundReferenceDB / 20) / Math.pow(10, soundLevel / 20)) / soundReferenceDistance;
    const relative = distance * multiplier;
    return Math.min(1, relative > 0.1 ? 1 / relative : 10);
}

// Source's stereo spatialization is a linear pan on the listener's right vector:
// left = gain * (1 - dot) / 2, right = gain * (1 + dot) / 2.
function stereoGains(x, y) {
    const distance = Math.hypot(x, y);
    const dotRight = distance > 0 ? x / distance : 0;
    return { left: (1 - dotRight) / 2, right: (1 + dotRight) / 2, distance };
}

/* DSP room types (approximated with synthesized reverbs) */

// The 29 standard room types env_sound / soundscapes pick from. The real presets live in the engine,
// so each family gets a reverb with a similar size and colour instead.
const roomTypes = [
    { name: "Off" },
    { name: "Generic", decay: 0.9, predelay: 0.01, cutoff: 6000, wet: 0.2 },
    { name: "Metal Small", decay: 0.7, predelay: 0.005, cutoff: 9000, wet: 0.32 },
    { name: "Metal Medium", decay: 1.1, predelay: 0.01, cutoff: 8000, wet: 0.34 },
    { name: "Metal Large", decay: 1.7, predelay: 0.015, cutoff: 7000, wet: 0.36 },
    { name: "Tunnel Small", decay: 1.2, predelay: 0.015, cutoff: 5000, wet: 0.34 },
    { name: "Tunnel Medium", decay: 1.8, predelay: 0.02, cutoff: 4500, wet: 0.36 },
    { name: "Tunnel Large", decay: 2.6, predelay: 0.03, cutoff: 4000, wet: 0.38 },
    { name: "Chamber Small", decay: 1.0, predelay: 0.01, cutoff: 6000, wet: 0.3 },
    { name: "Chamber Medium", decay: 1.6, predelay: 0.015, cutoff: 5500, wet: 0.33 },
    { name: "Chamber Large", decay: 2.4, predelay: 0.02, cutoff: 5000, wet: 0.36 },
    { name: "Bright Small", decay: 0.8, predelay: 0.008, cutoff: 12000, wet: 0.28 },
    { name: "Bright Medium", decay: 1.3, predelay: 0.012, cutoff: 11000, wet: 0.3 },
    { name: "Bright Large", decay: 2.0, predelay: 0.016, cutoff: 10000, wet: 0.33 },
    { name: "Water 1", decay: 1.0, predelay: 0.01, cutoff: 900, wet: 0.42, muffle: 1500 },
    { name: "Water 2", decay: 1.5, predelay: 0.015, cutoff: 700, wet: 0.46, muffle: 1100 },
    { name: "Water 3", decay: 2.2, predelay: 0.02, cutoff: 500, wet: 0.5, muffle: 800 },
    { name: "Concrete Small", decay: 0.8, predelay: 0.008, cutoff: 7000, wet: 0.28 },
    { name: "Concrete Medium", decay: 1.3, predelay: 0.012, cutoff: 6500, wet: 0.31 },
    { name: "Concrete Large", decay: 2.0, predelay: 0.018, cutoff: 6000, wet: 0.34 },
    { name: "Big 1", decay: 1.8, predelay: 0.06, cutoff: 5000, wet: 0.24 },
    { name: "Big 2", decay: 2.6, predelay: 0.1, cutoff: 4500, wet: 0.26 },
    { name: "Big 3", decay: 3.4, predelay: 0.15, cutoff: 4000, wet: 0.28 },
    { name: "Cavern Small", decay: 2.2, predelay: 0.03, cutoff: 3500, wet: 0.38 },
    { name: "Cavern Medium", decay: 3.2, predelay: 0.04, cutoff: 3000, wet: 0.42 },
    { name: "Cavern Large", decay: 4.5, predelay: 0.05, cutoff: 2500, wet: 0.46 },
    { name: "Weirdo 1", decay: 2.0, predelay: 0.05, cutoff: 3000, wet: 0.42 },
    { name: "Weirdo 2", decay: 3.0, predelay: 0.08, cutoff: 2500, wet: 0.46 },
    { name: "Weirdo 3", decay: 4.0, predelay: 0.12, cutoff: 2000, wet: 0.5 }
];

const maxImpulseSeconds = 3.5; // longer tails cost a lot of processing for little audible difference

// A stereo impulse response: decaying noise that darkens as it fades, after a short pre-delay and a
// few early reflections. Scaled to unit energy, so a room's wet level is its level next to the dry
// sound (the browser's own normalization leaves long noisy impulses ~30 dB too quiet).
function createRoomImpulse(context, room) {
    const rate = context.sampleRate;
    const length = Math.ceil(Math.min(maxImpulseSeconds, room.predelay + room.decay * 1.2) * rate);
    const impulse = context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        const start = Math.floor(room.predelay * rate);
        let filtered = 0;
        for (let i = start; i < length; i++) {
            const t = (i - start) / rate;
            const cutoff = room.cutoff * (1 - 0.6 * Math.min(1, t / room.decay));
            const smoothing = Math.exp(-2 * Math.PI * cutoff / rate);
            filtered = filtered * smoothing + (Math.random() * 2 - 1) * (1 - smoothing);
            data[i] = filtered * Math.exp(-6.9 * t / room.decay) * 3;
        }
        for (let reflection = 1; reflection <= 4; reflection++) {
            const index = start + Math.floor(rate * (0.007 + Math.random() * 0.03) * reflection);
            if (index < length) data[index] += (Math.random() < 0.5 ? -1 : 1) * 0.5 / reflection;
        }
        // Fade the last 50ms so a capped tail doesn't end in a click.
        const fade = Math.min(length - start, Math.floor(rate * 0.05));
        for (let i = 0; i < fade; i++) data[length - 1 - i] *= i / fade;
    }
    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        let energy = 0;
        for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
        const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
        for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
    return impulse;
}

/* The soundscape system */

const MAX_SOUNDSCAPE_RECURSION = 8;
const DEFAULT_SOUND_RADIUS = 36; // where random-position sounds play, in units around the listener

class SoundscapeSystem {
    constructor(context, { scriptsRoot, soundRoot }) {
        this.context = context;
        this.scriptsRoot = scriptsRoot;
        this.soundRoot = soundRoot;

        this.soundscapes = [];          // [{ name, file, node }] in load order (lookups search from the end, as Source does)
        this.loopingSounds = [];        // looping sound slots, including ones fading out
        this.randomSounds = [];         // random sound commands of the current soundscape
        this.loopingSoundId = 0;
        this.nextRandomTime = 0;
        this.fadeTime = 3;              // soundscape_fadetime
        this.currentSoundscape = null;
        this.roomType = 0;              // persists between soundscapes that don't set "dsp", like the engine's
        this.dspVolume = 1;             // dsp_volume, reverted when a soundscape doesn't set it
        this.dspEnabled = true;
        this.soundMixer = null;
        this.startToken = 0;

        // Positions 0-7, in units relative to the listener (x = right, y = forward), laid out on the
        // radar's 32-unit grid: 0-3 on the corners around the listener, like Valve's playsoundscape
        // preview (which uses 36 units), and 4-7 64 units out along the axes: in front, right, behind
        // and left. (The preview only enables 0-2, a bug that silences position 3, so all 8 are on here.)
        this.positions = [
            { x: -32, y: 32 }, { x: 32, y: 32 }, { x: -32, y: -32 }, { x: 32, y: -32 },
            { x: 0, y: 64 }, { x: 64, y: 0 }, { x: 0, y: -64 }, { x: -64, y: 0 }
        ];
        this.defaultPositions = this.positions.map(position => ({ ...position }));

        this.buffers = new Map();       // path -> Promise<{ buffer, loopStart } | null>
        this.listeners = { rows: [], play: [], status: [] };

        // Output graph: rows feed a dry bus and a DSP send. The send feeds a convolver only while a
        // room effect is on; a room change briefly runs a second one to crossfade into, then drops
        // the old one, so at most one reverb is processing once things settle.
        this.master = context.createGain();
        this.master.connect(context.destination);
        this.dryBus = context.createGain();
        this.muffle = context.createBiquadFilter();
        this.muffle.type = "lowpass";
        this.muffle.frequency.value = context.sampleRate / 2;
        this.dryBus.connect(this.muffle).connect(this.master);
        this.dspSend = context.createGain();
        this.reverbs = [0, 1].map(() => {
            const convolver = context.createConvolver();
            convolver.normalize = false; // the impulses come pre-scaled
            const wet = context.createGain();
            wet.gain.value = 0;
            convolver.connect(wet).connect(this.master);
            return { convolver, wet, room: null, connected: false };
        });
        this.activeReverb = 0;
        this.reverbReleaseTimer = null;
        this.impulses = new Map();

        this.tickTimer = setInterval(() => this.update(), 50);
    }

    on(event, callback) { this.listeners[event].push(callback); }
    emit(event, payload) { this.listeners[event].forEach(callback => callback(payload)); }

    /* Scripts */

    async loadScripts() {
        const manifest = parseKeyValues(await this.fetchText(`${this.scriptsRoot}/soundscapes_manifest.txt`));
        const files = (manifest[0]?.children || []).filter(node => node.key.toLowerCase() === "file").map(node => node.value);
        for (const file of files) {
            let text;
            try {
                text = await this.fetchText(`${this.scriptsRoot}/${file.replace(/^scripts\//i, "")}`);
            } catch (error) {
                console.warn("Soundscape file missing:", file);
                continue;
            }
            // Every root section with children is a soundscape.
            parseKeyValues(text).filter(node => node.children).forEach(node => {
                this.soundscapes.push({ name: node.key, file: file.replace(/^scripts\//i, ""), node });
            });
        }
        return this.soundscapes;
    }

    async fetchText(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return response.text();
    }

    findSoundscape(name) {
        const lower = String(name).toLowerCase();
        for (let i = this.soundscapes.length - 1; i >= 0; i--) {
            if (this.soundscapes[i].name.toLowerCase() === lower) return this.soundscapes[i];
        }
        return null;
    }

    /* Sound loading */

    loadSound(waveName) {
        const path = soundFilePath(waveName);
        if (!this.buffers.has(path)) {
            this.buffers.set(path, (async () => {
                try {
                    const response = await fetch(`${this.soundRoot}/${path}`);
                    if (!response.ok) throw new Error(response.status);
                    return await decodeSourceSound(this.context, await response.arrayBuffer(), path);
                } catch (error) {
                    console.warn("Sound missing or undecodable:", path, error.message);
                    return null;
                }
            })());
        }
        return this.buffers.get(path);
    }

    // Every wave a soundscape can play, sub-soundscapes included (with the same recursion limit).
    collectWaves(node, waves = new Set(), depth = 0) {
        if (depth > MAX_SOUNDSCAPE_RECURSION) return waves;
        for (const command of node.children || []) {
            const key = command.key.toLowerCase();
            if (key === "playlooping" || key === "playrandom") {
                const visit = nodes => nodes.forEach(n => {
                    if (n.key.toLowerCase() === "wave" && n.value) waves.add(n.value);
                    if (n.children) visit(n.children);
                });
                visit(command.children || []);
            } else if (key === "playsoundscape") {
                const name = (command.children || []).find(n => n.key.toLowerCase() === "name")?.value;
                const sub = name && this.findSoundscape(name);
                if (sub) this.collectWaves(sub.node, waves, depth + 1);
            }
        }
        return waves;
    }

    // Loads everything a soundscape needs, then starts it. Picking another one while this is still
    // loading cancels it. Reports progress as status events.
    async playSoundscape(name) {
        const soundscape = name ? this.findSoundscape(name) : null;
        const token = ++this.startToken;
        if (soundscape) {
            const waves = [...this.collectWaves(soundscape.node)];
            let loaded = 0;
            this.emit("status", { loading: true, progress: 0 });
            await Promise.all(waves.map(wave => this.loadSound(wave).then(() => {
                loaded++;
                if (token === this.startToken) this.emit("status", { loading: true, progress: loaded / waves.length });
            })));
            if (token !== this.startToken) return false;
        }
        this.context.resume();
        this.startNewSoundscape(soundscape);
        this.emit("status", { loading: false });
        return true;
    }

    // Fades everything out over the fade time and stops scheduling random sounds.
    stop() {
        this.startToken++;
        this.startNewSoundscape(null, { fadeOut: true });
        this.emit("status", { loading: false });
    }

    /* C_SoundscapeSystem::StartNewSoundscape and friends */

    startNewSoundscape(soundscape, { fadeOut = false } = {}) {
        const now = this.context.currentTime;

        // Fade out the current loops (stopsoundscape cuts them instead; Stop here fades).
        this.loopingSounds.forEach(sound => this.setLoopTarget(sound, 0, !soundscape && !fadeOut));
        this.loopingSoundId++;

        // Random sounds are dropped straight away (anything mid-play finishes on its own).
        this.randomSounds.forEach(sound => this.retireRow(sound));
        this.randomSounds = [];
        this.nextRandomTime = now;
        this.currentSoundscape = soundscape;
        this.soundMixer = null;

        if (soundscape) {
            const params = {
                recurseLevel: 0, masterVolume: 1, startingPosition: 0,
                positionOverride: -1, ambientPositionOverride: -1,
                allowDSP: true, wroteSoundMixer: false, wroteDSPVolume: false,
                via: null
            };
            this.startSubSoundscape(soundscape.node, params);
            if (!params.wroteDSPVolume) this.dspVolume = 1;
            this.applyRoom();
        }
        this.emit("rows");
    }

    startSubSoundscape(node, params) {
        for (const command of node.children || []) {
            const key = command.key.toLowerCase();
            if (key === "dsp") {
                if (params.allowDSP) this.roomType = Math.max(0, Math.min(roomTypes.length - 1, parseInt(command.value, 10) || 0));
            } else if (key === "dsp_player") {
                // Player DSP (underwater, ringing ears...) isn't used by HL2's soundscapes; ignored.
            } else if (key === "playlooping") {
                this.processPlayLooping(command, params);
            } else if (key === "playrandom") {
                this.processPlayRandom(command, params);
            } else if (key === "playsoundscape") {
                this.processPlaySoundscape(command, params);
            } else if (key === "soundmixer") {
                if (params.allowDSP) { this.soundMixer = command.value; params.wroteSoundMixer = true; }
            } else if (key === "dsp_volume") {
                if (params.allowDSP) { this.dspVolume = parseFloat(command.value) || 0; params.wroteDSPVolume = true; }
            }
        }
    }

    processPlayLooping(command, params) {
        let volume = 0;
        let soundLevel = attenuationToSoundLevel(0.8); // ATTN_NORM
        let waveName = null;
        let pitch = 100;
        let positionIndex = -1;
        for (const node of command.children || []) {
            const key = node.key.toLowerCase();
            if (key === "volume") volume = params.masterVolume * randomInterval(readInterval(node.value));
            else if (key === "pitch") pitch = Math.trunc(randomInterval(readInterval(node.value)));
            else if (key === "wave") waveName = node.value;
            else if (key === "position") positionIndex = params.startingPosition + (parseInt(node.value, 10) || 0);
            else if (key === "attenuation") soundLevel = attenuationToSoundLevel(randomInterval(readInterval(node.value)));
            else if (key === "soundlevel") soundLevel = String(node.value).toUpperCase().startsWith("SNDLVL_") ? textToSoundLevel(node.value) : Math.trunc(randomInterval(readInterval(node.value)));
        }

        if (positionIndex < 0) positionIndex = params.ambientPositionOverride;
        else if (params.positionOverride >= 0) positionIndex = params.positionOverride;

        if (volume === 0 || !waveName) return;
        if (positionIndex >= this.positions.length) return; // the position isn't available: suppressed
        this.addLoopingSound(waveName, positionIndex < 0, volume, soundLevel, pitch, positionIndex, params.via);
    }

    processPlayRandom(command, params) {
        const sound = {
            kind: "random", masterVolume: params.masterVolume, via: params.via,
            time: { start: 0, range: 0 }, volume: { start: 0, range: 0 }, pitch: { start: 0, range: 0 },
            soundLevel: { start: 0, range: 0 }, waves: [], isAmbient: false, isRandom: false,
            positionIndex: -1, nextPlayTime: 0, lastWave: null, lastPlayTime: null, instances: 0
        };
        let positionIndex = -1;
        let randomPosition = false;
        for (const node of command.children || []) {
            const key = node.key.toLowerCase();
            if (key === "volume") sound.volume = readInterval(node.value);
            else if (key === "pitch") sound.pitch = readInterval(node.value);
            else if (key === "attenuation") {
                const attenuation = readInterval(node.value);
                sound.soundLevel.start = attenuationToSoundLevel(attenuation.start);
                sound.soundLevel.range = attenuationToSoundLevel(attenuation.start + attenuation.range) - sound.soundLevel.start;
            } else if (key === "soundlevel") {
                if (String(node.value).toUpperCase().startsWith("SNDLVL_")) sound.soundLevel = { start: textToSoundLevel(node.value), range: 0 };
                else sound.soundLevel = readInterval(node.value);
            } else if (key === "time") sound.time = readInterval(node.value);
            else if (key === "rndwave") sound.waves = (node.children || []).filter(n => n.value !== undefined).map(n => n.value);
            else if (key === "position") {
                if (String(node.value).toLowerCase() === "random") randomPosition = true;
                else positionIndex = params.startingPosition + (parseInt(node.value, 10) || 0);
            }
        }

        if (positionIndex < 0) positionIndex = params.ambientPositionOverride;
        else if (params.positionOverride >= 0) {
            positionIndex = params.positionOverride;
            randomPosition = false; // override trumps random position
        }

        if (!sound.waves.length) return;
        if (positionIndex < 0 && !randomPosition) {
            sound.isAmbient = true;
        } else if (randomPosition) {
            sound.isRandom = true;
        } else {
            if (positionIndex >= this.positions.length) return;
            sound.positionIndex = positionIndex;
        }
        this.addRandomSound(sound);
    }

    processPlaySoundscape(command, paramsIn) {
        const subParams = { ...paramsIn, allowDSP: false, recurseLevel: paramsIn.recurseLevel + 1 };
        if (subParams.recurseLevel > MAX_SOUNDSCAPE_RECURSION) {
            console.warn("Soundscape recursion overrun");
            return;
        }
        let name = null;
        for (const node of command.children || []) {
            const key = node.key.toLowerCase();
            if (key === "volume") subParams.masterVolume = paramsIn.masterVolume * randomInterval(readInterval(node.value));
            else if (key === "position") subParams.startingPosition = paramsIn.startingPosition + (parseInt(node.value, 10) || 0);
            else if (key === "positionoverride") {
                if (paramsIn.positionOverride < 0) {
                    subParams.positionOverride = paramsIn.startingPosition + (parseInt(node.value, 10) || 0);
                    subParams.ambientPositionOverride = subParams.positionOverride;
                }
            } else if (key === "ambientpositionoverride") {
                if (paramsIn.ambientPositionOverride < 0) subParams.ambientPositionOverride = paramsIn.startingPosition + (parseInt(node.value, 10) || 0);
            } else if (key === "name") name = node.value;
        }
        const sub = name && this.findSoundscape(name);
        if (!sub) return;
        subParams.via = sub.name;
        this.startSubSoundscape(sub.node, subParams);
    }

    /* Looping sounds */

    // AddLoopingSound: reuses a slot left over from the previous soundscape when it's the same wave
    // at the same pitch (ambients always, positional ones only at the same position), so shared
    // loops carry on and just fade to their new volume instead of restarting.
    addLoopingSound(waveName, isAmbient, volume, soundLevel, pitch, positionIndex, via) {
        let slot = null;
        let restart = false;
        for (let i = this.loopingSounds.length - 1; i >= 0; i--) {
            const sound = this.loopingSounds[i];
            if (sound.id === this.loopingSoundId || sound.pitch !== pitch || sound.waveName.toLowerCase() !== waveName.toLowerCase()) continue;
            if (isAmbient && sound.isAmbient) { slot = sound; break; }
            if (!isAmbient && !sound.isAmbient) {
                slot = sound;
                restart = sound.positionIndex !== positionIndex; // positional sounds move by restarting
                break;
            }
        }

        if (!slot) {
            slot = { kind: "loop", waveName, volumeCurrent: isAmbient ? 0 : 0.05, fade: null, muted: false, soloed: false };
            this.createRow(slot);
            this.loopingSounds.push(slot);
            restart = true;
        } else if (restart) {
            this.stopVoice(slot);
            slot.volumeCurrent = 0.05;
            slot.fade = null;
        }

        Object.assign(slot, { volumeTarget: volume, pitch, id: this.loopingSoundId, isAmbient, positionIndex, soundLevel, via, dry: isDryMix(waveName) });
        this.routeRow(slot);
        if (restart) this.startLoopVoice(slot);
        this.updateSpatial(slot);
        this.setLoopTarget(slot, volume);
    }

    startLoopVoice(slot) {
        slot.ended = false;
        slot.missing = false;
        this.loadSound(slot.waveName).then(sound => {
            if (!this.loopingSounds.includes(slot) || slot.voice) return;
            if (!sound) { slot.missing = true; this.emit("rows"); return; }
            const source = this.context.createBufferSource();
            source.buffer = sound.buffer;
            source.playbackRate.value = slot.pitch / 100;
            // Only waves with a loop point loop (from it to the end); others play once, as in Source.
            if (sound.loopStart !== null && sound.loopStart < sound.buffer.duration) {
                source.loop = true;
                source.loopStart = sound.loopStart;
                // End the loop one frame short of the buffer's end. Chromium 152 (Vivaldi 8.2) gets
                // stuck repeating a sliver at the seam when a loop runs to the very end of buffers of
                // certain lengths (~7% of them); stopping a frame early never does. One frame per loop
                // (~0.02ms) is inaudible.
                source.loopEnd = (sound.buffer.length - 1) / sound.buffer.sampleRate;
            } else {
                source.onended = () => { if (slot.voice === source) { slot.voice = null; slot.ended = true; this.emit("rows"); } };
            }
            source.connect(slot.input);
            source.start();
            slot.voice = source;
            slot.loops = source.loop;
        });
    }

    stopVoice(slot) {
        if (!slot.voice) return;
        slot.voice.onended = null;
        try { slot.voice.stop(); } catch (error) { /* already stopped */ }
        slot.voice.disconnect();
        slot.voice = null;
    }

    // The volume a fading loop is at right now (Source's Approach(), done as a linear ramp).
    loopVolumeAt(slot, time) {
        const fade = slot.fade;
        if (!fade || time >= fade.end) return fade ? fade.target : slot.volumeCurrent;
        return fade.from + (fade.target - fade.from) * (time - fade.start) / (fade.end - fade.start);
    }

    // Ramps a loop toward a target at soundscape_fadetime per full volume step, or cuts it.
    setLoopTarget(slot, target, immediate = false) {
        const now = this.context.currentTime;
        const from = immediate ? target : this.loopVolumeAt(slot, now);
        const duration = this.fadeTime > 0 && !immediate ? Math.abs(target - from) * this.fadeTime : 0;
        slot.volumeTarget = target;
        slot.volumeCurrent = from;
        slot.fade = { from, target, start: now, end: now + duration };
        slot.fadeGain.gain.cancelScheduledValues(now);
        slot.fadeGain.gain.setValueAtTime(from, now);
        slot.fadeGain.gain.linearRampToValueAtTime(target, now + Math.max(duration, 0.02));
    }

    /* Random sounds */

    addRandomSound(sound) {
        this.createRow(sound);
        this.routeRow(sound);
        sound.nextPlayTime = this.context.currentTime + 0.5 * randomInterval(sound.time);
        this.randomSounds.push(sound);
    }

    playRandomSound(sound) {
        const waveName = sound.waves[Math.floor(Math.random() * sound.waves.length)];
        const volume = sound.masterVolume * randomInterval(sound.volume);
        const pitch = Math.trunc(randomInterval(sound.pitch));
        const soundLevel = Math.trunc(randomInterval(sound.soundLevel));

        let position = null;
        if (!sound.isAmbient) {
            if (sound.isRandom) {
                // GenerateRandomSoundPosition: SinCos() takes radians, but is handed -180..180.
                const angle = Math.random() * 360 - 180;
                position = { x: DEFAULT_SOUND_RADIUS * Math.cos(angle), y: DEFAULT_SOUND_RADIUS * Math.sin(angle) };
            } else {
                position = { ...this.positions[sound.positionIndex] };
            }
        }

        sound.lastWave = waveName;
        sound.lastPlayTime = this.context.currentTime;
        this.loadSound(waveName).then(loaded => {
            if (!loaded || volume <= 0) return;
            const source = this.context.createBufferSource();
            source.buffer = loaded.buffer;
            source.playbackRate.value = Math.max(0.01, pitch / 100);

            const gain = this.context.createGain();
            gain.gain.value = volume;
            source.connect(gain);
            if (position) {
                const { input, output } = this.createPanner(position, soundLevel);
                gain.connect(input);
                output.connect(sound.input);
            } else {
                gain.connect(sound.input);
            }
            sound.instances++;
            source.onended = () => {
                sound.instances--;
                source.disconnect();
                if (sound.retired && sound.instances <= 0) this.disposeRow(sound);
            };
            source.start();

            this.emit("play", {
                row: sound, waveName, volume, pitch, soundLevel, position,
                duration: loaded.buffer.duration / Math.max(0.01, pitch / 100), time: this.context.currentTime
            });
        });
    }

    updateRandomSounds(now) {
        if (now < this.nextRandomTime) return;
        this.nextRandomTime = now + 3600;
        for (let i = this.randomSounds.length - 1; i >= 0; i--) {
            const sound = this.randomSounds[i];
            if (now >= sound.nextPlayTime) {
                this.playRandomSound(sound);
                sound.nextPlayTime = now + randomInterval(sound.time);
            }
            if (sound.nextPlayTime < this.nextRandomTime) this.nextRandomTime = sound.nextPlayTime;
        }
    }

    /* Rows: the per-sound mixer channel every loop slot and random command gets */

    createRow(row) {
        row.muted = row.muted || false;
        row.soloed = row.soloed || false;
        row.bus = this.context.createGain();
        row.analyser = this.context.createAnalyser();
        row.analyser.fftSize = 1024;
        row.bus.connect(row.analyser);
        if (row.kind === "loop") {
            row.fadeGain = this.context.createGain();
            row.fadeGain.gain.value = row.volumeCurrent;
            row.spatial = null;
            row.input = row.fadeGain;
        } else {
            row.input = row.bus;
        }
        this.applyMuteSolo();
    }

    // Wires a row's output to the dry bus and, unless the wave is marked drymix, the DSP send.
    routeRow(row) {
        row.analyser.disconnect();
        row.analyser.connect(this.dryBus);
        if (!row.dry) row.analyser.connect(this.dspSend);
    }

    // A panner for a positional sound: mono, then split left/right by Source's linear pan and scaled
    // by distance falloff.
    createPanner(position, soundLevel) {
        const input = this.context.createGain();
        input.channelCount = 1;
        input.channelCountMode = "explicit";
        input.channelInterpretation = "speakers";
        const left = this.context.createGain();
        const right = this.context.createGain();
        const output = this.context.createChannelMerger(2);
        input.connect(left).connect(output, 0, 0);
        input.connect(right).connect(output, 0, 1);
        const panner = { input, output, left, right };
        this.setPannerPosition(panner, position, soundLevel, true);
        return panner;
    }

    setPannerPosition(panner, position, soundLevel, immediate = false) {
        const { left, right, distance } = stereoGains(position.x, position.y);
        const gain = distanceGain(soundLevel, distance);
        const now = this.context.currentTime;
        if (immediate) {
            panner.left.gain.value = gain * left;
            panner.right.gain.value = gain * right;
        } else {
            panner.left.gain.setTargetAtTime(gain * left, now, 0.03);
            panner.right.gain.setTargetAtTime(gain * right, now, 0.03);
        }
    }

    // Ambient loops go straight to their bus (full volume in both speakers); positional ones go
    // through a panner at their position.
    updateSpatial(slot) {
        slot.fadeGain.disconnect();
        if (slot.isAmbient) {
            if (slot.spatial) { slot.spatial.output.disconnect(); slot.spatial = null; }
            slot.fadeGain.connect(slot.bus);
            return;
        }
        const position = this.positions[slot.positionIndex];
        if (!slot.spatial) {
            slot.spatial = this.createPanner(position, slot.soundLevel);
            slot.spatial.output.connect(slot.bus);
        } else {
            this.setPannerPosition(slot.spatial, position, slot.soundLevel, true);
        }
        slot.fadeGain.connect(slot.spatial.input);
    }

    // Moves a position (dragged on the radar); positional loops there follow it.
    setPosition(index, x, y) {
        this.positions[index] = { x, y };
        this.loopingSounds.forEach(slot => {
            if (!slot.isAmbient && slot.positionIndex === index && slot.spatial) this.setPannerPosition(slot.spatial, this.positions[index], slot.soundLevel);
        });
    }

    resetPositions() {
        this.defaultPositions.forEach((position, index) => this.setPosition(index, position.x, position.y));
    }

    rows() {
        return [...this.loopingSounds, ...this.randomSounds];
    }

    setMuted(row, muted) { row.muted = muted; this.applyMuteSolo(); }
    setSoloed(row, soloed) { row.soloed = soloed; this.applyMuteSolo(); }

    applyMuteSolo() {
        const rows = this.rows();
        const anySolo = rows.some(row => row.soloed);
        rows.forEach(row => {
            const audible = !row.muted && (!anySolo || row.soloed);
            row.bus.gain.setTargetAtTime(audible ? 1 : 0, this.context.currentTime, 0.02);
        });
    }

    // A random command leaving the soundscape: kept alive until its last sound finishes.
    retireRow(row) {
        row.retired = true;
        if (!row.instances) this.disposeRow(row);
    }

    disposeRow(row) {
        if (row.kind === "loop") this.stopVoice(row);
        row.bus.disconnect();
        row.analyser.disconnect();
    }

    /* Per-tick work: C_SoundscapeSystem::Update */

    update() {
        const now = this.context.currentTime;
        let removed = false;
        for (let i = this.loopingSounds.length - 1; i >= 0; i--) {
            const slot = this.loopingSounds[i];
            slot.volumeCurrent = this.loopVolumeAt(slot, now);
            if (slot.volumeTarget === 0 && slot.volumeCurrent === 0 && (!slot.fade || now >= slot.fade.end)) {
                this.disposeRow(slot);
                this.loopingSounds.splice(i, 1);
                removed = true;
            }
        }
        if (removed) { this.applyMuteSolo(); this.emit("rows"); }
        if (this.currentSoundscape) this.updateRandomSounds(now);
    }

    /* Mixing controls */

    setMasterVolume(volume) {
        this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.02);
    }

    setFadeTime(seconds) {
        this.fadeTime = seconds;
    }

    setDspEnabled(enabled) {
        this.dspEnabled = enabled;
        this.applyRoom();
    }

    // Applies the room type and dsp_volume: crossfades to a convolver holding the new room's
    // impulse (or out of the effect entirely), and muffles the dry signal for the water rooms.
    applyRoom() {
        const room = roomTypes[this.roomType] || roomTypes[0];
        const now = this.context.currentTime;
        const wanted = this.dspEnabled && !!room.decay;
        const wetLevel = wanted ? room.wet * this.dspVolume : 0;
        let active = this.reverbs[this.activeReverb];

        if (wanted && active.room !== this.roomType) {
            // Load the new room into the idle convolver (cheap while it's disconnected), then swap.
            if (!this.impulses.has(this.roomType)) this.impulses.set(this.roomType, createRoomImpulse(this.context, room));
            this.activeReverb = 1 - this.activeReverb;
            const next = this.reverbs[this.activeReverb];
            if (next.connected) this.setReverbConnected(next, false);
            next.convolver.buffer = this.impulses.get(this.roomType);
            next.room = this.roomType;
            active.wet.gain.setTargetAtTime(0, now, 0.3);
            active = next;
        }
        if (wanted) this.setReverbConnected(active, true);
        active.wet.gain.setTargetAtTime(wetLevel, now, 0.3);
        this.reverbs.forEach(reverb => { if (reverb !== active || !wanted) reverb.wet.gain.setTargetAtTime(0, now, 0.3); });

        // Once the fade is done, stop feeding whatever isn't in use, so it stops costing anything.
        clearTimeout(this.reverbReleaseTimer);
        this.reverbReleaseTimer = setTimeout(() => {
            const inUse = this.dspEnabled && !!(roomTypes[this.roomType] || roomTypes[0]).decay;
            this.reverbs.forEach((reverb, index) => {
                if (!inUse || index !== this.activeReverb) this.setReverbConnected(reverb, false);
            });
        }, 1500);

        const muffle = this.dspEnabled && room.muffle ? room.muffle : this.context.sampleRate / 2;
        this.muffle.frequency.setTargetAtTime(muffle, now, 0.3);
    }

    setReverbConnected(reverb, connected) {
        if (reverb.connected === connected) return;
        if (connected) this.dspSend.connect(reverb.convolver);
        else this.dspSend.disconnect(reverb.convolver);
        reverb.connected = connected;
    }

    roomName() {
        return (roomTypes[this.roomType] || roomTypes[0]).name;
    }
}

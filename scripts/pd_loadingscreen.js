// Paddy's Dreamland™ loading screen
//
// While the page loads, the D of the logo runs in a loop like the snake in Snake.
// Once everything has loaded, it finishes its lap, heads to the top left and draws the P.
// After the P's top bar, a second stroke starts the D, and from then on every P stroke
// and its matching D stroke start and finish together. When both letters are done,
// the loading screen fades out.
//
// The logo is built on a grid of blocks (one block = 72px in the 1080px logo file).
// All positions below are in blocks, measured to the middle of each block.

(function () {
    // ===== Settings =====
    const SPEED = 20;               // blocks per second while the snake is moving
    const SNAKE_LENGTH = 12;        // length of the loading snake, in blocks
    const TAIL_SPEED = 2;           // how much faster the leftover tail disappears once the P starts
    const HOLD_SECONDS = 0.4;       // how long the finished logo stays before the screen fades
    const STROKE_COLOR = "#ffffff";
    // ====================

    const SVG_NS = "http://www.w3.org/2000/svg";

    const loadingHolder = document.getElementById("loading-holder");
    const loadingIcon = document.getElementById("loading-icon");

    // The loop the D runs around while loading (clockwise, starting top left).
    const RING = [[5.5, 5.5], [9.5, 5.5], [9.5, 9.5], [5.5, 9.5]];

    // Final lap: leave the loop at the bottom left, go up to the top left corner, then draw the P.
    const EXIT = [[2.5, 9.5], [2.5, 5.5], [6.5, 5.5], [6.5, 7.5], [2.5, 7.5], [2.5, 9.5]];

    // The D's own stroke. It starts one block early, inside the gap, and that block is cut away
    // (see the clip below), so the D grows out of its own edge instead of from the P.
    const D_PATH = [[7.5, 5.5], [12.5, 5.5], [12.5, 9.5], [8.5, 9.5]];

    // Stroke pairs after the P's top bar, as lengths in blocks:
    // P down (2) with D top (5), P middle bar (4) with D right side (4), P stem (2) with D bottom (4).
    const P_LENGTHS = [2, 4, 2];
    const D_LENGTHS = [5, 4, 4];
    // Each pair takes as long as its average length would at normal speed.
    const PAIR_SECONDS = P_LENGTHS.map((p, i) => (p + D_LENGTHS[i]) / 2 / SPEED);
    const P_STARTS = [0, 2, 6];
    const D_STARTS = [0, 5, 9];

    // The finished logo, used when the visitor prefers reduced motion.
    const STATIC_P = [[2.5, 5.5], [6.5, 5.5], [6.5, 7.5], [2.5, 7.5], [2.5, 9.5]];
    const STATIC_D = [[8.5, 5.5], [12.5, 5.5], [12.5, 9.5], [8.5, 9.5]];

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let pageLoaded = false;
    let revealed = false;

    // ----- Track helpers -----
    // A track is a list of corners, each remembering how far along the path it is.

    function makeTrack(points) {
        let distance = 0;
        return points.map((p, i) => {
            if (i > 0) distance += Math.abs(p[0] - points[i - 1][0]) + Math.abs(p[1] - points[i - 1][1]);
            return { x: p[0], y: p[1], d: distance };
        });
    }

    function addCorner(track, p) {
        const last = track[track.length - 1];
        track.push({ x: p[0], y: p[1], d: last.d + Math.abs(p[0] - last.x) + Math.abs(p[1] - last.y) });
    }

    function pointAt(track, distance) {
        for (let i = 1; i < track.length; i++) {
            if (distance <= track[i].d) {
                const a = track[i - 1], b = track[i];
                const t = (distance - a.d) / ((b.d - a.d) || 1);
                return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
            }
        }
        const last = track[track.length - 1];
        return [last.x, last.y];
    }

    // The piece of a track between two distances, as an SVG points string (or null if empty).
    function piece(track, from, to) {
        if (to - from < 0.001) return null;
        const points = [pointAt(track, from)];
        for (const corner of track) {
            if (corner.d > from && corner.d < to) points.push([corner.x, corner.y]);
        }
        points.push(pointAt(track, to));
        return toPoints(points);
    }

    function toPoints(points) {
        return points.map(p => p[0].toFixed(3) + "," + p[1].toFixed(3)).join(" ");
    }

    // ----- Build the SVG inside #loading-icon -----

    function makeLine(parent, clipId) {
        const line = document.createElementNS(SVG_NS, "polyline");
        if (clipId) line.setAttribute("clip-path", "url(#" + clipId + ")");
        line.style.visibility = "hidden";
        parent.appendChild(line);
        return line;
    }

    function showLine(line, points) {
        if (points) {
            line.setAttribute("points", points);
            line.style.visibility = "visible";
        } else {
            line.style.visibility = "hidden";
        }
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    // 12 blocks across at 96px means exactly 8px per block, so the logo sits on whole pixels.
    svg.setAttribute("viewBox", "1.5 1.5 12 12");
    svg.setAttribute("aria-hidden", "true");

    const defs = document.createElementNS(SVG_NS, "defs");
    const clip = document.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", "loading-icon-d-clip");
    const clipRect = document.createElementNS(SVG_NS, "rect");
    clipRect.setAttribute("x", "8");
    clipRect.setAttribute("y", "0");
    clipRect.setAttribute("width", "8");
    clipRect.setAttribute("height", "16");
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    svg.appendChild(defs);

    const strokes = document.createElementNS(SVG_NS, "g");
    strokes.setAttribute("fill", "none");
    strokes.setAttribute("stroke", STROKE_COLOR);
    strokes.setAttribute("stroke-width", "1");
    strokes.setAttribute("stroke-linecap", "square");
    strokes.setAttribute("stroke-linejoin", "miter");
    svg.appendChild(strokes);

    const bodyLine = makeLine(strokes);                          // the loading snake and its leftover tail
    const pLine = makeLine(strokes);                             // the P being drawn
    const dLine = makeLine(strokes, "loading-icon-d-clip");      // the D being drawn

    if (loadingIcon) loadingIcon.appendChild(svg);

    // ----- Animation state -----

    let track, nextRingCorner, head, tail, pStart, branchStart, pair, pairProgress, holdTime, mode, dHead;

    function reset() {
        // The snake starts already formed on the loop, its head at the bottom left corner.
        track = makeTrack([[5.5, 9.5], [5.5, 5.5], [9.5, 5.5], [9.5, 9.5], [5.5, 9.5]]);
        nextRingCorner = 0;
        head = 16;
        tail = head - SNAKE_LENGTH;
        pStart = null;       // where on the track the P begins (set once the final lap is planned)
        branchStart = null;  // where the P's top bar ends and the D branch begins
        pair = 0;
        pairProgress = 0;
        holdTime = 0;
        mode = "run";        // run → branch → hold → done
        dHead = 0;
    }

    // Adds corners ahead of the head. Once the page has loaded and the head reaches the
    // bottom left corner, the final lap is added instead of another loop.
    function extendTrack() {
        while (pStart === null && head >= track[track.length - 1].d) {
            const last = track[track.length - 1];
            if (pageLoaded && last.x === 5.5 && last.y === 9.5) {
                EXIT.forEach(p => addCorner(track, p));
                pStart = track[track.length - 5].d;
                branchStart = track[track.length - 4].d;
            } else {
                addCorner(track, RING[nextRingCorner]);
                nextRingCorner = (nextRingCorner + 1) % RING.length;
            }
        }
    }

    function update(dt) {
        if (mode === "run") {
            head += SPEED * dt;
            extendTrack();
            if (branchStart !== null && head >= branchStart) {
                head = branchStart;
                mode = "branch";
            }
        } else if (mode === "branch") {
            pairProgress += dt / PAIR_SECONDS[pair];
            while (pairProgress >= 1 && pair < P_LENGTHS.length - 1) {
                pairProgress -= 1;
                pair++;
            }
            if (pairProgress >= 1) {
                pairProgress = 1;
                mode = "hold";
            }
            head = branchStart + P_STARTS[pair] + P_LENGTHS[pair] * pairProgress;
            dHead = D_STARTS[pair] + D_LENGTHS[pair] * pairProgress;
        } else if (mode === "hold") {
            holdTime += dt;
            if (holdTime >= HOLD_SECONDS) {
                mode = "done";
                reveal();
            }
        }

        // The tail follows at snake length while looping, then catches up to the P's start.
        if (pStart === null || head <= pStart) tail = head - SNAKE_LENGTH;
        else tail = Math.min(pStart, tail + SPEED * TAIL_SPEED * dt);

        // Forget corners the tail has already passed so the track doesn't grow forever.
        while (pStart === null && track.length > 2 && track[1].d < tail - 1) track.shift();
    }

    function render() {
        const bodyEnd = pStart === null ? head : Math.min(head, pStart);
        const tailGone = pStart !== null && tail >= pStart - 0.0001;
        showLine(bodyLine, tailGone ? null : piece(track, tail, bodyEnd));
        showLine(pLine, pStart !== null && head > pStart ? piece(track, pStart, head) : null);
        showLine(dLine, mode === "run" ? null : piece(dTrack, 0, dHead));
    }

    const dTrack = makeTrack(D_PATH);

    // ----- Fade out the loading screen -----

    function reveal() {
        if (revealed || !loadingHolder) return;
        revealed = true;
        loadingHolder.classList = "loading-holder-fade";
        loadingHolder.addEventListener("animationend", () => {
            loadingHolder.remove();
        });
    }

    // ----- Main loop -----

    let lastTime = null;

    function frame(time) {
        if (lastTime === null) lastTime = time;
        const dt = Math.min(0.05, (time - lastTime) / 1000);   // cap the step so a hiccup can't skip strokes
        lastTime = time;
        update(dt);
        render();
        if (mode !== "done") requestAnimationFrame(frame);
    }

    function onPageLoaded() {
        pageLoaded = true;

        // Iframes with a data-src (like the Twitch player) only start now: the load event waits for
        // everything inside an iframe too, which would keep the loading screen up for that long.
        document.querySelectorAll("iframe[data-src]").forEach(iframe => {
            iframe.src = iframe.dataset.src;
        });

        if (reducedMotion) reveal();
    }

    if (reducedMotion) {
        // No movement: show the finished logo and fade out as soon as the page has loaded.
        showLine(pLine, toPoints(STATIC_P));
        showLine(dLine, toPoints(STATIC_D));
    } else {
        reset();
        render();
        requestAnimationFrame(frame);
    }

    if (document.readyState === "complete") onPageLoaded();
    else window.addEventListener("load", onPageLoaded);
})();
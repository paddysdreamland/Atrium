import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
    createRouteMarkerMaterial, createMapMaterial, createSurroundingsMaterial, createWaterMaterial,
    updateScreenUniforms, setCityFrame, setCityWaypoint
} from "./glassguessr_shaders.js";

export const MAP_MODEL = "models/glass.glb";

/* The guess and answer markers each have their own image. Both are tinted by
   GUESS_COLOR / ANSWER_COLOR below, so white artwork takes the colour cleanly.
   The answer's falls back to the guess image if it fails to load. */
export const POINTER_TEXTURE = "ui/texturemappings/map_pointer.png";
export const ANSWER_POINTER_TEXTURE = "ui/texturemappings/goal_pointer.png";

/* The route chevron from Catalyst's map (runvismapmesh): a small tetrahedron,
   apex up, whose triangular base points along +X. It has a fixed size in the
   world, CHEVRON_METRES wide, so it scales with perspective like the city
   around it; CHEVRON_SPACING is the gap between chevron centres in chevron
   widths, about what the game's map routes use. */
export const CHEVRON_MODEL = "models/runvismapmesh.glb";
const CHEVRON_COLOR = 0xff2020;
const CHEVRON_METRES = 2.5;
const CHEVRON_SPACING = 1;

/* The model is normalised so its longest dimension is 1 unit, which makes
   every distance below a fraction of the city rather than a raw model unit.
   Opening on the whole city gives the answer away, so the camera starts close
   in on the model's own pivot instead. */
const START_DISTANCE = 0.055;
const START_PITCH_DEG = 45;

/* The menu backdrop: a slow, locked orbit around the same pivot, pulled back
   far enough to read as the city but kept inside the fog, which swallows
   everything past roughly a quarter of the model. ORBIT_SPEED is in
   OrbitControls' autoRotateSpeed units, where 2 is one lap every 30 s. */
const ORBIT_DISTANCE = 0.14;
const ORBIT_PITCH_DEG = 28;
const ORBIT_SPEED = 0.6;

/* The result view: steep enough that the line between the two markers reads
   as a distance on the map, and far enough back to fit both with margin.
   RESULT_FIT is camera distance per unit of marker spread - at the 50 degree
   field of view one unit of distance shows about 0.93 units of height. */
const RESULT_PITCH_DEG = 55;
const RESULT_FIT = 1.5;

/* While the reveal line draws, the camera chases its ideal framing rather
   than sitting rigidly on it: each frame it closes the gap with this time
   constant, in seconds, so it eases into motion and drifts the last of the
   way into place after the line lands. */
const CAMERA_LAG = 0.22;

/* Pointer height in CSS pixels, held constant at every zoom. The source image
   is 32x32 and tapers to a 2px tip at both ends, so POINTER_ASPECT is 1.

   Anchoring follows three.js's Sprite.center convention, where y = 0 is the
   BOTTOM edge of the image - the opposite of the CSS/Unity convention where
   (0.5, 1) means bottom-centre. (0.5, 0) is the equivalent here: the sprite
   stands above its position with the lower tip on the guessed point. Flip to
   1 to hang it below instead. */
const POINTER_SIZE_PX = 64;
const POINTER_ASPECT = 1;
const POINTER_ANCHOR = [0.5, 0.25];

const GUESS_COLOR = 0xffffff; // 0xff2020
const ANSWER_COLOR = 0xffffff;
const DEBUG_COLOR = 0x39ff6a;

/* Size of the pannable area as a multiple of the model's bounding box. That
   box is dominated by the distant vista backdrop rather than by Glass itself,
   so 1 is far looser than it sounds, and values below it are what actually
   confine panning to the playable city. */
const PAN_BOUNDS_SCALE = 0.5;

/* The city floats in the pale haze of the game's map screen, used as both the
   background and the fog colour: the map shaders fade the far city towards
   white and the sea out to nothing, which only reads against a matching
   backdrop. Fog density is in normalised city widths - the whole model spans
   1 unit. */
const HAZE_COLOR = 0xd3dbe2;
const FOG_DENSITY = 4;

/* glass.glb is authored Z-up and is not centred on its origin. The root group
   carries the -90deg X rotation so three.js sees Y-up, and the model object
   carries the recentering offset. Every coordinate this module hands out or
   takes in is in ORIGINAL model space (Z-up, uncentred) so that location data
   measured in Blender drops straight in without conversion. */
const MODEL_IS_Z_UP = true;

/* Frostbite is Y-up and works in metres; this export is Z-up and was scaled to
   1/100 on the way out, so one model unit is 100 m. The axis change is a +90
   degree rotation about X, (x, y, z) -> (x, -z, y). Checked against the five
   measured round locations by raycasting the model: each lands 1.2-2.9 m
   (eye height) above a rooftop with open sky overhead, while every mirrored
   variant leaves most of them floating ~48 m up. That confirms the mapping,
   not which screenshot a position belongs to. */
export const METRES_PER_UNIT = 100;

export function fromFrostbite(x, y, z) {
    const p = (x && typeof x === "object") ? x : { x: x, y: y, z: z };
    return {
        x: p.x / METRES_PER_UNIT,
        y: -p.z / METRES_PER_UNIT,
        z: p.y / METRES_PER_UNIT
    };
}

export function toFrostbite(x, y, z) {
    const p = (x && typeof x === "object") ? x : { x: x, y: y, z: z };
    return {
        x: p.x * METRES_PER_UNIT,
        y: p.z * METRES_PER_UNIT,
        z: -p.y * METRES_PER_UNIT
    };
}

/* Ground distance in METRES between two model-space points. Height is ignored
   deliberately: Glass is vertical enough that counting it would punish a
   correct guess made on the wrong rooftop. This is the default rule. */
export function horizontalDistance(a, b) {
    const dx = a.x - b.x;
    const dy = MODEL_IS_Z_UP ? a.y - b.y : a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy) * METRES_PER_UNIT;
}

/* Straight-line distance in METRES between two model-space points, height
   included - for the Count height modifier. */
export function spatialDistance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * METRES_PER_UNIT;
}

function makePointer(texture, color) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        color: color,
        transparent: true,
        depthTest: false,
        /* Off, so the sprite does not shrink with distance - see
           pointerScale() for how that turns into an exact pixel height. */
        sizeAttenuation: false
    }));

    sprite.center.set(POINTER_ANCHOR[0], POINTER_ANCHOR[1]);
    sprite.renderOrder = 999;
    sprite.visible = false;
    return sprite;
}

export function createMap(mount) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    /* No lights: every surface uses a port of the game's own map shaders
       (glassguessr_shaders.js), which do their own shading. */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(HAZE_COLOR);
    scene.fog = new THREE.FogExp2(HAZE_COLOR, FOG_DENSITY);

    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.0002, 50);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
    controls.minDistance = 0.002;
    controls.maxDistance = 2.5;

    /* Map conventions rather than model-viewer conventions: left drag slides
       the city, right drag orbits. screenSpacePanning is left off so panning
       tracks the ground plane instead of the camera plane - drag a rooftop and
       it stays under the cursor rather than sliding upward as you tilt. */
    controls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE
    };
    controls.listenToKeyEvents(window);

    /* Two orbit schemes, switched with setOrbitWithModifier:
         default   left drag pans, right drag orbits
         modifier  left drag pans, shift/ctrl + left drag orbits, and the right
                   button never reaches the map - an accessibility setting for
                   browsers that keep the right button for mouse gestures
       OrbitControls itself swaps pan and rotate while ctrl, meta or shift is
       held. The modifier scheme is exactly that swap; the default scheme hides
       the modifiers from it, so they stay free for anything else. Its
       mouse-down handler reads only the button, the modifiers and the cursor
       position. */
    let orbitWithModifier = false;

    function applyOrbitScheme() {
        controls.mouseButtons = {
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: orbitWithModifier ? null : THREE.MOUSE.ROTATE
        };
    }
    applyOrbitScheme();

    const handleMouseDown = controls._onMouseDown;
    controls._onMouseDown = (e) => handleMouseDown({
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        ctrlKey: orbitWithModifier && e.ctrlKey,
        metaKey: orbitWithModifier && e.metaKey,
        shiftKey: orbitWithModifier && e.shiftKey
    });

    /* Browsers with mouse gestures on - Vivaldi's rocker gestures, Opera's
       mouse gestures, both on by default - can swallow a right-button release.
       OrbitControls then believes the button is still held and ignores every
       press after it, which locks the camera until enough clicks balance the
       books. So presses are tracked here, in the capture phase on the
       container (an ancestor of the canvas, so ahead of OrbitControls): a new
       press while one is still outstanding means its release was lost, and the
       missing pointerup is delivered first. In the modifier scheme the right
       button is stopped here before it reaches the map at all. */
    const outstanding = new Set();
    const onPressCapture = (e) => {
        if (e.pointerType !== "mouse") return;
        if (orbitWithModifier && e.button === 2) {
            e.stopPropagation();
            return;
        }
        for (const pointerId of outstanding) {
            renderer.domElement.ownerDocument.dispatchEvent(new PointerEvent("pointerup", { pointerId, pointerType: "mouse" }));
        }
        outstanding.clear();
        outstanding.add(e.pointerId);
    };
    const onReleaseCapture = (e) => { outstanding.delete(e.pointerId); };
    mount.addEventListener("pointerdown", onPressCapture, true);
    window.addEventListener("pointerup", onReleaseCapture, true);
    window.addEventListener("pointercancel", onReleaseCapture, true);

    /* OrbitControls suppresses the context menu on the canvas but not on the
       container around it. */
    const onContextMenu = (e) => e.preventDefault();
    mount.addEventListener("contextmenu", onContextMenu);

    const root = new THREE.Group();
    if (MODEL_IS_Z_UP) root.rotation.x = -Math.PI / 2;
    scene.add(root);

    /* Markers are drawn at a fixed pixel size, so mip levels would only ever
       blur them. The images are white, which lets colour do the tinting. */
    function loadPointerTexture(url, onError) {
        const texture = new THREE.TextureLoader().load(url, undefined, undefined, onError);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        return texture;
    }

    const pointerTexture = loadPointerTexture(POINTER_TEXTURE);
    const answerTexture = ANSWER_POINTER_TEXTURE === POINTER_TEXTURE
        ? pointerTexture
        : loadPointerTexture(ANSWER_POINTER_TEXTURE, () => {
            console.warn("answer marker image failed to load, using the guess marker's:", ANSWER_POINTER_TEXTURE);
            answerMarker.material.map = pointerTexture;
            answerMarker.material.needsUpdate = true;
        });

    const guessMarker = makePointer(pointerTexture, GUESS_COLOR);
    const answerMarker = makePointer(answerTexture, ANSWER_COLOR);
    scene.add(guessMarker, answerMarker);

    /* The guess-to-answer line is a row of the game's own route chevrons,
       drawn in a scene of their own after the city with the depth buffer
       cleared - so a straight line between rooftops never vanishes into the
       buildings it crosses, while each chevron still hides its own back
       faces. They use a port of the game's SS_RunVisMapMarker shader rather
       than scene lighting; see glassguessr_shaders.js. */
    const overlayScene = new THREE.Scene();
    const chevronMaterial = createRouteMarkerMaterial(CHEVRON_COLOR);
    const chevronGroup = new THREE.Group();
    overlayScene.add(chevronGroup);
    let chevronGeometry = null;

    let model = null;
    let pivot = null;
    let modelScale = 1;
    let flight = null;  // camera move in progress, see flyTo
    let line = null;    // guess-to-answer line in progress or drawn, see drawLine
    let panBounds = null;
    const debugMarkers = [];
    let pickCallback = null;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = null;

    /* OrbitControls drags and guess clicks share the left button, so only treat
       a release as a guess if the pointer barely moved since it went down. */
    renderer.domElement.addEventListener("pointerdown", (e) => {
        if (!controls.enabled) return;
        downAt = { x: e.clientX, y: e.clientY, button: e.button };
        renderer.domElement.style.cursor = "grabbing";
    });

    /* On window rather than the canvas, so releasing the button off-canvas
       still restores the cursor. The pick handler below bails out early in
       several cases, so it cannot own this. */
    const restCursor = () => controls.enabled ? "crosshair" : "default";
    const onPointerUp = () => { renderer.domElement.style.cursor = restCursor(); };
    window.addEventListener("pointerup", onPointerUp);

    renderer.domElement.addEventListener("pointerup", (e) => {
        if (!downAt || !model || !pickCallback) return;
        const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
        const button = downAt.button;
        downAt = null;
        /* Only the left button places a guess, so a right-click that barely
           moves - a short orbit - never does. */
        if (button !== 0 || moved > 5) return;

        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(model, true)[0];
        if (!hit) return;

        guessMarker.position.copy(hit.point);
        guessMarker.visible = true;
        pickCallback(model.worldToLocal(hit.point.clone()));
    });

    function onResize() {
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);

    let running = true;
    /* Panning is unbounded by default, and on a city this large it is very
       easy to slide off into empty space with nothing on screen to navigate
       back by. Shifting the camera by the same amount as the clamped target
       keeps the view angle untouched while the pan simply stops. */
    function clampPan() {
        if (!panBounds) return;
        const t = controls.target;
        const x = THREE.MathUtils.clamp(t.x, panBounds.min.x, panBounds.max.x);
        const z = THREE.MathUtils.clamp(t.z, panBounds.min.z, panBounds.max.z);
        if (x === t.x && z === t.z) return;

        camera.position.x += x - t.x;
        camera.position.z += z - t.z;
        t.x = x;
        t.z = z;
    }

    /* With sizeAttenuation off, the sprite shader multiplies scale by the view
       depth, so the perspective divide cancels and scale lands directly in NDC
       as scale * (1 / tan(fov/2)). NDC height 2 spans the viewport, which
       inverts to the pixel height wanted here. Recomputed per frame so resizes
       need no extra bookkeeping. */
    function pointerScale() {
        const h = mount.clientHeight || 1;
        return 2 * POINTER_SIZE_PX * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / h;
    }

    function scaleMarker(marker) {
        if (!marker.visible) return;
        const s = pointerScale();
        marker.scale.set(s * POINTER_ASPECT, s, 1);
    }

    /* Passed to controls.update so the menu orbit turns at the same rate on a
       144 Hz screen as on a 60 Hz one - without it OrbitControls assumes 60. */
    let lastFrame = performance.now();

    const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /* A camera view as orbit coordinates around a target, so a move between
       two views can sweep heading, pitch and distance rather than cutting
       through the city in a straight line. */
    function currentView() {
        const offset = camera.position.clone().sub(controls.target);
        const distance = offset.length() || 1e-6;
        return {
            target: controls.target.clone(),
            azimuth: Math.atan2(offset.x, offset.z),
            pitch: Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1)),
            distance
        };
    }

    function applyView(v) {
        controls.target.copy(v.target);
        camera.position.copy(v.target).add(new THREE.Vector3(
            Math.sin(v.azimuth) * Math.cos(v.pitch),
            Math.sin(v.pitch),
            Math.cos(v.azimuth) * Math.cos(v.pitch)
        ).multiplyScalar(v.distance));
    }

    function stepFlight(now) {
        const t = Math.min((now - flight.start) / flight.duration, 1);
        const k = easeInOut(t);
        const a = flight.from, b = flight.to;
        /* Shortest way round for the heading; distance eases in log space so
           pulling far back does not rush at the end. */
        let turn = b.azimuth - a.azimuth;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        applyView({
            target: a.target.clone().lerp(b.target, k),
            azimuth: a.azimuth + turn * k,
            pitch: a.pitch + (b.pitch - a.pitch) * k,
            distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * k)
        });
        if (t < 1) return;
        const done = flight;
        flight = null;
        if (!done.stayLocked) controls.enabled = done.wasEnabled;
        renderer.domElement.style.cursor = restCursor();
        done.resolve();
    }

    /* The result framing for two points: centred between them, at the result
       pitch, pulled back to fit both - with a floor, so a near-perfect guess
       (or the line's first frame, when both are the same point) does not slam
       the camera into the rooftops. */
    function resultView(a, b, azimuth) {
        return {
            target: a.clone().add(b).multiplyScalar(0.5),
            azimuth,
            pitch: THREE.MathUtils.degToRad(RESULT_PITCH_DEG),
            distance: Math.max(a.distanceTo(b) * RESULT_FIT, START_DISTANCE * 0.6)
        };
    }

    /* Settles any leftover drag momentum at once, or damping would keep
       nudging the camera through a scripted move. */
    function flushDamping() {
        const damping = controls.enableDamping;
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = damping;
    }

    /* Ends a move where it is; whoever cancels it sets the camera next. */
    function cancelFlight() {
        if (!flight) return;
        const done = flight;
        flight = null;
        done.resolve();
    }

    const lineProgress = (now) => Math.min((now - line.start) / line.duration, 1);
    /* Eased, so the line gathers speed out of the guess and settles into the
       answer, still landing exactly as its sound ends. */
    const lineTip = (t) => line.from.clone().lerp(line.to, easeInOut(t));

    /* The camera aims to keep the guess and the line's tip in frame - pulling
       back as the line reaches out - while turning until the finished line
       lies horizontal across the screen. It closes in on that aim with a lag
       (CAMERA_LAG) instead of locking to it, which smooths the motion; once
       the line has landed and the camera has caught up, input unlocks. */
    function followLine(now, dt) {
        const t = lineProgress(now);
        const aim = resultView(line.from, lineTip(t), line.azimuth + line.turn * easeInOut(t));
        const v = line.view;
        const k = 1 - Math.exp(-dt / CAMERA_LAG);

        v.target.lerp(aim.target, k);
        v.azimuth += Math.atan2(Math.sin(aim.azimuth - v.azimuth), Math.cos(aim.azimuth - v.azimuth)) * k;
        v.pitch += (aim.pitch - v.pitch) * k;
        v.distance = Math.exp(Math.log(v.distance) + (Math.log(aim.distance) - Math.log(v.distance)) * k);
        applyView(v);

        const settled = Math.abs(v.distance / aim.distance - 1) < 0.002
            && v.target.distanceTo(aim.target) < aim.distance * 0.002
            && Math.abs(Math.atan2(Math.sin(aim.azimuth - v.azimuth), Math.cos(aim.azimuth - v.azimuth))) < 0.002
            && Math.abs(aim.pitch - v.pitch) < 0.002;
        if (t >= 1 && settled) {
            line.follow = false;
            controls.enabled = true;
            renderer.domElement.style.cursor = restCursor();
        }
    }

    /* Each chevron pops in once the line's eased progress passes it, growing
       over CHEVRON_POP of the line's length with a slight overshoot. */
    const CHEVRON_POP = 0.08;
    const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

    function stepLine(now) {
        const t = lineProgress(now);
        const p = easeInOut(t);
        for (const c of line.chevrons) {
            const grow = THREE.MathUtils.clamp((p - c.at) / CHEVRON_POP, 0, 1);
            c.mesh.visible = grow > 0;
            c.mesh.scale.setScalar(line.size * (t >= 1 ? 1 : easeOutBack(grow)));
        }
        if (t >= 1 && line.resolve) {
            const resolve = line.resolve;
            line.resolve = null;
            answerMarker.visible = true;
            if (line.zoneMetres > 0) setCityWaypoint(answerMarker.position, line.zoneMetres, line.zoneSphere);
            resolve();
        }
    }

    function tick() {
        if (!running) return;
        const now = performance.now();
        const dt = Math.min((now - lastFrame) / 1000, 0.1);
        lastFrame = now;
        if (flight) stepFlight(now);
        if (line && line.follow) followLine(now, dt);
        controls.update(dt);
        if (line) stepLine(now);
        clampPan();
        scaleMarker(guessMarker);
        scaleMarker(answerMarker);
        for (const marker of debugMarkers) scaleMarker(marker);
        updateScreenUniforms(renderer, now / 1000);
        renderer.render(scene, camera);
        if (chevronGroup.children.length) {
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(overlayScene, camera);
            renderer.autoClear = true;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    /* The city is drawn with ports of the game's map shaders (see
       glassguessr_shaders.js) in place of the export's materials:
         water_mat   SS_Map_Water
         map_mat     SS_MapSurroundings - the untextured city outside the
                     playable map
         the rest    SS_Map, with the export's baked diffuse as its colour
                     input and the *_glass_mat meshes on its glass branch
       Each shader material is built once per original material. */
    const cityMaterials = new Map();
    const WHITE = new THREE.Color(1, 1, 1);

    function cityMaterialFor(mesh, original) {
        const kind = /water/i.test(mesh.name) ? "water"
            : /map_mat/i.test(mesh.name) ? "surroundings"
            : /glass/i.test(mesh.name) || original.name === "glass" ? "glass"
            : "map";
        const key = kind + ":" + original.uuid;
        if (!cityMaterials.has(key)) {
            cityMaterials.set(key,
                kind === "water" ? createWaterMaterial()
                : kind === "surroundings" ? createSurroundingsMaterial()
                : createMapMaterial({ map: original.map || null, color: original.color || WHITE, glass: kind === "glass" }));
        }
        return cityMaterials.get(key);
    }

    function applyCityShaders() {
        model.traverse((o) => {
            if (!o.isMesh) return;
            const swap = (m) => cityMaterialFor(o, m);
            o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
        });
    }

    /* The export keeps Frostbite's parent node (a 90 degree turn and a 1/100
       scale), so that is baked into the geometry, which is then centred and
       scaled to one unit wide - the reveal sizes chevrons in screen pixels,
       so the model's own units do not matter. A failure only costs the line. */
    function loadChevron() {
        new GLTFLoader().load(CHEVRON_MODEL, (gltf) => {
            gltf.scene.updateMatrixWorld(true);
            let geometry = null;
            gltf.scene.traverse((o) => {
                if (o.isMesh && !geometry) geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
            });
            if (!geometry) return;

            geometry.computeBoundingBox();
            const box = geometry.boundingBox;
            const centre = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            geometry.translate(-centre.x, -centre.y, -centre.z);
            geometry.scale(...Array(3).fill(1 / (Math.max(size.x, size.z) || 1)));
            chevronGeometry = geometry;
        }, undefined, (err) => console.warn("chevron model failed to load:", err));
    }

    /* Places the camera pitchDeg above the horizontal, looking down at target
       from the given distance. */
    function frameOn(target, distance, pitchDeg = START_PITCH_DEG) {
        const pitch = THREE.MathUtils.degToRad(pitchDeg);
        controls.target.copy(target);
        camera.position.copy(target).add(
            new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch)).multiplyScalar(distance)
        );
        controls.update();
    }

    function toWorld(modelPos) {
        return model.localToWorld(new THREE.Vector3(modelPos.x, modelPos.y, modelPos.z));
    }

    return {
        /* Resolves once the city is on screen. onProgress gets 0..1, or null
           while the server is not reporting a content length. */
        load(onProgress) {
            loadChevron();
            return new Promise((resolve, reject) => {
                new GLTFLoader().load(
                    MAP_MODEL,
                    (gltf) => {
                        model = gltf.scene;

                        const box = new THREE.Box3().setFromObject(model);
                        const size = box.getSize(new THREE.Vector3());
                        const center = box.getCenter(new THREE.Vector3());

                        /* Normalise to roughly unit scale so the camera clip
                           planes and marker sizes above stay meaningful
                           regardless of what units the export used. */
                        modelScale = 1 / Math.max(size.x, size.y, size.z);
                        model.position.copy(center).multiplyScalar(-1);
                        root.scale.setScalar(modelScale);

                        root.add(model);

                        /* Model-local (0,0,0) is the export's own pivot. The
                           recentering offset lives on the model object, so
                           localToWorld resolves it through both that and the
                           root's Z-up rotation. */
                        root.updateMatrixWorld(true);
                        panBounds = new THREE.Box3().setFromObject(root);
                        panBounds.expandByVector(
                            panBounds.getSize(new THREE.Vector3())
                                .multiplyScalar((PAN_BOUNDS_SCALE - 1) / 2)
                        );
                        pivot = model.localToWorld(new THREE.Vector3(0, 0, 0));

                        /* Metres per world unit and ground height, for the
                           map shaders' distance and height terms. */
                        setCityFrame(METRES_PER_UNIT / modelScale, pivot.y);
                        applyCityShaders();
                        frameOn(pivot, START_DISTANCE);
                        resolve({
                            size: size,
                            center: center,
                            pivot: pivot,
                            scale: modelScale,
                            panBounds: panBounds
                        });
                    },
                    (e) => {
                        if (onProgress) onProgress(e.lengthComputable ? e.loaded / e.total : null);
                    },
                    reject
                );
            });
        },

        onPick(cb) { pickCallback = cb; },

        /* true: orbit with shift/ctrl + left drag and leave the right button
           alone; false (default): orbit with right drag. */
        setOrbitWithModifier(on) {
            orbitWithModifier = !!on;
            applyOrbitScheme();
        },

        /* Menu backdrop: every input is locked out and the camera drifts
           round the city on its own. OrbitControls keeps auto-rotating
           through update() while disabled, which is exactly the split wanted. */
        orbit() {
            if (!pivot) return;
            cancelFlight();
            controls.enabled = false;
            controls.autoRotate = true;
            controls.autoRotateSpeed = ORBIT_SPEED;
            renderer.domElement.style.cursor = restCursor();
            frameOn(pivot, ORBIT_DISTANCE, ORBIT_PITCH_DEG);
        },

        /* Hands the camera to the player, back on the close opening shot so
           the round does not start on an overview that gives it away. */
        release() {
            if (!pivot) return;
            cancelFlight();
            controls.autoRotate = false;
            controls.enabled = true;
            renderer.domElement.style.cursor = restCursor();
            frameOn(pivot, START_DISTANCE);
        },

        /* Debug aid: drops a pointer at a position in MODEL space - the same
           coordinates onPick reports and that location data is stored in - so a
           known landmark can be checked against where it actually lands.
           Accepts (x, y, z, color) or (vector, color). Returns a handle for
           removeMarker, or null if the city has not finished loading. */
        addMarker(x, y, z, color) {
            if (!model) return null;

            let point;
            let tint;
            if (x && typeof x === "object") {
                point = x;
                tint = y;
            } else {
                point = { x: x, y: y, z: z };
                tint = color;
            }

            const marker = makePointer(pointerTexture, tint === undefined ? DEBUG_COLOR : tint);
            marker.position.copy(toWorld(point));
            marker.visible = true;
            scene.add(marker);
            debugMarkers.push(marker);
            return marker;
        },

        /* Same as addMarker but taking raw Frostbite coordinates, so a position
           read out of the game can be dropped in without converting by hand. */
        addFrostbiteMarker(x, y, z, color) {
            const isVector = x && typeof x === "object";
            return this.addMarker(
                fromFrostbite(isVector ? x : { x: x, y: y, z: z }),
                isVector ? y : color
            );
        },

        removeMarker(marker) {
            const i = debugMarkers.indexOf(marker);
            if (i === -1) return false;

            debugMarkers.splice(i, 1);
            scene.remove(marker);
            /* Each marker owns its material because of the tint, but they all
               share one texture - which belongs to the map, not to them. */
            marker.material.dispose();
            return true;
        },

        clearDebugMarkers() {
            while (debugMarkers.length) this.removeMarker(debugMarkers[0]);
        },


        setGuess(modelPos) {
            guessMarker.position.copy(toWorld(modelPos));
            guessMarker.visible = true;
        },

        showAnswer(modelPos) {
            answerMarker.position.copy(toWorld(modelPos));
            answerMarker.visible = true;
        },

        clearMarkers() {
            guessMarker.visible = false;
            answerMarker.visible = false;
            line = null;
            chevronGroup.clear();
            setCityWaypoint(null);
        },

        /* First half of the reveal: eases the camera in on the guess marker,
           keeping its heading so it does not swing round the city. Input
           locks here and stays locked until revealAnswer finishes. */
        focusGuess(seconds = 1.2) {
            if (!guessMarker.visible) return Promise.resolve();
            flushDamping();
            cancelFlight();
            const from = currentView();
            const to = resultView(guessMarker.position, guessMarker.position, from.azimuth);
            return new Promise((resolve) => {
                flight = { from, to, start: performance.now(), duration: seconds * 1000, wasEnabled: controls.enabled, stayLocked: true, resolve };
                controls.enabled = false;
                renderer.domElement.style.cursor = restCursor();
            });
        },

        /* Second half: draws the line from the guess to the still-hidden
           answer over the given time, the camera following it and turning so
           it ends horizontal on screen. Of the two headings that do that, the
           nearer one is used, so the turn is never more than 90 degrees. The
           answer marker appears as the line reaches it, along with the red
           waypoint region of zoneMetres around it - a cylinder, or a sphere
           when zoneSphere is set - then input unlocks. The line and region
           stay until clearMarkers. */
        revealAnswer(modelPos, seconds, zoneMetres, zoneSphere = false) {
            if (!guessMarker.visible) return Promise.resolve();
            cancelFlight();
            flushDamping();
            answerMarker.position.copy(toWorld(modelPos));
            answerMarker.visible = false;

            const from = guessMarker.position.clone();
            const to = answerMarker.position.clone();
            const azimuth = currentView().azimuth;
            /* The heading that puts both ends of the line at the same height
               on screen. With the camera at heading az and pitch p, a world
               offset d moves up the screen by cos(p) dy - sin(p) (sin(az) dx +
               cos(az) dz), and the bracket is L cos(az - b) with b the line's
               ground bearing. Level means cos(az - b) = dy / (L tan p): just
               perpendicular to the line when both ends are at one height,
               turned a little further when a rooftop guess sits above or below
               the answer. Two headings solve it; the nearer one is used. */
            const d = to.clone().sub(from);
            const ground = Math.hypot(d.x, d.z) || 1e-6;
            const bearing = Math.atan2(d.x, d.z);
            const pitch = THREE.MathUtils.degToRad(RESULT_PITCH_DEG);
            const swing = Math.acos(THREE.MathUtils.clamp(d.y / (ground * Math.tan(pitch)), -1, 1));
            const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
            const turnA = wrap(bearing + swing - azimuth);
            const turnB = wrap(bearing - swing - azimuth);

            /* Chevrons evenly along the straight line, pointing at the answer,
               CHEVRON_METRES wide in the world. The scene is the model scaled
               down to unit size, so metres go through model units first. */
            chevronGroup.clear();
            const size = CHEVRON_METRES / METRES_PER_UNIT * modelScale;
            const count = Math.max(1, Math.floor(from.distanceTo(to) / (size * CHEVRON_SPACING)));
            const heading = Math.atan2(-d.z, d.x);
            const chevrons = [];
            if (chevronGeometry) {
                for (let i = 0; i < count; i++) {
                    const at = (i + 0.5) / count;
                    const mesh = new THREE.Mesh(chevronGeometry, chevronMaterial);
                    mesh.position.copy(from).lerp(to, at);
                    mesh.rotation.y = heading;
                    mesh.visible = false;
                    chevronGroup.add(mesh);
                    chevrons.push({ mesh, at });
                }
            }

            controls.enabled = false;
            if (line && line.resolve) line.resolve();
            return new Promise((resolve) => {
                line = {
                    from,
                    to,
                    start: performance.now(),
                    duration: Math.max(seconds, 0.01) * 1000,
                    follow: true,
                    view: currentView(),
                    azimuth,
                    turn: Math.abs(turnA) <= Math.abs(turnB) ? turnA : turnB,
                    chevrons,
                    size,
                    zoneMetres,
                    zoneSphere,
                    resolve
                };
            });
        },

        dispose() {
            running = false;
            resizeObserver.disconnect();
            window.removeEventListener("pointerup", onPointerUp);
            mount.removeEventListener("contextmenu", onContextMenu);
            mount.removeEventListener("pointerdown", onPressCapture, true);
            window.removeEventListener("pointerup", onReleaseCapture, true);
            window.removeEventListener("pointercancel", onReleaseCapture, true);
            controls.dispose();
            while (debugMarkers.length) {
                const marker = debugMarkers.pop();
                scene.remove(marker);
                marker.material.dispose();
            }
            pointerTexture.dispose();
            if (answerTexture !== pointerTexture) answerTexture.dispose();
            renderer.dispose();
            renderer.domElement.remove();
            chevronGroup.clear();
            chevronMaterial.dispose();
            if (chevronGeometry) chevronGeometry.dispose();
            for (const material of cityMaterials.values()) material.dispose();
        }
    };
}

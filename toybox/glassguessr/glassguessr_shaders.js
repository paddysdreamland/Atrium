import * as THREE from "three";

/* Ports of Mirror's Edge Catalyst shaders, from 3Dmigoto decompilations of
   the game's Dx11 pixel shaders (ShaderSalad/_decompiled). Only the pixel
   shaders were dumped; their inputs - world position, world normal, UVs,
   screen position - are standard, so three.js supplies the vertex side.

   Textures, exported from Frosty into textures/. All are data rather than
   colour, so they stay out of sRGB decoding:
     T_Gradient_01      a soft white band across the middle
     T_Pattern_04_RGBM  R: randomly shaded triangles, G: a triangle grid,
                        A: a ragged vertical gradient used as a warp
     T_Noise_01_D       soft cloud noise, for the map's glass

   The shader dumps list each shader's baked textures one slot off from where
   the code reads them; the slots below follow what the code samples. */

export const GRADIENT_TEXTURE = "textures/T_Gradient_01.png";
export const PATTERN_TEXTURE = "textures/T_Pattern_04_RGBM.png";
export const NOISE_TEXTURE = "textures/T_Noise_01_D.png";

const textures = new Map();
function dataTexture(url) {
    if (!textures.has(url)) {
        const texture = new THREE.TextureLoader().load(url);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.NoColorSpace;
        textures.set(url, texture);
    }
    return textures.get(url);
}

/* Uniforms every ported shader shares, as the same objects, so one update a
   frame reaches all of them. */
const screen = {
    uTime: { value: 0 },
    uViewport: { value: new THREE.Vector2(1, 1) },   // CSS pixels
    uPixelRatio: { value: 1 }
};

const drawingSize = new THREE.Vector2();
export function updateScreenUniforms(renderer, seconds) {
    const ratio = renderer.getPixelRatio();
    renderer.getDrawingBufferSize(drawingSize);
    screen.uTime.value = seconds;
    screen.uPixelRatio.value = ratio;
    screen.uViewport.value.set(drawingSize.x / ratio, drawingSize.y / ratio);
}

/* Every Catalyst map shader shares a screen-space dot grid: the screen is cut
   into 3x3 pixel cells, the top-left 60% of each (a 2x2 dot) at full
   strength, the rest at the gap value. Done in CSS pixels so high-density
   screens keep the game's grain. Also the shimmer both shaders run: a
   gradient scrolling up the screen through coordinates warped by the
   pattern's alpha, overlay-blended with the triangle shades, sparkling white
   where the blend clips. */
const SCREEN_COMMON = /* glsl */ `
    uniform float uTime;
    uniform vec2 uViewport;
    uniform float uPixelRatio;
    uniform sampler2D uGradient;
    uniform sampler2D uPattern;

    // Pixel position with a top-left origin, as Dx11's SV_Position has it.
    vec2 screenPixel() {
        vec2 px = gl_FragCoord.xy / uPixelRatio;
        return vec2(px.x, uViewport.y - px.y);
    }

    float dotGrid(vec2 px, float gap) {
        vec2 cell = fract(px / 3.0);
        float dot = (cell.x <= 0.6 && cell.y <= 0.6) ? 1.0 : 0.0;
        return min(1.0, dot + gap);
    }

    // uv: screen position in screen heights. Returns the shimmer level in x
    // and the sparkle (0 or 1) in y.
    vec2 shimmer(vec2 uv, float warpScale, float patternScale, float speed) {
        float warp = texture2D(uPattern, uv * warpScale).a;
        vec2 gradUv = vec2(warp * uv.x * warpScale, uv.y * warpScale + warp) + vec2(0.0, 6.0 * fract(speed * uTime));
        float grad = texture2D(uGradient, gradUv).r;
        vec2 pattern = texture2D(uPattern, uv * patternScale).rg;   // r: triangle shades, g: grid

        float overlay = grad < 0.5
            ? 2.0 * grad * pattern.x
            : 1.0 - 2.0 * (1.0 - grad) * (1.0 - pattern.x);
        return vec2(3.0 * grad * pattern.y * pattern.x + 0.25 * pattern.y, overlay > 0.99 ? 1.0 : 0.0);
    }

    // 4x4 ordered dither threshold, for drawing partial opacity as a screen
    // door instead of a sorted blend.
    float bayer4(vec2 px) {
        ivec2 p = ivec2(mod(floor(px), 4.0));
        int i = p.x + p.y * 4;
        float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
        return (m[i] + 0.5) / 16.0;
    }
`;

/* World position, normal and UV for the fragment side, with the renderer's
   logarithmic depth buffer and scene fog wired in like built-in materials. */
const WORLD_VERTEX = /* glsl */ `
    #include <common>
    #include <fog_pars_vertex>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec2 vUv;

    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
    }
`;

/* Objects/RunnersObjects/SS_RunVisMapMarker - the route chevrons on the map.

   Per pixel: a rim term brightens surfaces turned edge-on to the camera, the
   shimmer and triangle grid add a faceted sparkle, and the 3px dot grid (gaps
   at 60%) is applied last.

   The game's output stops at a greyscale brightness: the red is added later,
   where runner's vision objects are composited, which is not part of this
   shader. TINT_BASE and TINT_GAIN stand in for that step - brightness maps
   onto the given red, and anything past full brightness blows out towards
   white, as the game's highlights do. */
const TINT_BASE = 0.55;
const TINT_GAIN = 0.7;

export function createRouteMarkerMaterial(colorHex) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...screen,
            uGradient: { value: dataTexture(GRADIENT_TEXTURE) },
            uPattern: { value: dataTexture(PATTERN_TEXTURE) },
            /* Written straight to the screen, so kept in display (sRGB) values. */
            uColor: { value: new THREE.Vector3(((colorHex >> 16) & 255) / 255, ((colorHex >> 8) & 255) / 255, (colorHex & 255) / 255) }
        },
        vertexShader: WORLD_VERTEX,
        fragmentShader: /* glsl */ `
            ${SCREEN_COMMON}
            #include <logdepthbuf_pars_fragment>
            uniform vec3 uColor;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;

            void main() {
                #include <logdepthbuf_fragment>
                vec3 toCamera = normalize(cameraPosition - vWorldPos);
                float rim = clamp(1.001 - dot(normalize(vWorldNormal), toCamera), 0.0, 1.0);
                rim = min(1.0, max(0.0, (rim - 0.3) * 1.42857146) * 1.4);

                vec2 px = screenPixel();
                vec2 uv = px / uViewport.y;
                vec2 s = shimmer(uv, 0.5, 11.0, 0.05);
                float level = s.y * 0.85 + s.x + rim + 0.15;

                /* Stand-in for the game's red compositing, see above; the dot
                   grid then applies to the result, as the game's last step. */
                vec3 tinted = uColor * (${TINT_BASE.toFixed(2)} + ${TINT_GAIN.toFixed(2)} * level);
                vec3 blowout = vec3(max(level - 1.0, 0.0)) * 0.5;
                gl_FragColor = vec4(min(tinted + blowout, vec3(1.0)) * dotGrid(px, 0.6), 1.0);
            }
        `
    });
}

/* Uniforms the city materials share. The game's shader works in metres
   around a map laid out at y = -5000; here the city is the model scaled to
   unit size, so distances go through uMetres (metres per world unit) and
   heights are measured from uGroundY. uWaypoint is the waypoint's world
   position, with its radius in metres in w (0 = no waypoint). The game's
   waypoint region is a cylinder (ground distance only); uWaypointSphere set
   to 1 measures in 3D instead, for Glassguessr's Count height modifier. */
const city = {
    uMetres: { value: 1 },
    uGroundY: { value: 0 },
    uWaypoint: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWaypointSphere: { value: 0 },
    uExposure: { value: 0.5 }
};

export function setCityFrame(metresPerUnit, groundY) {
    city.uMetres.value = metresPerUnit;
    city.uGroundY.value = groundY;
}

export function setCityWaypoint(worldPos, radiusMetres, sphere = false) {
    if (worldPos) city.uWaypoint.value.set(worldPos.x, worldPos.y, worldPos.z, radiusMetres);
    else city.uWaypoint.value.set(0, 0, 0, 0);
    city.uWaypointSphere.value = sphere ? 1 : 0;
}

/* Objects/.../SS_Map - the city on Catalyst's map screen. Its colour input
   (MapColors) is the building's own texture, which here is the export's
   baked diffuse. In order:

     colour   brightened as 0.5c^2 + 1.5c, then clamped (MinColor 0,
              MaxColor 4, MultiplyColor 1 at their defaults)
     waypoint anything within the waypoint's radius on the ground pulses
              towards Catalyst red, rgb(180, 14, 14), |sin(t)| * 0.4 + 0.75
     fog      FogColor (3, 3, 3) added by (distance / 3000 m)^4, weaker the
              higher the camera
     glass    Glass materials instead reflect T_Noise_01_D, tinted between
              cl1 and cl2 by the rim, and take 60% of the colour
     close up within 60 m of the camera the rim, the dot grid (gaps 80%) and
              the shimmer drive opacity down towards 50-80%, and the shimmer
              adds a glow; past 60 m the surface is solid

   The game renders HDR and maps it through an exposure; uExposure = 0.5
   brings the colour curve's white (2.0) back to 1. Its alpha blending is
   drawn here as an ordered dither, which needs no sorting. */
export function createMapMaterial({ map = null, color = new THREE.Color(1, 1, 1), glass = false } = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...screen,
            ...city,
            uGradient: { value: dataTexture(GRADIENT_TEXTURE) },
            uPattern: { value: dataTexture(PATTERN_TEXTURE) },
            uNoise: { value: dataTexture(NOISE_TEXTURE) },
            uMapColors: { value: map },
            uHasMap: { value: map ? 1 : 0 },
            uBaseColor: { value: color.clone() },
            uGlass: { value: glass ? 1 : 0 }
        },
        fog: true,
        vertexShader: WORLD_VERTEX,
        fragmentShader: /* glsl */ `
            ${SCREEN_COMMON}
            #include <common>
            #include <fog_pars_fragment>
            #include <logdepthbuf_pars_fragment>
            uniform sampler2D uNoise;
            uniform sampler2D uMapColors;
            uniform float uHasMap;
            uniform vec3 uBaseColor;
            uniform float uGlass;
            uniform float uMetres;
            uniform float uGroundY;
            uniform vec4 uWaypoint;
            uniform float uWaypointSphere;
            uniform float uExposure;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;
            varying vec2 vUv;

            const vec3 CL1 = vec3(0.34, 0.369, 0.407);
            const vec3 CL2 = vec3(0.657, 0.702, 0.761);
            const vec3 WAYPOINT_RED = vec3(0.70588237, 0.0549019985, 0.0549019985);

            void main() {
                #include <logdepthbuf_fragment>
                vec3 normal = normalize(vWorldNormal);
                vec3 toCamera = normalize(cameraPosition - vWorldPos);
                vec2 px = screenPixel();
                vec2 uv = px / uViewport.y;

                vec2 s = shimmer(uv, 0.4, 9.6, 0.1);
                float glow = s.x + s.y;

                float rim = clamp(1.001 - dot(normal, toCamera), 0.0, 1.0);
                float rimTerm = min(0.5, max(0.0, 2.0 * (rim - 0.5)) * 1.4);
                float opacity = clamp(rimTerm + glow, 0.0, 1.0) * 0.3 + 0.5;

                float distM = distance(cameraPosition, vWorldPos) * uMetres;
                float near = 1.0 - min(1.0, distM / 60.0);
                float alpha = clamp(near * (opacity * dotGrid(px, 0.8) - 1.0) + 1.0, 0.0, 1.0);
                if (alpha < bayer4(px)) discard;

                vec3 c = uHasMap > 0.5 ? texture2D(uMapColors, vUv).rgb : uBaseColor;
                c = clamp(0.5 * (c * c + c) + c, 0.0, 4.0);

                vec3 col = c;
                float waypointDistance = uWaypointSphere > 0.5
                    ? distance(vWorldPos, uWaypoint.xyz)
                    : distance(vWorldPos.xz, uWaypoint.xz);
                if (uWaypoint.w > 0.0 && waypointDistance * uMetres < uWaypoint.w) {
                    float pulse = abs(sin(uTime)) * 0.4 + 0.75;
                    vec3 red = mix(c, WAYPOINT_RED, 0.65);
                    red = clamp(1.0 - (1.0 - red) * vec3(1.41666663, 18.2142735, 18.2142735), 0.0, 1.0);
                    red = min(vec3(1.0), red + vec3(0.352941185, 0.0274509992, 0.0274509992));
                    col = c + pulse * (red - c);
                }

                float height = clamp((cameraPosition.y - uGroundY) * uMetres / 600.0, 0.0, 1.0);
                float fogAmount = (1.0 - 0.85 * height) * min(1.0, pow(distM / 3000.0, 4.0));

                vec3 result;
                if (uGlass > 0.5) {
                    vec3 bent = texture2D(uNoise, vUv * 0.5).rgb * 0.2 + normal;
                    vec2 reflected = toCamera.xy - bent.xy * 2.0 * dot(toCamera, bent);
                    vec3 tint = mix(CL1, CL2, rim + 0.2);
                    vec3 glassColor = tint + 0.3 * (tint * texture2D(uNoise, reflected).rgb - tint);
                    result = glassColor + 0.6 * (glassColor * c - glassColor);
                } else {
                    result = vec3(3.0) * fogAmount + col;
                }
                result += glow * near;

                gl_FragColor = vec4(result * uExposure, 1.0);
                #include <colorspace_fragment>
                #include <fog_fragment>
            }
        `
    });
}

/* UI/Map/SS_MapSurroundings - the city outside the playable map, which has
   no textures of its own. Every surface is coloured by which way it faces:
   lit faces (normal leaning +x / up) go to SunColor, the rest towards
   ShadowColor01, a pale teal; faces leaning +z (and away from +x) sink into
   ShadowColor02, a deep blue; and upward faces blend to TopColor. Geometry
   darkens to 63% at ground level (fully lit 91 m up), and FogColor (1.2) is
   added by (distance / 3000 m)^4, weaker the higher the camera.

   Normals feed in as they are: the export's axes, after the city's Z-up
   correction, line up with Frostbite's (x east, y up, z north). */
export function createSurroundingsMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...city
        },
        fog: true,
        vertexShader: WORLD_VERTEX,
        fragmentShader: /* glsl */ `
            #include <common>
            #include <fog_pars_fragment>
            #include <logdepthbuf_pars_fragment>
            uniform float uMetres;
            uniform float uGroundY;
            uniform float uExposure;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;

            const vec3 SUN = vec3(1.0);
            const vec3 SHADOW1 = vec3(0.142, 0.508, 0.665);
            const vec3 SHADOW2 = vec3(0.0, 0.108, 0.552);
            const vec3 TOP = vec3(1.0);
            const vec3 FOG = vec3(1.2);

            void main() {
                #include <logdepthbuf_fragment>
                vec3 n = normalize(vWorldNormal);
                vec3 c = mix(SHADOW1, SUN, clamp(n.x + n.y, 0.0, 1.0));
                c = mix(c, SHADOW2, clamp(-0.8 * n.x + n.z, 0.0, 1.0));
                c += n.y * (TOP - c);

                float height = clamp((vWorldPos.y - uGroundY) * uMetres * 0.011, 0.0, 1.0);
                c = clamp(((height - 1.0) * 0.37 + 1.0) * c, 0.0, 1.0);

                float distM = distance(cameraPosition, vWorldPos) * uMetres;
                float cameraHeight = clamp((cameraPosition.y - uGroundY) * uMetres * 0.001, 0.0, 1.0);
                c += FOG * min(1.0, pow(distM / 3000.0, 4.0)) * (1.0 - 0.7 * cameraHeight);

                gl_FragColor = vec4(c * uExposure, 1.0);
                #include <colorspace_fragment>
                #include <fog_fragment>
            }
        `
    });
}

/* UI/Map/SS_Map_Water - the sea. T_Noise_01_D is sampled twice, at 6x the
   water's UVs and again turned a quarter-turn, both drifting at 0.01 a
   second; their average bends the surface normal, the view reflected off it
   samples the noise once more, and that is tinted between cl1 and cl2 (dark
   and light blue-grey) by the rim. Transparency 0.95 x Opacity, fading out by
   (distance / 5000 m)^2. The dumped Opacity default is 0 - the game's material
   must set it - so 1 is used here. */
export function createWaterMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...screen,
            ...city,
            uNoise: { value: dataTexture(NOISE_TEXTURE) },
            uOpacity: { value: 1 }
        },
        fog: true,
        transparent: true,
        vertexShader: WORLD_VERTEX,
        fragmentShader: /* glsl */ `
            #include <common>
            #include <fog_pars_fragment>
            #include <logdepthbuf_pars_fragment>
            uniform float uTime;
            uniform sampler2D uNoise;
            uniform float uMetres;
            uniform float uExposure;
            uniform float uOpacity;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;
            varying vec2 vUv;

            const vec3 CL1 = vec3(0.116, 0.137, 0.144);
            const vec3 CL2 = vec3(0.552, 0.59, 0.644);

            void main() {
                #include <logdepthbuf_fragment>
                float distM = distance(cameraPosition, vWorldPos) * uMetres;
                float alpha = clamp(0.95 * uOpacity * (1.0 - min(1.0, pow(distM * 0.0002, 2.0))), 0.0, 1.0);

                vec2 drift = vec2(0.01 * uTime);
                vec2 turned = vec2(0.00477764569 * vUv.x - 5.99999809 * vUv.y, 5.99999809 * vUv.x + 0.00477764569 * vUv.y);
                vec3 ripple = mix(texture2D(uNoise, 6.0 * vUv + drift).rgb, texture2D(uNoise, turned + drift).rgb, 0.5);

                vec3 normal = normalize(vWorldNormal);
                vec3 bent = ripple * 0.25 + normal;
                vec3 toCamera = normalize(cameraPosition - vWorldPos);
                vec2 reflected = toCamera.xy - bent.xy * 2.0 * dot(toCamera, bent);

                float rim = clamp(1.001 - dot(normal, toCamera), 0.0, 1.0) + 0.2;
                vec3 tint = mix(CL1, CL2, rim);
                vec3 c = tint + 0.3 * (tint * texture2D(uNoise, reflected).rgb - tint);

                gl_FragColor = vec4(c * uExposure, alpha);
                #include <colorspace_fragment>
                #include <fog_fragment>
            }
        `
    });
}

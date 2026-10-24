import { fromFrostbite } from "./glassguessr_map.js";

/* Round data for GlassGuessr.
 *
 * Coordinates are RAW FROSTBITE values, exactly as read in-game: Y-up, metres,
 * no conversion applied. fromFrostbite() handles the axis change and the 1:100
 * scale at read time, so a location can be pasted straight in without any
 * arithmetic and can always be checked back against the game later.
 *
 *   image       the screenshot for the round, under locations/. Keep the
 *               names meaningless: anyone can read the URL in the network tab,
 *               so a descriptive name gives the answer away.
 *   position    [x, y, z] in Frostbite coordinates, null until measured.
 *   difficulty  1..5, optional.
 */
export const LOCATIONS = [
    { image: "locations/MirrorsEdgeCatalyst_HjhXtfW3CV.jpg", position: [-86.3, 56.1, 146.2] },
    { image: "locations/MirrorsEdgeCatalyst_QnDBtAYgP1.jpg", position: [190.5, 59.1, -1.3] },
    { image: "locations/MirrorsEdgeCatalyst_rAq7gzLWqH.jpg", position: [-41.0, 55.3, 43.9] },
    { image: "locations/MirrorsEdgeCatalyst_VKdkqXOot2.jpg", position: [39.1, 67.8, 187.4] },
    { image: "locations/MirrorsEdgeCatalyst_yOtpp2sx7s.jpg", position: [65.3, 55.8, 33.0] }
];

/* Frostbite position as model-space coordinates, ready for addMarker, scoring
   or anything else that speaks the map's own space. */
export function locationPosition(location) {
    return fromFrostbite(
        location.position[0],
        location.position[1],
        location.position[2]
    );
}

/* Roughly the playable extent of Glass in model units, from the district
   centroids plus headroom. Only used to catch data entry mistakes - a dropped
   or misplaced decimal puts a location in the ocean or off the map entirely,
   and that is otherwise invisible until the round comes up in play. */
const PLAYABLE = { minX: -10, maxX: 16, minY: -13, maxY: 9 };

export function validateLocations(locations = LOCATIONS) {
    const problems = [];
    const seen = new Set();

    for (const location of locations) {
        const name = location.image || JSON.stringify(location);

        if (!location.image) problems.push(name + ": no image");
        else if (seen.has(location.image)) problems.push(name + ": duplicate image");
        seen.add(location.image);

        if (location.position === null) {
            problems.push(name + ": no position yet");
            continue;
        }
        if (!Array.isArray(location.position) || location.position.length !== 3) {
            problems.push(name + ": position must be [x, y, z]");
            continue;
        }
        if (location.position.some((n) => typeof n !== "number" || !isFinite(n))) {
            problems.push(name + ": position has a non-numeric component");
            continue;
        }

        const p = locationPosition(location);
        if (p.x < PLAYABLE.minX || p.x > PLAYABLE.maxX ||
            p.y < PLAYABLE.minY || p.y > PLAYABLE.maxY) {
            problems.push(
                name + ": lands outside Glass at model (" +
                p.x.toFixed(2) + ", " + p.y.toFixed(2) + ") - check for a lost decimal"
            );
        }
    }

    return problems;
}

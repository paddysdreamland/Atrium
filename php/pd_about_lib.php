<?php
declare(strict_types=1);

// php/pd_about_lib.php  —  About Us helpers shared by pd_about.php, pd_about_admin.php and
// pd_supporters_admin.php. Needs pd_lib.php (PD_GUILD_ROLES, pd_avatar_url) loaded first.

// Roles are only read at login, so a supporter who stops boosting stays "supporter" until they
// log in again. Snapshots older than this aren't trusted: their card leaves the page until then.
const PD_SUPPORTER_MAX_AGE_DAYS = 60;

const PD_SUPPORTER_TAGLINE_MAX = 140; // characters; the card shows about three lines

/** The card's tag: the highest PD staff role in a site_roles snapshot ("founder,moderator" -> "Founder"). */
function pd_about_role(?string $siteRoles): ?string {
    $held = explode(',', (string) $siteRoles);
    foreach (array_keys(PD_GUILD_ROLES) as $role) { // highest first
        if ($role !== 'supporter' && in_array($role, $held, true)) { // Supporter is its own tag, not a rank
            return ucfirst($role);
        }
    }
    return null;
}

/** Whether a site_roles snapshot has the Supporter (server booster) role, for the card's second tag. */
function pd_about_is_supporter(?string $siteRoles): bool {
    return in_array('supporter', explode(',', (string) $siteRoles), true);
}

/**
 * Every flag a card may show, as name => site path: the silk flags in images/flags/<code>.png
 * and images/flags/pride/<name>.png (made with Silk Flag Maker, outside the repo),
 * e.g. "de" => "images/flags/de.png".
 */
function pd_about_flag_options(): array {
    $root    = dirname(__DIR__);
    $options = [];
    $files   = array_merge(
        glob($root . '/images/flags/*.png') ?: [],
        glob($root . '/images/flags/pride/*.png') ?: []
    );
    foreach ($files as $file) {
        $path = substr($file, strlen($root) + 1);
        $name = preg_replace('#^images/flags/|\.png$#', '', $path);
        if ($name !== 'template') {
            $options[$name] = $path;
        }
    }
    return $options;
}

/** Whether a flag path is a pride flag; every other flag stands for a language the person speaks. */
function pd_about_is_pride_flag(string $path): bool {
    return strpos($path, 'images/flags/pride/') === 0;
}

/** A stored flags column (one JSON list of paths) -> ['pride' => [...], 'languages' => [...]]. */
function pd_about_flags(?string $json): array {
    $flags  = json_decode((string) $json, true);
    $groups = ['pride' => [], 'languages' => []];
    foreach (is_array($flags) ? $flags : [] as $path) {
        $groups[pd_about_is_pride_flag($path) ? 'pride' : 'languages'][] = $path;
    }
    return $groups;
}

/**
 * An editor's pride and language picks -> the flags column (JSON, or null for none), or respond
 * 422 and exit. Up to 3 of each, stored as one list (pride first). Only flags that exist
 * (see pd_about_flag_options), so a card never asks for a missing file.
 */
function pd_about_clean_flags($pride, $languages): ?string {
    $flagPaths = pd_about_flag_options();
    $flags     = [];
    foreach (['pride' => $pride, 'language' => $languages] as $label => $list) {
        if (!is_array($list) || count($list) > 3) {
            pd_json_error(422, 'invalid', "Pick at most 3 {$label} flags.");
        }
        foreach ($list as $flag) {
            if (!in_array($flag, $flagPaths, true)) {
                pd_json_error(422, 'invalid', 'One of the flags no longer exists on the site.');
            }
            if (pd_about_is_pride_flag($flag) !== ($label === 'pride')) {
                pd_json_error(422, 'invalid', "A flag was picked as the wrong kind ({$label}).");
            }
            $flags[] = $flag;
        }
    }
    $flags = array_values(array_unique($flags));
    return $flags ? json_encode($flags) : null;
}

/* Supporters */

/**
 * Everyone whose last login found the Supporter role, longest-boosting first, or just one account.
 * Their name and picture come straight from pd_users, so they follow every login; pd_supporters
 * only adds what they wrote. inStaff: they have a staff block, which shows them instead.
 */
function pd_supporter_rows(PDO $pdo, ?string $id = null): array {
    $sql = 'SELECT u.discord_id, COALESCE(NULLIF(u.global_name, \'\'), u.username) AS name, u.avatar_hash,
                   u.site_roles, u.boosting_since, s.tagline, s.flags,
                   COALESCE(s.hidden, 0) AS hidden, COALESCE(s.removed, 0) AS removed, s.updated_at,
                   (a.discord_id IS NOT NULL) AS in_staff
              FROM pd_users u
              LEFT JOIN pd_supporters s ON s.discord_id = u.discord_id
              LEFT JOIN pd_about a ON a.discord_id = u.discord_id
             WHERE FIND_IN_SET(\'supporter\', u.site_roles)
               AND u.roles_checked_at > DATE_SUB(NOW(), INTERVAL ? DAY)'
         . ($id !== null ? ' AND u.discord_id = ?' : '')
         . ' ORDER BY u.boosting_since IS NULL, u.boosting_since, name';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($id !== null ? [PD_SUPPORTER_MAX_AGE_DAYS, $id] : [PD_SUPPORTER_MAX_AGE_DAYS]);
    return $stmt->fetchAll();
}

/** A supporter row -> what the public page draws (renderSupporterCard in pd_about.js). */
function pd_supporter_card(array $row): array {
    $flags = pd_about_flags($row['flags']);
    return [
        'name'          => $row['name'],
        'image'         => pd_avatar_url((string) $row['discord_id'], $row['avatar_hash']),
        'role'          => pd_about_role($row['site_roles']), // staff without a block of their own
        'supporter'     => true,
        'boostingSince' => $row['boosting_since'] !== null ? substr($row['boosting_since'], 0, 7) : null, // "2025-03"
        'tagline'       => (string) $row['tagline'],
        'pride'         => $flags['pride'],
        'languages'     => $flags['languages'],
    ];
}

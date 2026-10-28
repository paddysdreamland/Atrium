<?php
declare(strict_types=1);

// php/pd_about_lib.php  —  About Us helpers shared by pd_about.php, pd_about_admin.php and
// pd_supporters_admin.php. Needs pd_lib.php (PD_GUILD_ROLES, pd_avatar_url) loaded first.

// Roles are only read at login, so a supporter who stops boosting stays "supporter" until they
// log in again. Snapshots older than this aren't trusted: their card leaves the page until then.
const PD_SUPPORTER_MAX_AGE_DAYS = 60;

const PD_SUPPORTER_TAGLINE_MAX = 140; // characters; the card shows about three lines

/**
 * A card's picture: the owner's Discord avatar, which follows every login, or null if they've
 * never logged in here (cards then use the picture the Founder set, if any). The site's own copy
 * when there is one (see pd_save_avatar in auth/callback.php), else Discord's link; 256px, so
 * the 128px picture beside a staff block stays sharp.
 *
 * The copies are saved on the main site, where every login lands, so they're linked there in
 * full: staging doesn't have them. $row needs discord_id, has_login, avatar_hash and avatar_file.
 */
function pd_about_avatar(array $row): ?string {
    if (!$row['has_login']) {
        return null;
    }
    return $row['avatar_file']
        ? 'https://' . PD_SITE_HOSTS[0] . '/' . $row['avatar_file']
        : pd_avatar_url((string) $row['discord_id'], $row['avatar_hash'], 256);
}

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
 * Every supporter card: everyone whose last login found the Supporter role (longest-boosting
 * first), then the cards added by hand for people who aren't boosting (by name). Or just one card,
 * by its pd_supporters id or by Discord account ($by = 'id' | 'discord_id').
 *
 * Anyone who has logged in is named and pictured from pd_users, so that follows every login;
 * pd_supporters adds what they wrote, and for cards added by hand, the name and picture to show
 * until then. id is null for a booster who hasn't changed anything yet. inStaff: they have a
 * staff block, which shows them instead.
 */
function pd_supporter_rows(PDO $pdo, ?string $by = null, $value = null): array {
    $boosting = 'COALESCE(FIND_IN_SET(\'supporter\', u.site_roles) > 0
                          AND u.roles_checked_at > DATE_SUB(NOW(), INTERVAL ? DAY), 0)';
    $columns  = 's.id, COALESCE(u.discord_id, s.discord_id) AS discord_id, COALESCE(s.manual, 0) AS manual,
                 COALESCE(NULLIF(u.global_name, \'\'), u.username, s.name) AS name,
                 s.name AS fallback_name, s.image AS fallback_image, s.support,
                 (u.discord_id IS NOT NULL) AS has_login, u.avatar_hash, u.avatar_file, u.site_roles,
                 s.tagline, s.flags, COALESCE(s.hidden, 0) AS hidden, COALESCE(s.removed, 0) AS removed,
                 s.updated_at, (a.discord_id IS NOT NULL) AS in_staff';

    $sql = "SELECT * FROM (
                SELECT {$columns}, 1 AS boosting, u.boosting_since
                  FROM pd_users u
                  LEFT JOIN pd_supporters s ON s.discord_id = u.discord_id
                  LEFT JOIN pd_about a ON a.discord_id = u.discord_id
                 WHERE {$boosting}
                UNION ALL
                SELECT {$columns}, 0 AS boosting, NULL AS boosting_since
                  FROM pd_supporters s
                  LEFT JOIN pd_users u ON u.discord_id = s.discord_id
                  LEFT JOIN pd_about a ON a.discord_id = s.discord_id
                 WHERE s.manual = 1 AND NOT {$boosting}
            ) c"
         . ($by === 'id' ? ' WHERE c.id = ?' : ($by === 'discord_id' ? ' WHERE c.discord_id = ?' : ''))
         . ' ORDER BY c.boosting DESC, c.boosting_since IS NULL, c.boosting_since, c.name';
    $params = [PD_SUPPORTER_MAX_AGE_DAYS, PD_SUPPORTER_MAX_AGE_DAYS];
    if ($by !== null) {
        $params[] = $value;
    }
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll();
}

/** A supporter row -> what the public page draws (renderSupporterCard in pd_about.js). */
function pd_supporter_card(array $row): array {
    $flags = pd_about_flags($row['flags']);
    return [
        'name'          => $row['name'],
        'image'         => pd_about_avatar($row) ?? $row['fallback_image'],
        'role'          => pd_about_role($row['site_roles']), // staff without a block of their own
        'supporter'     => true,
        'boostingSince' => $row['boosting'] && $row['boosting_since'] !== null ? substr($row['boosting_since'], 0, 7) : null, // "2025-03"
        'support'       => (string) $row['support'], // shown in place of boostingSince
        'tagline'       => (string) $row['tagline'],
        'pride'         => $flags['pride'],
        'languages'     => $flags['languages'],
    ];
}

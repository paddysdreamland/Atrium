<?php
declare(strict_types=1);

// php/pd_site_admin.php  —  the Site Manager: the main page's titles, descriptions and embed
// banner (Managers and up). pd_site_meta.php has how they reach the page.
//
// GET  -> {"ok": true, "values": {...}, "defaults": {...}, "latestNews": "..." or null,
//          "banners": ["images/embeds/banner8.png", ...]}
//         values are what's saved ('' for pd_main.html's own, which defaults has); banners are
//         the pictures in the main site's images/embeds folder, to pick from.
// POST -> {"action": "update", "values": {...}}  -> the same as GET
// Call it as /php/pd_site_admin (no .php): see pd_posts_admin.php for why.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_blocks.php';
require __DIR__ . '/pd_site_meta.php';

header('Content-Type: application/json');

$pdo    = pd_db($config);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    pd_require_permission($pdo, 'site.manage');
    echo json_encode(pd_site_admin_state($pdo));
    exit;
}

if ($method !== 'POST') {
    pd_json_error(405, 'method_not_allowed');
}

pd_require_same_origin();
$user  = pd_require_permission($pdo, 'site.manage');
$input = pd_read_json_body();

if (($input['action'] ?? '') !== 'update') {
    pd_json_error(400, 'unknown_action');
}

// Only what changed, so updated_by says who last touched each field.
$values = pd_site_admin_clean($input['values'] ?? null);
$saved  = pd_site_meta_saved($pdo);
$stmt   = $pdo->prepare(
    'INSERT INTO pd_site_meta (meta_key, meta_value, updated_by, updated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value), updated_by = VALUES(updated_by), updated_at = NOW()'
);
foreach ($values as $field => $value) {
    if ($value !== ($saved[$field] ?? '')) {
        $stmt->execute([$field, $value, $user['discord_id']]);
    }
}

echo json_encode(pd_site_admin_state($pdo));

/* Helpers */

function pd_site_admin_state(PDO $pdo): array {
    $saved  = pd_site_meta_saved($pdo);
    $values = [];
    foreach (array_keys(PD_SITE_META_FIELDS) as $field) {
        $values[$field] = $saved[$field] ?? '';
    }

    $banners = [];
    foreach (scandir(pd_live_root() . '/images/embeds') ?: [] as $name) {
        if (preg_match('~^[A-Za-z0-9_\-.]+\.(?:png|jpe?g|gif|webp)$~i', $name)) {
            $banners[] = 'images/embeds/' . $name;
        }
    }

    return [
        'ok'         => true,
        'values'     => $values,
        'defaults'   => pd_site_meta_defaults((string) file_get_contents(dirname(__DIR__) . '/pd_main.html')),
        'latestNews' => pd_site_meta_latest_news($pdo),
        'banners'    => $banners,
    ];
}

/** Validate the editor's values and return them ready to save, or respond 422 and exit. */
function pd_site_admin_clean($values): array {
    if (!is_array($values)) {
        pd_json_error(422, 'invalid', 'Missing values.');
    }

    $clean = [];
    foreach (PD_SITE_META_FIELDS as $field => [$label, $max]) {
        // Plain text on one line: it's escaped wherever it goes, and a <title> can't break lines.
        $value = trim((string) preg_replace('~\s+~u', ' ', (string) ($values[$field] ?? '')));
        if (preg_match_all('~.~us', $value) > $max) {
            pd_json_error(422, 'invalid', "$label: $max characters at most.");
        }
        $clean[$field] = $value;
    }

    // Discord & co. load the banner from the main site, so that's where it has to be.
    $banner  = ltrim($clean['banner'], '/');
    $decoded = rawurldecode($banner);
    if ($banner !== '' && (!pd_blocks_valid_path($banner, 'png|jpe?g|gif|webp')
        || strpos($decoded, '..') !== false || !is_file(pd_live_root() . '/' . $decoded))) {
        pd_json_error(422, 'invalid', 'Banner: that picture isn\'t on the main site. Pick one from the list, or upload it here.');
    }
    $clean['banner'] = $banner;

    return $clean;
}

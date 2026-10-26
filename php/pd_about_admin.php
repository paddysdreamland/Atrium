<?php
declare(strict_types=1);

// php/pd_about_admin.php  —  About Us block management. Each block belongs to one Discord
// account: Moderators and up (about.edit) write their own, the Founder (about.manage) anyone's.
//
// GET  -> {"ok": true, "ownId": "...", "blocks": [...], "flagOptions": {"de": "images/flags/de.png", ...}}
//         (flag names starting "pride/" are pride flags, the rest language flags)
//         (just your own block without about.manage)
// POST -> {"action": "create" | "update", "block": {...}}
//         {"action": "delete", "discordId": "..."}
// Call it as /php/pd_about_admin (no .php): see pd_posts_admin.php for why.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_blocks.php';
require __DIR__ . '/pd_about_lib.php';

header('Content-Type: application/json');

$pdo    = pd_db($config);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $user = pd_require_permission($pdo, 'about.edit');
    $rows = pd_user_can($user, 'about.manage')
        ? pd_about_rows($pdo)
        : pd_about_rows($pdo, (string) $user['discord_id']);
    echo json_encode([
        'ok'          => true,
        'ownId'       => (string) $user['discord_id'],
        'blocks'      => array_map('pd_about_admin_row', $rows),
        'flagOptions' => pd_about_flag_options(),
    ]);
    exit;
}

if ($method !== 'POST') {
    pd_json_error(405, 'method_not_allowed');
}

pd_require_same_origin();
$user      = pd_require_permission($pdo, 'about.edit');
$ownId     = (string) $user['discord_id'];
$canManage = pd_user_can($user, 'about.manage');
$input     = pd_read_json_body();

switch ($input['action'] ?? '') {
    case 'create':
        $block = pd_about_clean($input['block'] ?? null);
        $id    = $block['discordId'];
        if ($id !== $ownId && !$canManage) {
            pd_json_error(403, 'forbidden', 'You can only create your own block.');
        }
        if (pd_about_rows($pdo, $id)) {
            pd_json_error(409, 'id_taken', 'That account already has a block. Edit it instead.');
        }

        // Only the Founder places blocks; everyone else's goes to the bottom.
        $order = $canManage
            ? $block['sortOrder']
            : (int) $pdo->query('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pd_about')->fetchColumn();

        $stmt = $pdo->prepare(
            'INSERT INTO pd_about (discord_id, name, image, flags, body, sort_order, hidden, updated_by, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())'
        );
        $stmt->execute([$id, $block['name'], $block['image'], $block['flags'], $block['body'], $order, $block['hidden'], $ownId]);
        echo json_encode(['ok' => true, 'block' => pd_about_admin_row(pd_about_rows($pdo, $id)[0])]);
        exit;

    case 'update':
        $block = pd_about_clean($input['block'] ?? null);
        $id    = $block['discordId'];
        if ($id !== $ownId && !$canManage) {
            pd_json_error(403, 'forbidden', 'You can only edit your own block.');
        }
        if (!pd_about_rows($pdo, $id)) {
            pd_json_error(404, 'not_found', 'That block no longer exists.');
        }

        // sort_order is the Founder's to change.
        $stmt = $pdo->prepare(
            'UPDATE pd_about
                SET name = ?, image = ?, flags = ?, body = ?, hidden = ?, sort_order = IF(?, ?, sort_order),
                    updated_by = ?, updated_at = NOW()
              WHERE discord_id = ?'
        );
        $stmt->execute([
            $block['name'], $block['image'], $block['flags'], $block['body'], $block['hidden'],
            $canManage ? 1 : 0, $block['sortOrder'], $ownId, $id,
        ]);
        echo json_encode(['ok' => true, 'block' => pd_about_admin_row(pd_about_rows($pdo, $id)[0])]);
        exit;

    case 'delete':
        $id = (string) ($input['discordId'] ?? '');
        if ($id !== $ownId && !$canManage) {
            pd_json_error(403, 'forbidden', 'You can only delete your own block.');
        }
        $stmt = $pdo->prepare('DELETE FROM pd_about WHERE discord_id = ?');
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) {
            pd_json_error(404, 'not_found', 'That block no longer exists.');
        }
        echo json_encode(['ok' => true]);
        exit;

    default:
        pd_json_error(400, 'unknown_action');
}

/* Helpers */

/** Every block in page order, or just one account's. Joined to pd_users for the owner's name. */
function pd_about_rows(PDO $pdo, ?string $id = null): array {
    $sql = 'SELECT a.discord_id, a.name, a.image, a.flags, a.body, a.sort_order, a.hidden, a.updated_at, a.updated_by,
                   COALESCE(NULLIF(u.global_name, \'\'), u.username) AS owner_name, u.site_roles
              FROM pd_about a
              LEFT JOIN pd_users u ON u.discord_id = a.discord_id'
         . ($id !== null ? ' WHERE a.discord_id = ?' : '')
         . ' ORDER BY a.sort_order, a.name';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($id !== null ? [$id] : []);
    return $stmt->fetchAll();
}

/** DB row -> the editor's shape. Same keys pd_about.php uses, plus the management fields. */
function pd_about_admin_row(array $row): array {
    $flags = pd_about_flags($row['flags']);
    return [
        'discordId' => (string) $row['discord_id'],
        'ownerName' => $row['owner_name'],
        'name'      => $row['name'],
        'image'     => $row['image'],
        'role'      => pd_about_role($row['site_roles']), // read-only, for the preview
        'pride'     => $flags['pride'],
        'languages' => $flags['languages'],
        'body'      => json_decode((string) $row['body'], true) ?? [],
        'sortOrder' => (int) $row['sort_order'],
        'hidden'    => (bool) $row['hidden'],
        'updatedAt' => $row['updated_at'],
        'updatedBy' => $row['updated_by'] !== null ? (string) $row['updated_by'] : null,
    ];
}

/** Validate an editor payload and return DB-ready values, or respond 422 and exit. */
function pd_about_clean($b): array {
    if (!is_array($b)) {
        pd_json_error(422, 'invalid', 'Missing block data.');
    }

    // Whose block this is; the caller decides whether it may be someone else's.
    $discordId = trim((string) ($b['discordId'] ?? ''));
    if (!preg_match('/^\d{17,20}$/', $discordId)) {
        pd_json_error(422, 'invalid', 'Discord ID must be the 17–20 digit account ID.');
    }

    // Rendered with textContent, so plain text is stored as-is.
    $name = trim((string) ($b['name'] ?? ''));
    if ($name === '' || strlen($name) > 255) {
        pd_json_error(422, 'invalid', 'Name is required (max 255 characters).');
    }

    $image = trim((string) ($b['image'] ?? ''));
    if ($image !== '') {
        if (!pd_blocks_valid_path($image, 'png|jpe?g|gif|webp')) {
            pd_json_error(422, 'invalid', 'Image must be a .png, .jpg, .gif or .webp path on this site.');
        }
        if (!pd_blocks_file_exists($image)) {
            pd_json_error(422, 'invalid', "Image \"{$image}\" does not exist on the site.");
        }
    }

    // Up to 3 pride and 3 language flags, stored as one list (pride first). Only flags that exist
    // (see pd_about_flag_options), so a card never asks for a missing file.
    $flagPaths = pd_about_flag_options();
    $flags     = [];
    foreach (['pride' => 'pride', 'languages' => 'language'] as $key => $label) {
        $list = $b[$key] ?? [];
        if (!is_array($list) || count($list) > 3) {
            pd_json_error(422, 'invalid', "Pick at most 3 {$label} flags.");
        }
        foreach ($list as $flag) {
            if (!in_array($flag, $flagPaths, true)) {
                pd_json_error(422, 'invalid', 'One of the flags no longer exists on the site.');
            }
            if (pd_about_is_pride_flag($flag) !== ($key === 'pride')) {
                pd_json_error(422, 'invalid', "A flag was picked as the wrong kind ({$label}).");
            }
            $flags[] = $flag;
        }
    }
    $flags = array_values(array_unique($flags));

    $sortOrder = filter_var($b['sortOrder'] ?? 0, FILTER_VALIDATE_INT, ['options' => ['min_range' => -9999, 'max_range' => 9999]]);
    if ($sortOrder === false) {
        pd_json_error(422, 'invalid', 'Order must be a whole number between -9999 and 9999.');
    }

    return [
        'discordId' => $discordId,
        'name'      => $name,
        'image'     => $image !== '' ? $image : null,
        'flags'     => $flags ? json_encode($flags) : null,
        'body'      => pd_blocks_clean($b['body'] ?? null),
        'sortOrder' => $sortOrder,
        'hidden'    => !empty($b['hidden']) ? 1 : 0,
    ];
}

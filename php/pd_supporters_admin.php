<?php
declare(strict_types=1);

// php/pd_supporters_admin.php  —  Supporter cards on the About Us page. Everyone with the
// Supporter role (supporter.edit) has a card automatically, named and pictured from their
// Discord profile; they only choose its tagline and flags, or hide it. The Founder
// (supporter.manage) can edit anyone's and take a card down, which its owner can't undo.
//
// GET  -> {"ok": true, "ownId": "...", "cards": [...], "flagOptions": {...}}
//         (just your own card without supporter.manage; see pd_about_admin.php for flagOptions)
// POST -> {"action": "update", "card": {"discordId", "tagline", "pride", "languages", "hidden", "removed"}}
// Call it as /php/pd_supporters_admin (no .php): see pd_posts_admin.php for why.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_about_lib.php';

header('Content-Type: application/json');

$pdo       = pd_db($config);
$method    = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$user      = pd_require_any_permission($pdo, ['supporter.edit', 'supporter.manage']);
$ownId     = (string) $user['discord_id'];
$canManage = pd_user_can($user, 'supporter.manage');

if ($method === 'GET') {
    $rows = $canManage ? pd_supporter_rows($pdo) : pd_supporter_rows($pdo, $ownId);
    echo json_encode([
        'ok'          => true,
        'ownId'       => $ownId,
        'cards'       => array_map('pd_supporter_admin_row', $rows),
        'flagOptions' => pd_about_flag_options(),
    ]);
    exit;
}

if ($method !== 'POST') {
    pd_json_error(405, 'method_not_allowed');
}

pd_require_same_origin();
$input = pd_read_json_body();

if (($input['action'] ?? '') !== 'update') {
    pd_json_error(400, 'unknown_action');
}

$card = pd_supporter_clean($input['card'] ?? null);
$id   = $card['discordId'];
if ($id !== $ownId && !$canManage) {
    pd_json_error(403, 'forbidden', 'You can only edit your own card.');
}
if (!pd_supporter_rows($pdo, $id)) {
    pd_json_error(404, 'not_found', 'That account isn\'t a supporter any more.');
}

// "removed" is the Founder's to change; a new row from anyone else starts out not taken down.
$stmt = $pdo->prepare(
    'INSERT INTO pd_supporters (discord_id, tagline, flags, hidden, removed, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
          tagline    = VALUES(tagline),
          flags      = VALUES(flags),
          hidden     = VALUES(hidden),
          removed    = IF(?, VALUES(removed), removed),
          updated_by = VALUES(updated_by),
          updated_at = NOW()'
);
$stmt->execute([
    $id, $card['tagline'], $card['flags'], $card['hidden'], $canManage ? $card['removed'] : 0, $ownId,
    $canManage ? 1 : 0,
]);
echo json_encode(['ok' => true, 'card' => pd_supporter_admin_row(pd_supporter_rows($pdo, $id)[0])]);
exit;

/* Helpers */

/** Supporter row -> the editor's shape: the public card's keys plus the management fields. */
function pd_supporter_admin_row(array $row): array {
    return pd_supporter_card($row) + [
        'discordId' => (string) $row['discord_id'],
        'hidden'    => (bool) $row['hidden'],
        'removed'   => (bool) $row['removed'],
        'inStaff'   => (bool) $row['in_staff'],
        'updatedAt' => $row['updated_at'],
    ];
}

/** Validate an editor payload and return DB-ready values, or respond 422 and exit. */
function pd_supporter_clean($c): array {
    if (!is_array($c)) {
        pd_json_error(422, 'invalid', 'Missing card data.');
    }

    // Whose card this is; the caller decides whether it may be someone else's.
    $discordId = trim((string) ($c['discordId'] ?? ''));
    if (!preg_match('/^\d{17,20}$/', $discordId)) {
        pd_json_error(422, 'invalid', 'Discord ID must be the 17–20 digit account ID.');
    }

    // One line of plain text (rendered with textContent): newlines and tabs become spaces,
    // other control characters go.
    $tagline = (string) ($c['tagline'] ?? '');
    $tagline = trim((string) preg_replace(['/\s+/u', '/\p{Cc}/u'], [' ', ''], $tagline));
    if (mb_strlen($tagline) > PD_SUPPORTER_TAGLINE_MAX) {
        pd_json_error(422, 'invalid', 'The tagline can be at most ' . PD_SUPPORTER_TAGLINE_MAX . ' characters.');
    }

    return [
        'discordId' => $discordId,
        'tagline'   => $tagline !== '' ? $tagline : null,
        'flags'     => pd_about_clean_flags($c['pride'] ?? [], $c['languages'] ?? []),
        'hidden'    => !empty($c['hidden']) ? 1 : 0,
        'removed'   => !empty($c['removed']) ? 1 : 0,
    ];
}

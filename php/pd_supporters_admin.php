<?php
declare(strict_types=1);

// php/pd_supporters_admin.php  —  Supporter cards on the About Us page.
//
// Everyone with the Supporter role (supporter.edit) has a card automatically, named and pictured
// from their Discord profile; they only choose its tagline and flags, or hide it. The Founder
// (supporter.manage) can edit anyone's, say how they support ("Artist") and since when, take a
// card down (its owner can't undo that), and add cards by hand for people who support without
// boosting. The Founder's name, picture and date are stand-ins: logging in with Discord (and, for
// the date, boosting) replaces them.
//
// GET  -> {"ok": true, "ownId": "...", "cards": [...], "flagOptions": {...}}
//         (just your own card without supporter.manage; see pd_about_admin.php for flagOptions)
// POST -> {"action": "create", "card": {...}}                  (supporter.manage: a card added by hand)
//         {"action": "update", "card": {"id" or "discordId", ...}} (id is null until a booster's first save)
//         {"action": "delete", "id": 12}                       (supporter.manage: cards added by hand only)
// Call it as /php/pd_supporters_admin (no .php): see pd_posts_admin.php for why.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_blocks.php';
require __DIR__ . '/pd_about_lib.php';

header('Content-Type: application/json');

$pdo       = pd_db($config);
$method    = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$user      = pd_require_any_permission($pdo, ['supporter.edit', 'supporter.manage']);
$ownId     = (string) $user['discord_id'];
$canManage = pd_user_can($user, 'supporter.manage');

if ($method === 'GET') {
    $rows = $canManage ? pd_supporter_rows($pdo) : pd_supporter_rows($pdo, 'discord_id', $ownId);
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

switch ($input['action'] ?? '') {
    case 'create':
        if (!$canManage) {
            pd_json_error(403, 'forbidden', 'Only the Founder can add cards.');
        }
        $card = pd_supporter_clean($input['card'] ?? null, true, true);
        if ($card['discord_id'] !== null && pd_supporter_id($pdo, $card['discord_id']) !== null) {
            pd_json_error(409, 'id_taken', 'That account already has a card. Edit it instead.');
        }

        $stmt = $pdo->prepare(
            'INSERT INTO pd_supporters (discord_id, manual, name, image, support, since, tagline, flags, hidden, removed, updated_by, updated_at)
                  VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())'
        );
        $stmt->execute([
            $card['discord_id'], $card['name'], $card['image'], $card['support'], $card['since'], $card['tagline'],
            $card['flags'], $card['hidden'], $card['removed'], $ownId,
        ]);
        pd_supporter_respond($pdo, (int) $pdo->lastInsertId());

    case 'update':
        $sent = $input['card'] ?? null;
        $id   = is_array($sent) ? filter_var($sent['id'] ?? null, FILTER_VALIDATE_INT) : false;
        $rows = $id !== false
            ? pd_supporter_rows($pdo, 'id', $id)
            : pd_supporter_rows($pdo, 'discord_id', is_array($sent) ? (string) ($sent['discordId'] ?? '') : '');
        if (!$rows) {
            pd_json_error(404, 'not_found', 'That card no longer exists, or they stopped boosting.');
        }
        $row = $rows[0];
        if ((string) $row['discord_id'] !== $ownId && !$canManage) {
            pd_json_error(403, 'forbidden', 'You can only edit your own card.');
        }
        $card = pd_supporter_clean($sent, $canManage, (bool) $row['manual']);

        // A booster's first save gives their card a row.
        if ($row['id'] === null) {
            $pdo->prepare('INSERT IGNORE INTO pd_supporters (discord_id, updated_by, updated_at) VALUES (?, ?, NOW())')
                ->execute([$row['discord_id'], $ownId]);
            $row['id'] = pd_supporter_id($pdo, (string) $row['discord_id']);
        }

        // Only the fields this editor may change (see pd_supporter_clean).
        $sets = implode(', ', array_map(static fn (string $column): string => "{$column} = ?", array_keys($card)));
        try {
            $pdo->prepare("UPDATE pd_supporters SET {$sets}, updated_by = ?, updated_at = NOW() WHERE id = ?")
                ->execute([...array_values($card), $ownId, $row['id']]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') { // the unique discord_id
                pd_json_error(409, 'id_taken', 'That Discord account already has a card.');
            }
            throw $e;
        }
        pd_supporter_respond($pdo, (int) $row['id']);

    case 'delete':
        if (!$canManage) {
            pd_json_error(403, 'forbidden', 'Only the Founder can delete cards.');
        }
        $id   = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT) ?: 0;
        $stmt = $pdo->prepare('SELECT manual FROM pd_supporters WHERE id = ?');
        $stmt->execute([$id]);
        $manual = $stmt->fetchColumn();
        if ($manual === false) {
            pd_json_error(404, 'not_found', 'That card no longer exists.');
        }
        if (!$manual) {
            pd_json_error(422, 'invalid', 'Only cards added by hand can be deleted. Tick "Taken down" to remove a booster\'s card.');
        }
        $pdo->prepare('DELETE FROM pd_supporters WHERE id = ? AND manual = 1')->execute([$id]);
        echo json_encode(['ok' => true]);
        exit;

    default:
        pd_json_error(400, 'unknown_action');
}

/* Helpers */

/** The pd_supporters id of an account's card, or null if it has none. */
function pd_supporter_id(PDO $pdo, string $discordId): ?int {
    $stmt = $pdo->prepare('SELECT id FROM pd_supporters WHERE discord_id = ?');
    $stmt->execute([$discordId]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int) $id;
}

/** Answer a create or update with the card as it's now stored. */
function pd_supporter_respond(PDO $pdo, int $id): void {
    $rows = pd_supporter_rows($pdo, 'id', $id);
    echo json_encode(['ok' => true, 'card' => $rows ? pd_supporter_admin_row($rows[0]) : null]);
    exit;
}

/** Supporter row -> the editor's shape: the public card's keys plus the management fields. */
function pd_supporter_admin_row(array $row): array {
    return pd_supporter_card($row) + [
        'id'            => $row['id'] !== null ? (int) $row['id'] : null,
        'discordId'     => (string) $row['discord_id'],
        'manual'        => (bool) $row['manual'],
        'fallbackName'  => (string) $row['fallback_name'],
        'fallbackImage' => (string) $row['fallback_image'],
        'fallbackSince' => $row['fallback_since'] !== null ? substr($row['fallback_since'], 0, 7) : '', // the Founder's date
        'hasLogin'      => (bool) $row['has_login'],
        'boosting'      => (bool) $row['boosting'],
        'hidden'        => (bool) $row['hidden'],
        'removed'       => (bool) $row['removed'],
        'inStaff'       => (bool) $row['in_staff'],
        'updatedAt'     => $row['updated_at'],
    ];
}

/**
 * One line of plain text (rendered with textContent): newlines and tabs become spaces, other
 * control characters go. null when empty; responds 422 and exits when over $max characters.
 */
function pd_supporter_text($value, int $max, string $label): ?string {
    $text = trim((string) preg_replace(['/\s+/u', '/\p{Cc}/u'], [' ', ''], (string) $value));
    if (mb_strlen($text) > $max) {
        pd_json_error(422, 'invalid', "{$label} can be at most {$max} characters.");
    }
    return $text !== '' ? $text : null;
}

/**
 * Validate an editor payload into column => value, or respond 422 and exit. Only the columns
 * this editor may change: supporters their tagline, flags and hiding it; the Founder also how
 * and since when they support, and taking it down; and on cards added by hand, its name, picture
 * and account.
 */
function pd_supporter_clean($c, bool $canManage, bool $manual): array {
    if (!is_array($c)) {
        pd_json_error(422, 'invalid', 'Missing card data.');
    }

    $clean = [
        'tagline' => pd_supporter_text($c['tagline'] ?? '', PD_SUPPORTER_TAGLINE_MAX, 'The tagline'),
        'flags'   => pd_about_clean_flags($c['pride'] ?? [], $c['languages'] ?? []),
        'hidden'  => !empty($c['hidden']) ? 1 : 0,
    ];
    if (!$canManage) {
        return $clean;
    }

    $clean['support'] = pd_supporter_text($c['support'] ?? '', 64, 'How they support');
    $clean['removed'] = !empty($c['removed']) ? 1 : 0;

    // "2023-03" from the month picker, stored as the 1st; shown until Discord has a boosting date.
    $since = trim((string) ($c['fallbackSince'] ?? ''));
    if ($since !== '' && (!preg_match('/^(\d{4})-(0[1-9]|1[0-2])$/', $since, $m)
        || (int) $m[1] < 2000 || $since > gmdate('Y-m'))) {
        pd_json_error(422, 'invalid', 'Supporting since must be a month between 2000 and now.');
    }
    $clean['since'] = $since !== '' ? "{$since}-01" : null;
    if (!$manual) {
        return $clean;
    }

    $clean['name'] = pd_supporter_text($c['fallbackName'] ?? '', 64, 'The name');
    if ($clean['name'] === null) {
        pd_json_error(422, 'invalid', 'A card added by hand needs a name.');
    }

    $image = trim((string) ($c['fallbackImage'] ?? ''));
    if ($image !== '') {
        if (!pd_blocks_valid_path($image, 'png|jpe?g|gif|webp')) {
            pd_json_error(422, 'invalid', 'The picture must be a .png, .jpg, .gif or .webp path on this site.');
        }
        if (!pd_blocks_file_exists($image)) {
            pd_json_error(422, 'invalid', "The picture \"{$image}\" does not exist on the site.");
        }
    }
    $clean['image'] = $image !== '' ? $image : null;

    // Optional: their Discord account, so their own name and picture take over once they log in.
    $discordId = trim((string) ($c['discordId'] ?? ''));
    if ($discordId !== '' && !preg_match('/^\d{17,20}$/', $discordId)) {
        pd_json_error(422, 'invalid', 'Discord ID must be the 17–20 digit account ID, or empty.');
    }
    $clean['discord_id'] = $discordId !== '' ? $discordId : null;

    return $clean;
}

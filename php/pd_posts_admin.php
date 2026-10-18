<?php
declare(strict_types=1);

// php/pd_posts_admin.php  —  news post management for the Founder & Managers.
//
// GET  -> every post (hidden ones included), in the raw shape the editor works with.
// POST -> {"action": "create" | "update", "post": {...}}
//         {"action": "delete", "postKey": "..."}
// Everything goes through POST rather than PUT/DELETE, since shared hosting's
// ModSecurity likes to swallow those. Call it as /php/pd_posts_admin (no .php):
// .htaccess 301s *.php URLs, and browsers turn a redirected POST into a GET.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_blocks.php';

header('Content-Type: application/json');

$pdo    = pd_db($config);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    pd_require_permission($pdo, 'news.manage');
    $rows = $pdo->query(
        'SELECT post_key, header, post_date, post_body, post_signature, irrelevant, hidden, updated_at, updated_by
           FROM pd_newsposts
          ORDER BY post_date DESC'
    )->fetchAll();
    echo json_encode(['ok' => true, 'posts' => array_map('pd_news_admin_row', $rows)]);
    exit;
}

if ($method !== 'POST') {
    pd_json_error(405, 'method_not_allowed');
}

pd_require_same_origin();
$user  = pd_require_permission($pdo, 'news.manage');
$input = pd_read_json_body();

switch ($input['action'] ?? '') {
    case 'create':
        $post = pd_news_clean($input['post'] ?? null);
        if (pd_news_find($pdo, $post['key'])) {
            pd_json_error(409, 'key_taken', 'A post with that key already exists.');
        }
        $stmt = $pdo->prepare(
            'INSERT INTO pd_newsposts
                    (post_key, header, post_date, post_body, post_signature, irrelevant, hidden,
                     created_by, created_at, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())'
        );
        $stmt->execute([
            $post['key'], $post['header'], $post['date'], $post['body'], $post['signature'],
            $post['irrelevant'], $post['hidden'], $user['discord_id'], $user['discord_id'],
        ]);
        echo json_encode(['ok' => true, 'post' => pd_news_admin_row(pd_news_find($pdo, $post['key']))]);
        exit;

    case 'update':
        $post = pd_news_clean($input['post'] ?? null);
        if (!pd_news_find($pdo, $post['key'])) {
            pd_json_error(404, 'not_found', 'That post no longer exists.');
        }
        // post_images and created_* are deliberately left alone.
        $stmt = $pdo->prepare(
            'UPDATE pd_newsposts
                SET header = ?, post_date = ?, post_body = ?, post_signature = ?,
                    irrelevant = ?, hidden = ?, updated_by = ?, updated_at = NOW()
              WHERE post_key = ?'
        );
        $stmt->execute([
            $post['header'], $post['date'], $post['body'], $post['signature'],
            $post['irrelevant'], $post['hidden'], $user['discord_id'], $post['key'],
        ]);
        echo json_encode(['ok' => true, 'post' => pd_news_admin_row(pd_news_find($pdo, $post['key']))]);
        exit;

    case 'delete':
        if (!pd_user_can($user, 'news.delete')) {
            pd_json_error(403, 'forbidden', 'Only the Founder can permanently delete posts. Hide it instead.');
        }
        $stmt = $pdo->prepare('DELETE FROM pd_newsposts WHERE post_key = ?');
        $stmt->execute([(string) ($input['postKey'] ?? '')]);
        if ($stmt->rowCount() === 0) {
            pd_json_error(404, 'not_found', 'That post no longer exists.');
        }
        echo json_encode(['ok' => true]);
        exit;

    default:
        pd_json_error(400, 'unknown_action');
}

/* Helpers */

function pd_news_find(PDO $pdo, string $key): ?array {
    $stmt = $pdo->prepare(
        'SELECT post_key, header, post_date, post_body, post_signature, irrelevant, hidden, updated_at, updated_by
           FROM pd_newsposts
          WHERE post_key = ?
          LIMIT 1'
    );
    $stmt->execute([$key]);
    return $stmt->fetch() ?: null;
}

/** DB row -> the editor's shape. Same keys pd_posts.php uses, but the date stays raw (Y-m-d). */
function pd_news_admin_row(array $row): array {
    return [
        'postKey'       => $row['post_key'],
        'postHeader'    => $row['header'],
        'postDate'      => substr((string) $row['post_date'], 0, 10),
        'postBody'      => json_decode((string) $row['post_body'], true) ?? [],
        'postSignature' => $row['post_signature'],
        'irrelevant'    => (bool) $row['irrelevant'],
        'hidden'        => (bool) $row['hidden'],
        'updatedAt'     => $row['updated_at'],
        'updatedBy'     => $row['updated_by'],
    ];
}

/** Validate an editor payload and return DB-ready values, or respond 422 and exit. */
function pd_news_clean($p): array {
    if (!is_array($p)) {
        pd_json_error(422, 'invalid', 'Missing post data.');
    }

    $key = trim((string) ($p['postKey'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $key)) {
        pd_json_error(422, 'invalid', 'Post key: letters, numbers, - and _ only (max 64).');
    }

    // Header and signature are rendered with textContent, so plain text is stored as-is.
    $header = trim((string) ($p['postHeader'] ?? ''));
    if ($header === '' || strlen($header) > 255) {
        pd_json_error(422, 'invalid', 'Header is required (max 255 characters).');
    }
    $signature = trim((string) ($p['postSignature'] ?? ''));
    if ($signature === '' || strlen($signature) > 255) {
        pd_json_error(422, 'invalid', 'Signature is required (max 255 characters).');
    }

    $date = (string) ($p['postDate'] ?? '');
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        pd_json_error(422, 'invalid', 'Date must be a valid YYYY-MM-DD date.');
    }

    return [
        'key'        => $key,
        'header'     => $header,
        'date'       => $date,
        'body'       => pd_blocks_clean($p['postBody'] ?? null),
        'signature'  => $signature,
        'irrelevant' => !empty($p['irrelevant']) ? 1 : 0,
        'hidden'     => !empty($p['hidden']) ? 1 : 0,
    ];
}

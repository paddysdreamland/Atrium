<?php
declare(strict_types=1);

// php/pd_about.php  —  the About Us page: {"staff": [...], "supporters": [...]}.
// Staff are the visible blocks in page order (written in pd_about_admin.php); supporters are
// everyone with the Supporter role (see pd_supporter_rows), minus hidden cards and anyone
// already shown as staff.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_about_lib.php';

header('Content-Type: application/json');

$pdo = pd_db($config);

// The owner's picture and roles come from their last login, for the card's picture and tags.
// a.image is the Founder's picture for owners who haven't logged in here yet.
$rows = $pdo->query(
    'SELECT a.discord_id, a.name, a.image, a.flags, a.body, u.site_roles, u.avatar_hash, u.avatar_file,
            (u.discord_id IS NOT NULL) AS has_login
       FROM pd_about a
       LEFT JOIN pd_users u ON u.discord_id = a.discord_id
      WHERE a.hidden = 0
      ORDER BY a.sort_order, a.name'
)->fetchAll(PDO::FETCH_ASSOC);

$staff = array_map(static function (array $row): array {
    $flags = pd_about_flags($row['flags']);
    return [
        'name'      => $row['name'],
        'image'     => pd_about_avatar($row) ?? $row['image'],
        'role'      => pd_about_role($row['site_roles']),
        'supporter' => pd_about_is_supporter($row['site_roles']),
        'pride'     => $flags['pride'],
        'languages' => $flags['languages'],
        'body'      => json_decode($row['body'], true) ?? [],
    ];
}, $rows);

$supporters = array_values(array_filter(
    pd_supporter_rows($pdo),
    static fn (array $row): bool => !$row['in_staff'] && !$row['hidden'] && !$row['removed']
));

echo json_encode([
    'staff'      => $staff,
    'supporters' => array_map('pd_supporter_card', $supporters),
]);

<?php
declare(strict_types=1);

// php/pd_about.php  —  the visible About Us blocks, in page order (written in pd_about_admin.php).

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_about_lib.php';

header('Content-Type: application/json');

$pdo = pd_db($config);

// The owner's roles come from their last login, for the card's tag.
$rows = $pdo->query(
    'SELECT a.name, a.image, a.flags, a.body, u.site_roles
       FROM pd_about a
       LEFT JOIN pd_users u ON u.discord_id = a.discord_id
      WHERE a.hidden = 0
      ORDER BY a.sort_order, a.name'
)->fetchAll(PDO::FETCH_ASSOC);

$members = array_map(static function (array $row): array {
    $flags = pd_about_flags($row['flags']);
    return [
        'name'      => $row['name'],
        'image'     => $row['image'],
        'role'      => pd_about_role($row['site_roles']),
        'pride'     => $flags['pride'],
        'languages' => $flags['languages'],
        'body'      => json_decode($row['body'], true) ?? [],
    ];
}, $rows);

echo json_encode($members);

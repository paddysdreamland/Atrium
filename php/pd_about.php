<?php
declare(strict_types=1);

// php/pd_about.php  —  the visible About Us blocks, in page order (written in pd_about_admin.php).

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';

header('Content-Type: application/json');

$pdo = pd_db($config);

$rows = $pdo->query(
    'SELECT name, image, body
       FROM pd_about
      WHERE hidden = 0
      ORDER BY sort_order, name'
)->fetchAll(PDO::FETCH_ASSOC);

$members = array_map(static function (array $row): array {
    return [
        'name'  => $row['name'],
        'image' => $row['image'],
        'body'  => json_decode($row['body'], true) ?? [],
    ];
}, $rows);

echo json_encode($members);

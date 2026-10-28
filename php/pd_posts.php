<?php
declare(strict_types=1);

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';
require __DIR__ . '/pd_staging.php';
require __DIR__ . '/pd_blocks.php';

header('Content-Type: application/json');

$pdo = pd_db($config);
$ctx = pd_tags_context(); // conditional blocks show per branch, time and timezone

$rows = $pdo->query(
    'SELECT post_key, header, post_date, post_body, post_images, post_signature, irrelevant
       FROM pd_newsposts
      WHERE hidden = 0
      ORDER BY post_date DESC'
)->fetchAll(PDO::FETCH_ASSOC);

$posts = array_map(static function (array $row) use ($ctx): array {
    return [
        'postKey'       => $row['post_key'],
        'postHeader'    => $row['header'],
        // DATE -> the human format the renderer prints verbatim, e.g. "3rd of January 2026".
        'postDate'      => date('jS \o\f F Y', strtotime($row['post_date'])),
        'postBody'      => pd_blocks_for_visitor(json_decode($row['post_body'], true) ?? [], $ctx),
        'postImages'    => $row['post_images'] !== null ? (json_decode($row['post_images'], true) ?? []) : [],
        'postSignature' => $row['post_signature'],
        'irrelevant'    => (bool) $row['irrelevant'],
    ];
}, $rows);

echo json_encode($posts);

<?php
require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/pd_log.php';
$pdo = pd_pdo();

// Count each browser once a day, and never the Founder/Managers, so reloads
// (and staff working on the site) don't inflate the number.
// Staging never counts: it's test traffic, and it shares the database with the real site.
// The cookie is shared with staging (domain), so one browser is one visitor on both.
$isStaging = stripos($_SERVER['HTTP_HOST'] ?? '', 'staging.') === 0;
if (!$isStaging && empty($_COOKIE['pd_counted']) && !pd_is_staff($pdo)) {
    $pdo->query("UPDATE pd_counter SET hits = hits + 1 WHERE name = 'visits'");
    setcookie('pd_counted', '1', [
        'expires'  => time() + 86400,
        'path'     => '/',
        'domain'   => 'paddysdreamland.com',
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

$n = $pdo->query("SELECT hits FROM pd_counter WHERE name = 'visits'")->fetchColumn();
header('Content-Type: application/json');
echo json_encode(['visits' => (int)$n]);

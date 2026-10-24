<?php
// php/pd_staging_page.php  —  serves the top-level .html pages on staging, but only
// after the members-only gate. .htaccess sends staging's page requests here.
// (On the main site the gate does nothing, so this would just serve the page.)

require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/pd_log.php';
require __DIR__ . '/pd_staging.php';

pd_guard();
pd_staging_gate();

// Only plain top-level page names like "obs_timer_15.html". No folders, no "..".
// pd_main.html is only ever served through index.php.
$file = (string) ($_GET['f'] ?? '');
$path = dirname(__DIR__) . '/' . $file;
if (!preg_match('/^[A-Za-z0-9_-]+\.html$/', $file) || $file === 'pd_main.html' || !is_file($path)) {
    http_response_code(404);
    echo 'Not found';
    exit;
}

header('Content-Type: text/html; charset=UTF-8');
readfile($path);

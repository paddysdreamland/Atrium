<?php
declare(strict_types=1);

// auth/me.php  —  the SPA calls this on load to find out who (if anyone) is logged in.
// Returns 200 with the user, or 401 if not authenticated.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';

header('Content-Type: application/json');

$pdo  = pd_db($config);
$user = pd_current_user($pdo);

if (!$user) {
    http_response_code(401);
    echo json_encode(['authenticated' => false]);
    exit;
}

echo json_encode([
    'authenticated' => true,
    'user' => [
        'id'          => $user['discord_id'],
        'username'    => $user['username'],
        'displayName' => $user['global_name'] ?: $user['username'],
        'avatarUrl'   => pd_avatar_url($user['discord_id'], $user['avatar_hash']),
    ],
    // For showing/hiding UI only — every privileged endpoint re-checks on the server.
    'permissions' => pd_user_permissions($user),
    'isMember'    => $user['is_member'],   // in the PD Discord server (unlocks staging)
    'rolesStale'  => !$user['roles_fresh'],
]);

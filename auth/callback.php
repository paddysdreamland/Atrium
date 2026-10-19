<?php
declare(strict_types=1);

// auth/callback.php  —  Discord sends the user back here after they authorize.
// This is the only file that uses your client secret.

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';

$appUrl = rtrim($config['app_url'], '/');

// 1) Verify the CSRF state matches what we set in login.php.
$state       = $_GET['state'] ?? '';
$cookieState = $_COOKIE['pd_oauth_state'] ?? '';
if ($state === '' || $cookieState === '' || !hash_equals($cookieState, $state)) {
    pd_clear_cookie('pd_oauth_state');
    pd_clear_cookie('pd_oauth_return');
    http_response_code(400);
    exit('Invalid login state. Please try logging in again.');
}

// 2) We need an authorization code. If it's missing, the user cancelled.
$code = $_GET['code'] ?? '';
if ($code === '') {
    pd_clear_cookie('pd_oauth_state');
    pd_clear_cookie('pd_oauth_return');
    header('Location: ' . $appUrl . '/?login=cancelled');
    exit;
}

// 3) Exchange the code for an access token (server-side, with the secret).
$token = pd_discord_post('https://discord.com/api/oauth2/token', [
    'client_id'     => $config['discord']['client_id'],
    'client_secret' => $config['discord']['client_secret'],
    'grant_type'    => 'authorization_code',
    'code'          => $code,
    'redirect_uri'  => $config['discord']['redirect_uri'],
]);
if (empty($token['access_token'])) {
    http_response_code(502);
    exit('Could not complete Discord login (token exchange failed).');
}

// 4) Use the token once to read who they are, then throw the token away.
$me = pd_discord_get('https://discord.com/api/users/@me', $token['access_token']);
if (empty($me['id'])) {
    http_response_code(502);
    exit('Could not read your Discord profile.');
}

// 4b) While we still hold the token, snapshot whether they're in the PD server and
//     which PD roles they have. This is the only chance: the token is discarded after
//     this request. null = Discord couldn't be asked; store nothing and leave them stale.
$membership = pd_fetch_membership($token['access_token']);
$siteRoles  = $membership['roles']  ?? null;
$isMember   = $membership['member'] ?? false;

// 5) Insert or update the user record (keyed on the stable Discord ID).
$pdo = pd_db($config);
$stmt = $pdo->prepare(
    'INSERT INTO pd_users (discord_id, username, global_name, avatar_hash, site_roles, is_member, roles_checked_at, last_login_at)
          VALUES (:id, :username, :global_name, :avatar, :roles, :member, IF(:checked, NOW(), NULL), NOW())
     ON DUPLICATE KEY UPDATE
          username         = VALUES(username),
          global_name      = VALUES(global_name),
          avatar_hash      = VALUES(avatar_hash),
          site_roles       = VALUES(site_roles),
          is_member        = VALUES(is_member),
          roles_checked_at = VALUES(roles_checked_at),
          last_login_at    = NOW()'
);
$stmt->execute([
    ':id'          => $me['id'],
    ':username'    => $me['username'] ?? '',
    ':global_name' => $me['global_name'] ?? null,
    ':avatar'      => $me['avatar'] ?? null,
    ':roles'       => $siteRoles ?? '',
    ':member'      => $isMember ? 1 : 0,
    ':checked'     => $siteRoles === null ? 0 : 1,
]);

// 6) Create OUR session: store only the hash, hand the raw token to the cookie.
$sessionToken = bin2hex(random_bytes(32));
$tokenHash    = hash('sha256', $sessionToken);
$days         = (int) ($config['session_lifetime_days'] ?? 30);
$ins = $pdo->prepare(
    'INSERT INTO pd_sessions (token_hash, discord_id, expires_at)
          VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))'
);
$ins->execute([$tokenHash, $me['id'], $days]);
pd_set_session_cookie($sessionToken, $days);

// 7) Clean up and bounce back to where they started (main site or staging).
pd_clear_cookie('pd_oauth_state');
$return = (string) ($_COOKIE['pd_oauth_return'] ?? '/');
pd_clear_cookie('pd_oauth_return');

// Only our own addresses (PD_SITE_HOSTS) — never an off-site open redirect.
$target = pd_safe_return_url($return, $appUrl) ?? ($appUrl . '/');
header('Location: ' . $target);
exit;

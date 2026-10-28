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

// 5) Insert or update the user record (keyed on the stable Discord ID). The name and avatar
//    are what Supporter cards on the About Us page show, so they stay current with each login.
$pdo = pd_db($config);
$stmt = $pdo->prepare(
    'INSERT INTO pd_users (discord_id, username, global_name, avatar_hash, site_roles, is_member, boosting_since, roles_checked_at, last_login_at)
          VALUES (:id, :username, :global_name, :avatar, :roles, :member, :boosting, IF(:checked, NOW(), NULL), NOW())
     ON DUPLICATE KEY UPDATE
          username         = VALUES(username),
          global_name      = VALUES(global_name),
          avatar_hash      = VALUES(avatar_hash),
          site_roles       = VALUES(site_roles),
          is_member        = VALUES(is_member),
          boosting_since   = VALUES(boosting_since),
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
    ':boosting'    => $membership['boostingSince'] ?? null,
    ':checked'     => $siteRoles === null ? 0 : 1,
]);

// 5b) Keep the site's own copy of their avatar for About Us cards. Never blocks the login:
//     without a copy, cards use Discord's link instead.
try {
    pd_save_avatar($pdo, (string) $me['id'], $me['avatar'] ?? null);
} catch (Throwable $e) {
    // no copy this time
}

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

/**
 * Save the user's Discord avatar (256px; GIFs stay animated) to images/uploads/<id>/ and point
 * pd_users.avatar_file at it, so cards don't depend on Discord keeping old avatars or being up.
 * Discord always sends logins to the main site, so the copies live there (see pd_about_avatar).
 * Downloads only when the avatar changed, and deletes the old copy. No avatar, or a failed
 * download: no copy, and cards use Discord's link.
 */
function pd_save_avatar(PDO $pdo, string $id, ?string $hash): void {
    $stmt = $pdo->prepare('SELECT avatar_file FROM pd_users WHERE discord_id = ?');
    $stmt->execute([$id]);
    $old  = $stmt->fetchColumn() ?: null;
    $root = dirname(__DIR__);
    $new  = null;

    if ($hash !== null && ctype_digit($id) && preg_match('/^(a_)?[a-f0-9]{32}$/', $hash)) {
        $ext  = strpos($hash, 'a_') === 0 ? 'gif' : 'png';
        // Named after the avatar, so an unchanged one is already here. 24 hex characters: the
        // only names images/uploads/.htaccess serves.
        $file = "images/uploads/{$id}/" . substr(hash('sha256', $hash), 0, 24) . ".{$ext}";
        $new  = is_file("{$root}/{$file}") || pd_download_avatar("https://cdn.discordapp.com/avatars/{$id}/{$hash}.{$ext}?size=256", "{$root}/{$file}", $ext)
            ? $file
            : null;
    }

    if ($new === $old) {
        return;
    }
    $pdo->prepare('UPDATE pd_users SET avatar_file = ? WHERE discord_id = ?')->execute([$new, $id]);
    if ($old !== null && preg_match('#^images/uploads/\d+/[a-f0-9]{24}\.(png|gif)$#', $old)) {
        @unlink("{$root}/{$old}");
    }
}

/** Download one avatar to $dest, only if it really is a PNG/GIF (by $ext) under 8 MB. */
function pd_download_avatar(string $url, string $dest, string $ext): bool {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_FOLLOWLOCATION => false]);
    $data   = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if (!is_string($data) || $status !== 200 || strlen($data) > 8 * 1024 * 1024) {
        return false;
    }
    $info = @getimagesizefromstring($data);
    if (!$info || $info[2] !== ($ext === 'gif' ? IMAGETYPE_GIF : IMAGETYPE_PNG)) {
        return false;
    }

    $dir = dirname($dest);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
        return false;
    }
    // Written under a temporary name first, so a half-written file is never served.
    $tmp = $dest . '.tmp';
    if (file_put_contents($tmp, $data) !== strlen($data) || !rename($tmp, $dest)) {
        @unlink($tmp);
        return false;
    }
    @chmod($dest, 0644);
    return true;
}

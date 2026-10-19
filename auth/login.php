<?php
declare(strict_types=1);

// auth/login.php  —  kick off the Discord OAuth flow.
// Link your header button here, optionally with ?return=/some/spa/path

$config = require dirname(__DIR__, 2) . '/private/pd_config.php';
require dirname(__DIR__, 2) . '/private/pd_lib.php';

// CSRF protection: a random value we'll check when Discord sends the user back.
// Shared cookie, because Discord always returns to the MAIN site's callback,
// even when the login was started on staging.
$state = bin2hex(random_bytes(16));
pd_set_cookie('pd_oauth_state', $state, 600);

// Remember where they started, so we can return them there.
// A plain path ("/news") means "this same address", so turn it into a full URL
// for whichever address (main site or staging) the login was started on.
$return = isset($_GET['return']) ? (string) $_GET['return'] : '/';
$host   = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
if (in_array($host, PD_SITE_HOSTS, true)) {
    $return = pd_safe_return_url($return, 'https://' . $host) ?? ('https://' . $host . '/');
}
pd_set_cookie('pd_oauth_return', $return, 600);

$params = http_build_query([
    'client_id'     => $config['discord']['client_id'],
    'redirect_uri'  => $config['discord']['redirect_uri'],
    'response_type' => 'code',
    'scope'         => 'identify guilds.members.read', // identity + PD roles only, no email or server list
    'state'         => $state,
    'prompt'        => 'none',       // skip the consent screen for returning users
]);

header('Location: https://discord.com/api/oauth2/authorize?' . $params);
exit;
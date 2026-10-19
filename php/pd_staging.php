<?php
// php/pd_staging.php  —  members-only gate for staging.paddysdreamland.com.
//
// On the main site this does nothing at all. On staging it lets a visitor through only if
// they're logged in with Discord AND were in the PD server at their last login check.
// Everyone else (including every bot) gets a small "members only" page instead.
//
// Needs pd_mon_config.php (for pd_pdo) to be loaded first, like pd_log.php does.

function pd_is_staging_host(): bool {
    return stripos($_SERVER['HTTP_HOST'] ?? '', 'staging.') === 0;
}

function pd_staging_gate(): void {
    if (!pd_is_staging_host()) {
        return;
    }

    require_once '/home/paddnols/private/pd_lib.php';

    // Belt and braces next to robots.txt: tell search engines not to list anything here.
    header('X-Robots-Tag: noindex, nofollow');

    $user  = null;
    $error = false;
    try {
        $user = pd_current_user(pd_pdo());
    } catch (Throwable $e) {
        $error = true;
    }

    // Member with an up-to-date check: come on in.
    if ($user && $user['is_member'] && $user['roles_fresh']) {
        return;
    }

    // Logged in, but the membership check is older than PD_ROLES_MAX_AGE_HOURS.
    // Send them through Discord once to re-check (prompt=none makes it a quick bounce).
    // The pd_gate_bounce cookie stops an endless loop if Discord can't be reached.
    $here = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    if ($user && !$user['roles_fresh'] && empty($_COOKIE['pd_gate_bounce'])) {
        setcookie('pd_gate_bounce', '1', [
            'expires'  => time() + 300,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        header('Location: /auth/login.php?return=' . rawurlencode($here));
        exit;
    }

    if ($error) {
        $title = 'Staging is having a moment';
        $text  = 'The login check could not be completed. Please try again in a bit.';
    } elseif (!$user) {
        $title = 'Members only';
        $text  = 'This is the test version of Paddy\'s Dreamland&trade;. It\'s open to everyone in the Discord server. Log in with Discord to continue.';
    } elseif (!$user['is_member']) {
        $title = 'Members only';
        $text  = 'You\'re logged in, but you don\'t seem to be in the Paddy\'s Dreamland&trade; Discord server. Join it, then log in again here.';
    } else {
        $title = 'Couldn\'t check your membership';
        $text  = 'Discord didn\'t answer the last membership check. Please log in again.';
    }

    $login = '/auth/login.php?return=' . rawurlencode($here);

    http_response_code(403);
    header('Content-Type: text/html; charset=UTF-8');
    header('Cache-Control: no-store');
    ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Staging · Paddy's Dreamland™</title>
<style>
    :root { color-scheme: dark; }
    body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #0e0f14; color: #e6e6ee;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .card {
        max-width: 420px; margin: 16px; padding: 28px;
        background: #171922; border: 1px solid #2a2d3a; border-radius: 12px;
    }
    h1 { margin: 0 0 12px; font-size: 1.4rem; }
    p  { margin: 0 0 20px; line-height: 1.5; color: #b8bac8; }
    .buttons { display: flex; flex-wrap: wrap; gap: 10px; }
    a.button {
        padding: 10px 16px; border-radius: 8px; text-decoration: none; font-weight: 600;
        background: #5865f2; color: #fff;
    }
    a.button.secondary { background: #2a2d3a; color: #e6e6ee; }
</style>
</head>
<body>
<div class="card">
    <h1><?= $title ?></h1>
    <p><?= $text ?></p>
    <div class="buttons">
        <a class="button" href="<?= htmlspecialchars($login, ENT_QUOTES) ?>">Log in with Discord</a>
        <a class="button secondary" href="https://paddysdreamland.com/discord">Join the server</a>
        <a class="button secondary" href="https://paddysdreamland.com/">Main site</a>
    </div>
</div>
</body>
</html>
<?php
    exit;
}

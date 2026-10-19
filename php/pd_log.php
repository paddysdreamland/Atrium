<?php
const PD_BOMB_ENABLED = true;
define('PD_BOMB_FILE', dirname(__DIR__, 2) . '/10G.gz');

const PD_OFFSITE_FETCH = ['cross-site', 'same-site'];

function pd_log_hit(): void {
    try {
        pd_pdo()->prepare(
            "INSERT INTO pd_access_log (ip, method, uri, user_agent, referer, fetch_site, fetch_mode, status)
             VALUES (?,?,?,?,?,?,?,?)"
        )->execute([
            $_SERVER['REMOTE_ADDR']    ?? '',
            $_SERVER['REQUEST_METHOD'] ?? '',
            substr($_SERVER['REQUEST_URI'] ?? '', 0, 512),
            substr($_SERVER['HTTP_USER_AGENT']    ?? '', 0, 512) ?: null,
            substr($_SERVER['HTTP_REFERER']       ?? '', 0, 512) ?: null,
            substr($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '', 0, 20) ?: null,
            substr($_SERVER['HTTP_SEC_FETCH_MODE'] ?? '', 0, 20) ?: null,
            http_response_code() ?: null,
        ]);
    } catch (Throwable $e) { /* logging must never break the page */ }
}

/**
 * Whether this request comes from a logged-in Founder or Manager. Same database as the
 * Discord login: the pd_session cookie is a random token checked against its stored
 * hash, so it can't be forged. site_roles is only ever filled with PD staff roles.
 */
function pd_is_staff(PDO $pdo): bool {
    static $staff = null;
    if ($staff !== null) return $staff;

    $token = $_COOKIE['pd_session'] ?? '';
    if (!is_string($token) || $token === '') return $staff = false;

    try {
        $stmt = $pdo->prepare(
            "SELECT 1 FROM pd_sessions s
               JOIN pd_users u ON u.discord_id = s.discord_id
              WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.site_roles <> ''
              LIMIT 1");
        $stmt->execute([hash('sha256', $token)]);
        return $staff = (bool) $stmt->fetchColumn();
    } catch (Throwable $e) {
        return $staff = false;
    }
}

function pd_bomb_armed(): bool {
    return PD_BOMB_ENABLED && is_readable(PD_BOMB_FILE);
}

function pd_send_bomb(): void {
    @ini_set('zlib.output_compression', '0');
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    while (ob_get_level() > 0) ob_end_clean();

    header('Content-Encoding: gzip');
    header('Content-Type: text/html; charset=UTF-8');
    header('Content-Length: ' . filesize(PD_BOMB_FILE));
    header('Cache-Control: no-store');

    readfile(PD_BOMB_FILE);
    exit;
}

function pd_guard_degraded(Throwable $e): void {
    try {
        $flag = sys_get_temp_dir() . '/pd_guard_degraded';
        if (!is_file($flag) || (time() - @filemtime($flag)) > 300) {
            @touch($flag);
            pd_notify('🛟 Guard degraded — serving UNGUARDED for now: ' . $e->getMessage());
        }
    } catch (Throwable $ignored) { /* alerting must never break the page */ }
}

function pd_guard(): void {
  try {
    $pdo = pd_pdo();
    $ip  = $_SERVER['REMOTE_ADDR'] ?? '';
    $uri = $_SERVER['REQUEST_URI'] ?? '';

    // Staff are logged but never blocked or auto-banned (also a way back in if their IP was).
    if (pd_is_staff($pdo)) {
        pd_log_hit();
        return;
    }

    $ban = $pdo->prepare(
        "SELECT 1 FROM pd_blocklist
         WHERE ip = ? AND (expires_at IS NULL OR expires_at > NOW())");
    $ban->execute([$ip]);
    if ($ban->fetchColumn()) { http_response_code(403); exit; }

    pd_log_hit();

    $browserRequest = isset($_SERVER['HTTP_SEC_FETCH_SITE']);

    $traps = [
        '/.env',
        '/.aws',
        '/.git',
        '/.dev',
        '/.ssh',
        '/.vscode',
        '/wp-login.php',
        '/wp-content',
        '/wp-includes',
        '/wp-admin',
        '/wp-json',
        '/config.json',
        '/vendor',
        '/admin',
        '/mod',
        '/inputs.php',
        '/confirmedsearchleak',
        '/thisthing',
        '/thatthing',
        '/andthisthing',
        '/andthatthing',
        '/enhancecp',
        '/plugins',
        '/shell.php'
    ];

    foreach ($traps as $t) {
        if (stripos($uri, $t) === false) continue;

        if ($browserRequest) {
            $fs = strtolower($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '');

            if (in_array($fs, PD_OFFSITE_FETCH, true)) {
                $ref = $_SERVER['HTTP_REFERER'] ?? '(referrer hidden)';
                pd_notify("⚠️ Trap weaponization? Victim `$ip` → `$uri` (embedded on `$ref`)");
            }

            http_response_code(404); exit;
        }

        $pdo->prepare(
            "INSERT IGNORE INTO pd_blocklist (ip, reason, expires_at)
             VALUES (?, 'honeypot', NOW() + INTERVAL 7 DAY)")
            ->execute([$ip]);

        if (pd_bomb_armed()) {
            pd_notify("💣 Bombed `$ip` — Hit Trap Path: `$uri`");
            pd_send_bomb();
        }

        pd_notify("🚨 Banned `$ip` — Hit Trap Path: `$uri`");
        http_response_code(403); exit;
    }

  } catch (Throwable $e) {
    pd_guard_degraded($e);
    return;
  }
}
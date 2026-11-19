<?php
require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/pd_log.php';

// Social / external redirect links. Add slug => destination pairs here.
// e.g. https://paddysdreamland.com/discord -> https://discord.gg/paddysdreamland
const PD_LINKS = [
    'discord' => 'https://discord.gg/paddysdreamland',
    'twitch'  => 'https://www.twitch.tv/paddysdreamland',
    'youtube' => 'https://www.youtube.com/@paddysdreamland',
    'tiktok'  => 'https://www.tiktok.com/@paddysdreamland',
    'github'  => 'https://github.com/paddysdreamland',
    'steam'   => 'https://steamcommunity.com/groups/paddysdreamland',
    'x'       => 'https://x.com/paddysdreamland',
];

pd_guard();

$slug = strtolower($_GET['to'] ?? '');
$dest = PD_LINKS[$slug] ?? null;

if ($dest === null) {
    http_response_code(404);
    echo 'Not found';
    exit;
}

// Count the visit. Reuse pd_counter with a per-link name; create the row on
// first hit so new slugs don't need to be seeded manually.
try {
    $pdo  = pd_pdo();
    $name = 'redirect:' . $slug;
    $upd  = $pdo->prepare("UPDATE pd_counter SET hits = hits + 1 WHERE name = ?");
    $upd->execute([$name]);
    if ($upd->rowCount() === 0) {
        $pdo->prepare("INSERT INTO pd_counter (name, hits) VALUES (?, 1)")->execute([$name]);
    }
} catch (Throwable $e) { /* counting must never break the redirect */ }

header('Location: ' . $dest, true, 302);
exit;

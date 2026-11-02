<?php
// php/pd_site_meta.php  —  the main page's titles, descriptions and embed banner, as set in the
// Site Manager (pd_site_admin.php, scripts/pd_site_manage.js) and saved in pd_site_meta.
//
// index.php fills them into pd_main.html on the way out. An empty field (or a database that
// can't be reached) leaves pd_main.html's own text in place, so that's the default.
// "{latest news}" in a text field becomes the header of the newest news post that isn't hidden
// or outdated; while there isn't one, the field falls back to pd_main.html's own as well.
//
// Staging and the main site share the database, so saving on staging changes the main site too.
// pd_main.html's tags have to stay in the form <meta name|property="…" content="…"> to be found.

const PD_SITE_META_URL         = 'https://www.paddysdreamland.com/';   // embeds need full addresses
const PD_SITE_META_LATEST_NEWS = '{latest news}';

// field => [name in messages, max characters, where it goes in pd_main.html]
const PD_SITE_META_FIELDS = [
    'title'            => ['Page title',        100, ['<title>']],
    'description'      => ['Search description', 300, ['description']],
    'embedTitle'       => ['Embed title',       150, ['og:title', 'twitter:title']],
    'embedDescription' => ['Embed description', 300, ['og:description', 'twitter:description']],
    'banner'           => ['Banner',            255, ['og:image', 'twitter:image']],
];

// index.php: the page with the saved values filled in, or as it is if the database is down.
function pd_site_meta_render(string $html): string {
    try {
        $pdo   = pd_pdo();
        $saved = pd_site_meta_saved($pdo);
        $news  = stripos(implode("\n", $saved), PD_SITE_META_LATEST_NEWS) !== false ? pd_site_meta_latest_news($pdo) : null;
        return pd_site_meta_apply($html, $saved, $news);
    } catch (Throwable $e) {
        return $html;
    }
}

// What's saved: field => text. A field that's missing or '' uses pd_main.html's own.
function pd_site_meta_saved(PDO $pdo): array {
    $saved = [];
    foreach ($pdo->query('SELECT meta_key, meta_value FROM pd_site_meta') as $row) {
        if (isset(PD_SITE_META_FIELDS[$row['meta_key']])) {
            $saved[$row['meta_key']] = (string) $row['meta_value'];
        }
    }
    return $saved;
}

// The header of the newest news post that's neither hidden nor outdated, or null.
function pd_site_meta_latest_news(PDO $pdo): ?string {
    $header = $pdo->query(
        'SELECT header FROM pd_newsposts
          WHERE hidden = 0 AND irrelevant = 0
          ORDER BY post_date DESC, created_at DESC
          LIMIT 1'
    )->fetchColumn();
    return $header === false ? null : (string) $header;
}

function pd_site_meta_apply(string $html, array $saved, ?string $latestNews): string {
    foreach (PD_SITE_META_FIELDS as $field => [, , $targets]) {
        $value = pd_site_meta_shown($field, $saved[$field] ?? '', $latestNews);
        if ($value === null) continue;

        $escaped = htmlspecialchars($value, ENT_QUOTES);
        foreach ($targets as $target) {
            $html = preg_replace_callback(pd_site_meta_pattern($target), function (array $m) use ($escaped) {
                return $m[1] . $escaped . $m[3];
            }, $html);
        }
    }
    return $html;
}

// What a field shows: the saved text with {latest news} filled in and the banner as a full
// address, or null for pd_main.html's own.
function pd_site_meta_shown(string $field, string $value, ?string $latestNews): ?string {
    if ($value === '') return null;

    if (stripos($value, PD_SITE_META_LATEST_NEWS) !== false) {
        if ($latestNews === null) return null;
        $value = str_ireplace(PD_SITE_META_LATEST_NEWS, $latestNews, $value);
    }
    return $field === 'banner' ? PD_SITE_META_URL . ltrim($value, '/') : $value;
}

// pd_main.html's own text for each field (the banner as a site path), for the Site Manager.
function pd_site_meta_defaults(string $html): array {
    $defaults = [];
    foreach (PD_SITE_META_FIELDS as $field => [, , $targets]) {
        $value = preg_match(pd_site_meta_pattern($targets[0]), $html, $m) ? html_entity_decode($m[2], ENT_QUOTES | ENT_HTML5) : '';
        if ($field === 'banner' && stripos($value, PD_SITE_META_URL) === 0) {
            $value = substr($value, strlen(PD_SITE_META_URL));
        }
        $defaults[$field] = $value;
    }
    return $defaults;
}

// Finds a target: group 2 is its text, groups 1 and 3 what's around it.
function pd_site_meta_pattern(string $target): string {
    return $target === '<title>'
        ? '~(<title>)([^<]*)(</title>)~i'
        : '~(<meta\s+(?:name|property)="' . preg_quote($target, '~') . '"\s+content=")([^"]*)(")~i';
}

// The main site's folder: this one, or on staging its neighbour (both sit in the home folder).
// Banners have to be there, since Discord & co. always load them from the main site.
function pd_live_root(): string {
    return basename(dirname(__DIR__)) === 'staging_html'
        ? dirname(__DIR__, 2) . '/public_html'
        : dirname(__DIR__);
}

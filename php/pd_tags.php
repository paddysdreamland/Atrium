<?php
// php/pd_tags.php  —  page tags the server resolves before a page goes out.
//
//   <staging-branch>…</staging-branch>   only shown on staging.paddysdreamland.com
//   <release-branch>…</release-branch>   only shown on the main site
//   <temporary from="…" until="…">…</temporary>
//                                        only shown from "from" until "until"; leave either out
//                                        for "until further notice" or "starting now"
//
// Times are anything PHP's DateTime reads, e.g. "2026-12-24", "2026-12-24 18:00" or
// "@1798131600" (a Unix timestamp). Tags can be nested, also inside each other.
//
// Without a timezone, a time is the visitor's own: "2026-12-24 18:00" is 18:00 wherever they
// are. scripts/pd_tags.js tells us their timezone in the pd_tz cookie; until it has, Berlin
// time is used, and the page reloads once with the right one. Add a timezone ("Europe/Berlin",
// "UTC", "+01:00") for a moment that's the same for everyone, like a stream starting.
//
// Stars at the front make it repeat, with both times starred the same way:
//   from="****-12-24" until="****-12-27"              every year over Christmas
//   from="****-**-01" until="****-**-03"              the first two days of every month
//   from="****-**-** 18:00" until="****-**-** 20:00"  every evening
//   from="****-**-** 20:00 Europe/Berlin" until="****-**-** 22:00 Europe/Berlin"
//                                                     every evening in Berlin, at the same
//                                                     moment for everyone
// An "until" before its "from" runs into the next year/month/day (from="****-12-31"
// until="****-01-02" is New Year). A day the month doesn't have becomes its last day, so
// "****-02-29" is the 28th outside leap years.
//
// Content that doesn't apply is cut out here, so it never reaches the browser, not even in
// the page source. A shown <temporary> with an end time goes out as <pd-temporary>, which
// scripts/pd_tags.js removes when the time runs out on a page that's still open. Start times
// are only checked when the page loads.
//
// On staging, ?now=2026-12-24T18:00 shows the page as it will look at that time, and
// ?tz=America/New_York as it looks in another timezone. A mistake (an unreadable time or a
// missing closing tag) shows up as a red note on staging, and as an HTML comment on the main site.
//
// Only pages served through PHP get this: index.php (pd_main.html). Static .html pages and
// the toybox don't, so don't use the tags there. News posts and About Us blocks have the same
// rules as "conditional" blocks (pd_blocks.php), using pd_tags_context() and pd_tags_when().
//
// Needs pd_staging.php (for pd_is_staging_host) to be loaded first.

const PD_TAGS_TIMEZONE    = 'Europe/Berlin';   // until the visitor's browser has told us theirs
const PD_TAGS_ZONE_COOKIE = 'pd_tz';           // set by scripts/pd_tags.js

function pd_render_tags(string $html): string {
    $ctx = pd_tags_context();

    $html = pd_tags_resolve($html, 'staging-branch', $ctx['staging'], function (string $attrs, string $inner) use ($ctx) {
        return pd_tags_branch_shows($ctx, 'staging') ? $inner : '';
    });
    $html = pd_tags_resolve($html, 'release-branch', $ctx['staging'], function (string $attrs, string $inner) use ($ctx) {
        return pd_tags_branch_shows($ctx, 'release') ? $inner : '';
    });

    $timed = false; // whether anything depended on the time, so the timezone matters
    $html  = pd_tags_resolve($html, 'temporary', $ctx['staging'], function (string $attrs, string $inner) use ($ctx, &$timed) {
        $timed = true;
        $when  = pd_tags_when($ctx, pd_tags_attr($attrs, 'from'), pd_tags_attr($attrs, 'until'));

        if ($when['problem']) return pd_tags_problem($ctx['staging'], "<temporary> {$when['problem']}, so it's hidden");
        if (!$when['show']) return '';
        return $when['endsIn'] === null
            ? $inner
            : '<pd-temporary data-ends-in="' . $when['endsIn'] . '">' . $inner . '</pd-temporary>';
    });

    // Tell pd_tags.js which timezone this page was made for, so it can reload if that's wrong.
    if ($timed && !$ctx['zonePreview']) {
        $meta = '<meta name="pd-tags-zone" content="' . htmlspecialchars($ctx['zone']->getName(), ENT_QUOTES) . '">';
        $html = preg_replace('~</head>~i', $meta . "\n</head>", $html, 1);
    }

    return $html;
}

// Who's looking, and when: which branch, their timezone, and the time now (a staging preview's
// ?now= and ?tz= included).
function pd_tags_context(): array {
    $staging = pd_is_staging_host();

    // ?tz= is a preview, so the page mustn't ask pd_tags.js to "fix" it with a reload.
    $zone        = null;
    $zonePreview = false;
    if ($staging && isset($_GET['tz']) && is_string($_GET['tz'])) {
        $zone        = pd_tags_zone($_GET['tz']);
        $zonePreview = $zone !== null;
    }
    if (!$zone && isset($_COOKIE[PD_TAGS_ZONE_COOKIE]) && is_string($_COOKIE[PD_TAGS_ZONE_COOKIE])) {
        $zone = pd_tags_zone($_COOKIE[PD_TAGS_ZONE_COOKIE]);
    }
    $zone = $zone ?: new DateTimeZone(PD_TAGS_TIMEZONE);

    $now     = new DateTimeImmutable('now', $zone);
    $preview = false;
    if ($staging && isset($_GET['now']) && is_string($_GET['now'])) {
        $at = pd_tags_parse_time($_GET['now'], $zone);
        if ($at) {
            $now     = $at;
            $preview = true;
        }
    }

    return [
        'staging'     => $staging,
        'zone'        => $zone,
        'zonePreview' => $zonePreview,
        'now'         => $now,
        'preview'     => $preview,
    ];
}

// Whether content for $branch ("staging", "release", or "" for both) shows here.
function pd_tags_branch_shows(array $ctx, string $branch): bool {
    return $branch === '' || ($branch === 'staging') === $ctx['staging'];
}

// Whether content shown from $from until $until (null: not set) shows right now:
//   show     true or false
//   endsIn   seconds until it ends, when it shows and has an end (not for a ?now= preview,
//            which isn't the browser's time, so pd_tags.js mustn't count down from it)
//   problem  why it can't be read, if it can't (it's then hidden, so a typo can't leak a
//            surprise early)
function pd_tags_when(array $ctx, ?string $from, ?string $until): array {
    $problem = pd_tags_times_problem($from, $until);
    if ($problem) return ['show' => false, 'endsIn' => null, 'problem' => $problem];

    $now = $ctx['now'];
    if (strpos($from . $until, '*') !== false) {
        $fromRepeat = pd_tags_parse_repeat($from);

        // The window that's on right now, if any; from then on it's like a one-off.
        $window = pd_tags_repeat_window($fromRepeat, pd_tags_parse_repeat($until), $now->setTimezone($fromRepeat['zone'] ?? $ctx['zone']));
        if (!$window) return ['show' => false, 'endsIn' => null, 'problem' => null];
        [$fromTime, $untilTime] = $window;
    } else {
        $fromTime  = $from === null ? null : pd_tags_parse_time($from, $ctx['zone']);
        $untilTime = $until === null ? null : pd_tags_parse_time($until, $ctx['zone']);
    }

    $show = !($fromTime && $now < $fromTime) && !($untilTime && $now >= $untilTime);
    return [
        'show'    => $show,
        'endsIn'  => ($show && $untilTime && !$ctx['preview']) ? $untilTime->getTimestamp() - $now->getTimestamp() : null,
        'problem' => null,
    ];
}

// What's wrong with these times, phrased to follow "the tag/block …", or null if nothing is.
function pd_tags_times_problem(?string $from, ?string $until): ?string {
    if (strpos($from . $until, '*') !== false) {
        $fromRepeat  = pd_tags_parse_repeat((string) $from);
        $untilRepeat = pd_tags_parse_repeat((string) $until);
        if (!$fromRepeat || !$untilRepeat || $fromRepeat['stars'] !== $untilRepeat['stars']
            || pd_tags_zone_name($fromRepeat['zone']) !== pd_tags_zone_name($untilRepeat['zone'])) {
            return 'only repeats with both times starred the same way (and in the same timezone), like from="****-12-24" until="****-12-27"';
        }
        return null;
    }

    foreach (['from' => $from, 'until' => $until] as $name => $value) {
        if ($value !== null && !pd_tags_parse_time($value, new DateTimeZone(PD_TAGS_TIMEZONE))) {
            return "can't read its $name time";
        }
    }
    return null;
}

// Replace every <$tag …>…</$tag> with what $resolve($attributes, $innerHtml) returns.
// Works from the last opening tag backwards: everything after it is already resolved, so the
// next closing tag is its own, and the opening tags before it haven't moved. An opening tag
// without a closing tag runs to the end of the page, like it would in the browser.
function pd_tags_resolve(string $html, string $tag, bool $staging, callable $resolve): string {
    preg_match_all('~<' . $tag . '(?=[\s/>])([^>]*)>~i', $html, $opens, PREG_OFFSET_CAPTURE | PREG_SET_ORDER);

    foreach (array_reverse($opens) as $open) {
        [$openTag, $start] = $open[0];
        $innerStart = $start + strlen($openTag);

        $close = stripos($html, "</$tag>", $innerStart);
        $note  = '';
        if ($close === false) {
            $close       = strlen($html);
            $closeLength = 0;
            $note        = pd_tags_problem($staging, "<$tag> is never closed, so it runs to the end of the page");
        } else {
            $closeLength = strlen("</$tag>");
        }

        $inner = substr($html, $innerStart, $close - $innerStart);
        $html  = substr($html, 0, $start) . $note . $resolve($open[1][0], $inner) . substr($html, $close + $closeLength);
    }

    return $html;
}

// The value of attribute $name, or null if it isn't there.
function pd_tags_attr(string $attrs, string $name): ?string {
    if (!preg_match('~(?<![\w-])' . $name . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'>]+))~i', $attrs, $match)) {
        return null;
    }
    return ($match[1] ?? '') . ($match[2] ?? '') . ($match[3] ?? '');
}

function pd_tags_parse_time(string $value, DateTimeZone $zone): ?DateTimeImmutable {
    $value = trim($value);
    if ($value === '') return null;
    try {
        return new DateTimeImmutable($value, $zone);
    } catch (Exception $e) {
        return null;
    }
}

// A timezone by name ("Europe/Berlin", also older names browsers still use like
// "Asia/Calcutta"), or null if there's no such zone.
function pd_tags_zone(string $name): ?DateTimeZone {
    if (strlen($name) > 64 || !in_array($name, DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC), true)) {
        return null;
    }
    return new DateTimeZone($name);
}

function pd_tags_zone_name(?DateTimeZone $zone): ?string {
    return $zone ? $zone->getName() : null;
}

// A repeating time like "****-12-24" or "****-**-** 18:00 Europe/Berlin": how many fields are
// starred (1 = every year, 2 = every month, 3 = every day), the fixed rest, and its timezone
// (null for the visitor's own). Null if it isn't one, including stars after a fixed field
// ("2026-**-01").
function pd_tags_parse_repeat(string $value): ?array {
    if (!preg_match('~^(\d{4}|\*{4})-(\d{2}|\*{2})-(\d{2}|\*{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\s+([A-Za-z][\w/+-]*)|\s*(Z|[+-]\d{2}:?\d{2}))?$~', trim($value), $m)) {
        return null;
    }

    $fields = [$m[1], $m[2], $m[3]];
    $stars  = 0;
    while ($stars < 3 && $fields[$stars][0] === '*') $stars++;
    for ($i = $stars; $i < 3; $i++) {
        if ($fields[$i][0] === '*') return null;
    }

    $zone = null;
    if (($m[7] ?? '') !== '') {
        $zone = pd_tags_zone($m[7]);
        if (!$zone) return null;
    } elseif (($m[8] ?? '') !== '') {
        $zone = new DateTimeZone($m[8] === 'Z' ? 'UTC' : $m[8]);
    }

    $repeat = [
        'stars'  => $stars,
        'month'  => (int) $fields[1],
        'day'    => (int) $fields[2],
        'hour'   => (int) ($m[4] ?? 0),
        'minute' => (int) ($m[5] ?? 0),
        'second' => (int) ($m[6] ?? 0),
        'zone'   => $zone,
    ];
    $valid = $stars > 0
        && ($stars >= 2 || ($repeat['month'] >= 1 && $repeat['month'] <= 12))
        && ($stars >= 3 || ($repeat['day'] >= 1 && $repeat['day'] <= 31))
        && $repeat['hour'] <= 23 && $repeat['minute'] <= 59 && $repeat['second'] <= 59;
    return $valid ? $repeat : null;
}

// Where $repeat falls in the year/month/day that starts at $period.
function pd_tags_repeat_at(array $repeat, DateTimeImmutable $period): DateTimeImmutable {
    $year  = (int) $period->format('Y');
    $month = $repeat['stars'] >= 2 ? (int) $period->format('n') : $repeat['month'];
    $day   = $repeat['stars'] >= 3 ? (int) $period->format('j') : $repeat['day'];

    $lastDay = (int) $period->setDate($year, $month, 1)->format('t');
    return $period->setDate($year, $month, min($day, $lastDay))
                  ->setTime($repeat['hour'], $repeat['minute'], $repeat['second']);
}

// [start, end] of the repeat that $now is inside, or null if it's between two. Years, months
// and days are counted in $now's timezone. A window is at most one year/month/day long, so it
// started in this one or the one before.
function pd_tags_repeat_window(array $from, array $until, DateTimeImmutable $now): ?array {
    $unit   = ['', 'year', 'month', 'day'][$from['stars']];
    $period = $now->setTime(0, 0);
    if ($unit !== 'day')  $period = $period->setDate((int) $now->format('Y'), (int) $now->format('n'), 1);
    if ($unit === 'year') $period = $period->setDate((int) $now->format('Y'), 1, 1);

    foreach ([$period->modify("-1 $unit"), $period] as $start) {
        $windowStart = pd_tags_repeat_at($from, $start);
        $windowEnd   = pd_tags_repeat_at($until, $start);
        if ($windowEnd <= $windowStart) $windowEnd = pd_tags_repeat_at($until, $start->modify("+1 $unit"));

        if ($now >= $windowStart && $now < $windowEnd) return [$windowStart, $windowEnd];
    }
    return null;
}

function pd_tags_problem(bool $staging, string $message): string {
    $message = htmlspecialchars($message, ENT_QUOTES);
    return $staging
        ? '<pd-tag-error>' . $message . '</pd-tag-error>'
        : '<!-- pd_tags: ' . $message . ' -->';
}

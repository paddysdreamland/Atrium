<?php
declare(strict_types=1);

// php/pd_blocks.php  —  validation for the content blocks news posts and About Us blocks are
// built from (rendered by renderBlocks() in scripts/pd_post_manager.js), and what of them a
// visitor gets to see. Included by the admin endpoints and the public ones; does nothing on its own.
//
// A "conditional" block holds other blocks, only shown on one branch and/or between two times,
// with the same rules as the page tags in pd_tags.php: {type, branch?, from?, until?, blocks}.

require_once __DIR__ . '/pd_tags.php';

/**
 * A relative path to a file on this site with one of the given extensions (regex alternation).
 * No scheme, host, "..", or "//", so it can't point off-site or climb out of the web root.
 */
function pd_blocks_valid_path(string $src, string $extensions): bool {
    return (bool) preg_match('#^/?[A-Za-z0-9_\-./%]+\.(?:' . $extensions . ')$#i', $src)
        && strpos($src, '..') === false
        && strpos($src, '//') === false;
}

/**
 * Whether a (valid) site path points at a real file. Content must never reference missing
 * files: each one is a broken image or sound, and a 404, on every page view.
 *
 * Staging (/staging_html) doesn't have the live site's files, such as the uploads made there,
 * so it accepts missing files rather than refusing posts it can't see the images of. It shares
 * the live database, though: a mistyped path saved on staging is a broken image on live too.
 */
function pd_blocks_file_exists(string $src): bool {
    $decoded = rawurldecode($src);
    if (strpos($decoded, '..') !== false) {
        return false;
    }
    return basename(dirname(__DIR__)) === 'staging_html'
        || is_file(dirname(__DIR__) . '/' . ltrim($decoded, '/'));
}

/** Validate an editor's block list and return it JSON-encoded for the DB, or respond 422 and exit. */
function pd_blocks_clean($blocksIn): string {
    if (!is_array($blocksIn) || count($blocksIn) === 0) {
        pd_json_error(422, 'invalid', 'Add between 1 and 50 blocks.');
    }
    $total  = 0;
    $blocks = pd_blocks_clean_list($blocksIn, '', $total);
    if ($total > 50) {
        pd_json_error(422, 'invalid', 'Add between 1 and 50 blocks (blocks inside conditional blocks count too).');
    }

    return json_encode($blocks, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * Validate a list of blocks; $prefix numbers the ones inside a conditional block ("Block 3.2")
 * and is "" at the top. Conditional blocks don't go inside each other. $total counts every block.
 */
function pd_blocks_clean_list(array $blocksIn, string $prefix, int &$total): array {
    $blocks = [];
    foreach (array_values($blocksIn) as $i => $block) {
        $n    = $prefix . ($i + 1);
        $type = is_array($block) ? ($block['type'] ?? '') : '';
        if (++$total > 50) {
            return $blocks; // pd_blocks_clean reports it; no need to check the rest
        }

        if ($type === 'paragraph') {
            $content = pd_sanitize_html((string) ($block['content'] ?? ''));
            if ($content === '') {
                pd_json_error(422, 'invalid', "Block {$n}: paragraph is empty.");
            }
            $blocks[] = ['type' => 'paragraph', 'content' => $content];
        } elseif ($type === 'heading') {
            // Rendered with textContent, so plain text is stored as-is.
            $content = trim((string) ($block['content'] ?? ''));
            if ($content === '' || strlen($content) > 255) {
                pd_json_error(422, 'invalid', "Block {$n}: heading is required (max 255 characters).");
            }
            $blocks[] = ['type' => 'heading', 'content' => $content];
        } elseif ($type === 'bulletList') {
            $items = [];
            foreach ((array) ($block['content'] ?? []) as $item) {
                $item = pd_sanitize_html((string) $item);
                if ($item !== '') {
                    $items[] = $item;
                }
            }
            if (!$items) {
                pd_json_error(422, 'invalid', "Block {$n}: bullet list is empty.");
            }
            $blocks[] = ['type' => 'bulletList', 'content' => $items];
        } elseif ($type === 'audio') {
            // Only MP3s hosted on this site (the renderer hard-codes audio/mpeg).
            $src = trim((string) ($block['src'] ?? ''));
            if (!pd_blocks_valid_path($src, 'mp3')) {
                pd_json_error(422, 'invalid', "Block {$n}: audio must be an .mp3 path on this site.");
            }
            if (!pd_blocks_file_exists($src)) {
                pd_json_error(422, 'invalid', "Block {$n}: \"{$src}\" does not exist on the site.");
            }
            $blocks[] = ['type' => 'audio', 'src' => $src];
        } elseif ($type === 'gallery') {
            // Images hosted on this site; captions are rendered as plain text (textContent/alt).
            $images = [];
            foreach ((array) ($block['images'] ?? []) as $image) {
                $src     = trim((string) (is_array($image) ? ($image['src'] ?? '') : ''));
                $caption = trim((string) (is_array($image) ? ($image['caption'] ?? '') : ''));
                if (!pd_blocks_valid_path($src, 'png|jpe?g|gif|webp')) {
                    pd_json_error(422, 'invalid', "Block {$n}: gallery images must be .png, .jpg, .gif or .webp paths on this site.");
                }
                if (!pd_blocks_file_exists($src)) {
                    pd_json_error(422, 'invalid', "Block {$n}: \"{$src}\" does not exist on the site.");
                }
                if (strlen($caption) > 255) {
                    pd_json_error(422, 'invalid', "Block {$n}: captions are limited to 255 characters.");
                }
                $images[] = $caption === '' ? ['src' => $src] : ['src' => $src, 'caption' => $caption];
            }
            if (!$images || count($images) > 50) {
                pd_json_error(422, 'invalid', "Block {$n}: a gallery needs between 1 and 50 images.");
            }
            $blocks[] = ['type' => 'gallery', 'images' => $images];
        } elseif ($type === 'conditional' && $prefix === '') {
            $branch = (string) ($block['branch'] ?? '');
            if (!in_array($branch, ['', 'staging', 'release'], true)) {
                pd_json_error(422, 'invalid', "Block {$n}: unknown branch.");
            }
            $times = [];
            foreach (['from', 'until'] as $name) {
                $value = trim((string) ($block[$name] ?? ''));
                if (strlen($value) > 64) {
                    pd_json_error(422, 'invalid', "Block {$n}: the {$name} time is limited to 64 characters.");
                }
                $times[$name] = $value === '' ? null : $value;
            }
            if ($branch === '' && $times['from'] === null && $times['until'] === null) {
                pd_json_error(422, 'invalid', "Block {$n}: pick a branch, a from time or an until time, or it's not conditional.");
            }
            $problem = pd_tags_times_problem($times['from'], $times['until']);
            if ($problem !== null) {
                pd_json_error(422, 'invalid', "Block {$n}: this conditional block {$problem}.");
            }

            $inner = $block['blocks'] ?? null;
            if (!is_array($inner) || count($inner) === 0) {
                pd_json_error(422, 'invalid', "Block {$n}: add at least one block inside.");
            }

            // Only the settings in use, so the stored block reads like what it does.
            $clean = ['type' => 'conditional'];
            if ($branch !== '') $clean['branch'] = $branch;
            if ($times['from'] !== null) $clean['from'] = $times['from'];
            if ($times['until'] !== null) $clean['until'] = $times['until'];
            $clean['blocks'] = pd_blocks_clean_list($inner, "{$n}.", $total);
            $blocks[] = $clean;
        } elseif ($type === 'conditional') {
            pd_json_error(422, 'invalid', "Block {$n}: conditional blocks can't go inside each other.");
        } else {
            pd_json_error(422, 'invalid', "Block {$n}: unknown block type.");
        }
    }

    return $blocks;
}

/**
 * The blocks as a visitor sees them right now ($ctx from pd_tags_context()). A conditional block
 * that applies goes out with only its blocks, plus endsIn (seconds) when it ends later, so
 * renderBlocks() can take it down on a page that's still open. One that doesn't apply is left
 * out, so it never reaches the browser.
 */
function pd_blocks_for_visitor(array $blocks, array $ctx): array {
    $visible = [];
    foreach ($blocks as $block) {
        if (($block['type'] ?? '') !== 'conditional') {
            $visible[] = $block;
            continue;
        }

        if (!pd_tags_branch_shows($ctx, (string) ($block['branch'] ?? ''))) {
            continue;
        }
        $when = pd_tags_when($ctx, $block['from'] ?? null, $block['until'] ?? null);
        if (!$when['show']) {
            continue;
        }

        $shown = ['type' => 'conditional', 'blocks' => $block['blocks'] ?? []];
        if ($when['endsIn'] !== null) {
            $shown['endsIn'] = $when['endsIn'];
        }
        $visible[] = $shown;
    }
    return $visible;
}

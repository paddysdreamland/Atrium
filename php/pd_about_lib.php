<?php
declare(strict_types=1);

// php/pd_about_lib.php  —  About Us helpers shared by pd_about.php and pd_about_admin.php.
// Needs pd_lib.php (PD_GUILD_ROLES) loaded first.

/** The card's tag: the highest PD role in a site_roles snapshot ("founder,moderator" -> "Founder"). */
function pd_about_role(?string $siteRoles): ?string {
    $held = explode(',', (string) $siteRoles);
    foreach (array_keys(PD_GUILD_ROLES) as $role) { // highest first
        if (in_array($role, $held, true)) {
            return ucfirst($role);
        }
    }
    return null;
}

/**
 * Every flag a card may show, as name => site path: images/flags/<code>.png and
 * images/flags/pride/<name>.(png|svg), e.g. "de" => "images/flags/de.png".
 */
function pd_about_flag_options(): array {
    $root    = dirname(__DIR__);
    $options = [];
    $files   = array_merge(
        glob($root . '/images/flags/*.png') ?: [],
        glob($root . '/images/flags/pride/*.png') ?: [],
        glob($root . '/images/flags/pride/*.svg') ?: []
    );
    foreach ($files as $file) {
        $path = substr($file, strlen($root) + 1);
        $name = preg_replace('#^images/flags/|\.(png|svg)$#', '', $path);
        if ($name !== 'template') {
            $options[$name] = $path;
        }
    }
    return $options;
}

/** A stored flags column -> its list of paths. */
function pd_about_flags(?string $json): array {
    $flags = json_decode((string) $json, true);
    return is_array($flags) ? $flags : [];
}

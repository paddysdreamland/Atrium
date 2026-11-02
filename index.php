<?php
require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/php/pd_log.php';
require __DIR__ . '/php/pd_staging.php';
require __DIR__ . '/php/pd_tags.php';
require __DIR__ . '/php/pd_site_meta.php';

pd_guard();
pd_staging_gate();   // does nothing on the main site; members-only on staging
$html = pd_render_tags(file_get_contents(__DIR__ . '/pd_main.html'));   // <staging-branch>, <temporary>, …
echo pd_site_meta_render($html);                                      // the Site Manager's titles, descriptions and banner

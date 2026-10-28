<?php
require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/php/pd_log.php';
require __DIR__ . '/php/pd_staging.php';
require __DIR__ . '/php/pd_tags.php';

pd_guard();
pd_staging_gate();   // does nothing on the main site; members-only on staging
echo pd_render_tags(file_get_contents(__DIR__ . '/pd_main.html'));   // <staging-branch>, <temporary>, …

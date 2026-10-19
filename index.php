<?php
require '/home/paddnols/private/pd_mon_config.php';
require __DIR__ . '/php/pd_log.php';
require __DIR__ . '/php/pd_staging.php';

pd_guard();
pd_staging_gate();   // does nothing on the main site; members-only on staging
readfile(__DIR__ . '/pd_main.html');

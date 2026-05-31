=== RivisoSEO ===
Contributors: riviso
Tags: rest-api, yoast, seo, application-passwords, riviso
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.6.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

RivisoSEO connector for WordPress. Automatically maps SEO metadata to Yoast SEO or Rank Math.

== Installation ==

1. Download the plugin ZIP from Riviso Project Settings.
2. WordPress → Plugins → Add New → Upload Plugin → Install → Activate **RivisoSEO**.

== File layout ==

    wp-content/plugins/riviso-content-operations/
        riviso-content-operations.php   ← WordPress bootstrap (Plugin Name header)
        includes/connector.php
        plugin.php                        ← legacy loader only
        index.php
        uninstall.php

The ZIP contains exactly one top-level folder: `riviso-content-operations/`.

== After activation ==

Open **ReviSo Settings** in the WordPress admin sidebar for connection details.

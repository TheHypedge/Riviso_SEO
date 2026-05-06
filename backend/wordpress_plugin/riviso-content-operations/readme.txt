=== Riviso - Content Operations ===
Contributors: riviso
Tags: rest-api, yoast, seo, application-passwords
Requires at least: 5.8
Tested up to: 6.8
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Enables required REST capabilities for Riviso content operations:

- Expose Yoast meta fields in REST (`show_in_rest`).
- Provide an authenticated REST ping endpoint for connection testing.

== Installation ==

1. Download the plugin ZIP from Riviso.
2. In WordPress Admin → Plugins → Add New → Upload Plugin → select ZIP → Install → Activate.

== Authentication ==

Use WordPress Application Passwords:

- Users → Profile → Application Passwords → create a password
- Use HTTP Basic Auth against `wp-json/*` endpoints

== REST Endpoints ==

- GET `/wp-json/riviso/v1/ping` (requires auth)


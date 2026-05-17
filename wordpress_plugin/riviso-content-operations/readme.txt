=== Riviso Content Operations ===
Contributors: riviso
Tags: rest-api, yoast, seo, application-passwords, riviso
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connector for Riviso content operations:

- Expose Yoast meta fields in REST (`show_in_rest`).
- Authenticated `/ping` endpoint for connection verification.
- Authenticated `/publish` endpoint for reliable post creation (avoids WAF blocks on wp/v2/posts).

== Installation ==

1. In Riviso, open Project Settings and click **Download plugin**.
2. In WordPress: **Plugins → Add New → Upload Plugin**.
3. Choose `riviso-content-operations.zip`, click **Install Now**, then **Activate**.

== Authentication ==

Use WordPress Application Passwords:

- Users → Profile → Application Passwords → create a password
- Use HTTP Basic Auth against `wp-json/*` endpoints

== REST Endpoints ==

- GET `/wp-json/riviso/v1/ping` (requires auth)
- POST `/wp-json/riviso/v1/publish` (requires `publish_posts`)

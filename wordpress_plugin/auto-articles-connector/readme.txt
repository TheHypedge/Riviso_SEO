=== RivisoSEO ===
Contributors: riviso
Tags: rest-api, yoast, seo, application-passwords, riviso
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.3.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

RivisoSEO connector for WordPress:

- Expose Yoast meta fields in REST (`show_in_rest`).
- Authenticated `/ping` endpoint for connection verification.
- Authenticated `/publish` and `/update` endpoints for reliable post sync.

== Installation ==

1. In Riviso, open Project Settings and click **Download plugin**.
2. In WordPress: **Plugins → Add New → Upload Plugin**.
3. Choose `riviso-content-operations.zip`, click **Install Now**, then **Activate**.

The plugin appears in the list as **RivisoSEO**.

The ZIP must extract to `wp-content/plugins/riviso-content-operations/riviso-content-operations.php`.

== Upgrading from Auto Articles Connector ==

1. Deactivate the old connector plugin.
2. Upload and activate **RivisoSEO** from the Riviso download.
3. Re-verify the WordPress connection in Riviso Project Settings.

== Authentication ==

Use WordPress Application Passwords:

- Users → Profile → Application Passwords → create a password
- Use HTTP Basic Auth against `wp-json/*` endpoints

== REST Endpoints ==

- GET `/wp-json/riviso/v1/ping` (requires auth)
- POST `/wp-json/riviso/v1/publish` (requires `publish_posts`)
- POST `/wp-json/riviso/v1/update` (requires `edit_posts`)

Legacy namespace (same handlers):

- `/wp-json/auto-articles/v1/*`

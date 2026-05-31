<?php
/**
 * Plugin Name: RivisoSEO
 * Plugin URI: https://riviso.com
 * Description: Connect WordPress to Riviso for SEO meta in REST, publish/update endpoints, and connection verification.
 * Version: 0.6.2
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author: Riviso
 * Author URI: https://riviso.com
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: riviso-content-operations
 *
 * @package RivisoContentOperations
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

define( 'RIVISO_PLUGIN_FILE', __FILE__ );
define( 'RIVISO_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

require_once RIVISO_PLUGIN_DIR . 'includes/connector.php';

register_activation_hook( __FILE__, array( 'RivisoContentOperationsConnector', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'RivisoContentOperationsConnector', 'deactivate' ) );

add_action( 'admin_menu', 'riviso_plugin_menu' );

/**
 * Register the ReviSo Settings admin page.
 */
function riviso_plugin_menu() {
	add_menu_page(
		__( 'ReviSo Settings', 'riviso-content-operations' ),
		__( 'ReviSo Settings', 'riviso-content-operations' ),
		'manage_options',
		'riviso-settings',
		'riviso_render_settings_page',
		'dashicons-admin-links',
		81
	);
}

/**
 * Render the ReviSo Settings dashboard page.
 */
function riviso_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$connector_id = RivisoContentOperationsConnector::connector_id();
	$ping_url     = home_url( '/wp-json/riviso/v1/ping' );
	$seo_platform = RivisoContentOperationsConnector::get_active_seo_platform();
	$seo_labels   = array(
		'rank_math' => __( 'Rank Math SEO', 'riviso-content-operations' ),
		'yoast'     => __( 'Yoast SEO', 'riviso-content-operations' ),
		'none'      => __( 'None (Riviso fallback meta)', 'riviso-content-operations' ),
	);
	$seo_label    = isset( $seo_labels[ $seo_platform ] ) ? $seo_labels[ $seo_platform ] : esc_html( $seo_platform );
	?>
	<div class="wrap">
		<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
		<p><?php esc_html_e( 'RivisoSEO connects this WordPress site to Riviso for publishing, SEO meta sync, and connection verification.', 'riviso-content-operations' ); ?></p>
		<table class="widefat striped" style="max-width:720px;">
			<tbody>
				<tr>
					<th scope="row"><?php esc_html_e( 'Plugin version', 'riviso-content-operations' ); ?></th>
					<td><code><?php echo esc_html( RivisoContentOperationsConnector::VERSION ); ?></code></td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Site URL', 'riviso-content-operations' ); ?></th>
					<td><code><?php echo esc_html( get_site_url() ); ?></code></td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Connector ID', 'riviso-content-operations' ); ?></th>
					<td><code><?php echo esc_html( $connector_id ); ?></code></td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'REST ping endpoint', 'riviso-content-operations' ); ?></th>
					<td><a href="<?php echo esc_url( $ping_url ); ?>" target="_blank" rel="noopener"><code><?php echo esc_html( $ping_url ); ?></code></a></td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'SEO platform', 'riviso-content-operations' ); ?></th>
					<td><?php echo esc_html( $seo_label ); ?></td>
				</tr>
			</tbody>
		</table>
		<p style="margin-top:1.5em;">
			<a class="button button-primary" href="https://riviso.com" target="_blank" rel="noopener"><?php esc_html_e( 'Open Riviso', 'riviso-content-operations' ); ?></a>
		</p>
	</div>
	<?php
}

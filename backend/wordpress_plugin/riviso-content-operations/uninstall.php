<?php
/**
 * Uninstall RivisoSEO.
 *
 * @package RivisoContentOperations
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	die;
}

delete_option( 'riviso_content_ops_connector_id' );
delete_option( 'auto_articles_connector_id' );
delete_option( 'riviso_indexnow_key' );
delete_option( 'riviso_update_token' );
delete_site_transient( 'riviso_release' );

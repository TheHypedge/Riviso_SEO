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

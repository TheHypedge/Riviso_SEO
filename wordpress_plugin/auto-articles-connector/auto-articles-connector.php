<?php
/**
 * Plugin Name: RivisoSEO
 * Plugin URI: https://riviso.com
 * Description: RivisoSEO WordPress connector - Yoast meta in REST, connection ping, publish, and update endpoints.
 * Version: 0.3.1
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author: Riviso
 * Author URI: https://riviso.com
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: riviso-content-operations
 *
 * Legacy install path: wp-content/plugins/auto-articles-connector/
 *
 * @package RivisoContentOperations
 */

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/plugin.php';

register_activation_hook(__FILE__, array('RivisoContentOperationsConnector', 'activate'));

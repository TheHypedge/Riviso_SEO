<?php
/**
 * Plugin Name: Riviso - Content Operations
 * Description: Enables required REST capabilities (Yoast meta fields + authenticated ping) for Riviso content operations.
 * Version: 0.1.0
 * Author: Riviso
 * License: GPLv2 or later
 */

if (!defined('ABSPATH')) {
    exit;
}

final class RivisoContentOperationsConnector {
    const REST_NAMESPACE = 'riviso/v1';
    const OPTION_CONNECTOR_ID = 'riviso_content_ops_connector_id';

    public static function init() {
        add_action('init', [__CLASS__, 'register_yoast_meta_rest_support']);
        add_action('rest_api_init', [__CLASS__, 'register_rest_routes']);
    }

    public static function activate() {
        if (!get_option(self::OPTION_CONNECTOR_ID)) {
            $id = function_exists('wp_generate_uuid4') ? wp_generate_uuid4() : bin2hex(random_bytes(16));
            add_option(self::OPTION_CONNECTOR_ID, $id, '', false);
        }
    }

    public static function register_yoast_meta_rest_support() {
        $post_types = apply_filters('riviso_content_ops_post_types', [
            'post',
            'page',
        ]);

        $yoast_fields = apply_filters('riviso_content_ops_yoast_fields', [
            '_yoast_wpseo_title',
            '_yoast_wpseo_metadesc',
            '_yoast_wpseo_focuskw',
            '_yoast_wpseo_canonical',
            '_yoast_wpseo_opengraph-title',
            '_yoast_wpseo_opengraph-description',
            '_yoast_wpseo_twitter-title',
            '_yoast_wpseo_twitter-description',
        ]);

        foreach ((array)$post_types as $post_type) {
            foreach ((array)$yoast_fields as $field) {
                register_post_meta($post_type, $field, [
                    'show_in_rest' => true,
                    'single' => true,
                    'type' => 'string',
                    'auth_callback' => function () {
                        return current_user_can('edit_posts');
                    },
                ]);
            }
        }
    }

    public static function register_rest_routes() {
        register_rest_route(self::REST_NAMESPACE, '/ping', [
            'methods' => 'GET',
            'permission_callback' => function () {
                return current_user_can('edit_posts');
            },
            'callback' => function (WP_REST_Request $request) {
                return new WP_REST_Response([
                    'ok' => true,
                    'plugin' => 'riviso-content-operations',
                    'version' => '0.1.0',
                    'connector_id' => (string) get_option(RivisoContentOperationsConnector::OPTION_CONNECTOR_ID, ''),
                    'site_url' => get_site_url(),
                    'wp_version' => get_bloginfo('version'),
                    'yoast_active' => defined('WPSEO_VERSION'),
                    'rest_meta_fields' => apply_filters('riviso_content_ops_yoast_fields', [
                        '_yoast_wpseo_title',
                        '_yoast_wpseo_metadesc',
                        '_yoast_wpseo_focuskw',
                        '_yoast_wpseo_canonical',
                        '_yoast_wpseo_opengraph-title',
                        '_yoast_wpseo_opengraph-description',
                        '_yoast_wpseo_twitter-title',
                        '_yoast_wpseo_twitter-description',
                    ]),
                ], 200);
            },
        ]);
    }
}

RivisoContentOperationsConnector::init();
register_activation_hook(__FILE__, ['RivisoContentOperationsConnector', 'activate']);


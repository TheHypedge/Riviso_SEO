<?php
/**
 * Plugin Name: Auto Articles Connector
 * Description: Enables required REST capabilities (Yoast meta fields + authenticated ping) for the Auto Articles tool.
 * Version: 0.1.0
 * Author: Auto Articles
 * License: GPLv2 or later
 */

if (!defined('ABSPATH')) {
    exit;
}

final class AutoArticlesConnector {
    const REST_NAMESPACE = 'auto-articles/v1';

    public static function init() {
        add_action('init', [__CLASS__, 'register_yoast_meta_rest_support']);
        add_action('rest_api_init', [__CLASS__, 'register_rest_routes']);
    }

    /**
     * Expose Yoast SEO meta fields in the WordPress REST API.
     *
     * This allows external tools to read/write fields like:
     * - _yoast_wpseo_title
     * - _yoast_wpseo_metadesc
     * - _yoast_wpseo_focuskw
     *
     * Note: Yoast must still be installed/active for these to be meaningful.
     */
    public static function register_yoast_meta_rest_support() {
        $post_types = apply_filters('auto_articles_connector_post_types', [
            'post',
            'page',
            'articles',
            'news',
            'subjects',
            'bare-acts',
            'judgements',
        ]);

        $yoast_fields = apply_filters('auto_articles_connector_yoast_fields', [
            '_yoast_wpseo_title',
            '_yoast_wpseo_metadesc',
            '_yoast_wpseo_focuskw',
        ]);

        foreach ((array)$post_types as $post_type) {
            foreach ((array)$yoast_fields as $field) {
                register_post_meta($post_type, $field, [
                    'show_in_rest' => true,
                    'single' => true,
                    'type' => 'string',
                    'auth_callback' => function () {
                        // Restrict write/read of meta over REST to authenticated users who can edit posts.
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
                // For now we require standard WP REST authentication.
                // The Auto Articles tool can use WordPress Application Passwords.
                return current_user_can('edit_posts');
            },
            'callback' => function (WP_REST_Request $request) {
                return new WP_REST_Response([
                    'ok' => true,
                    'plugin' => 'auto-articles-connector',
                    'version' => '0.1.0',
                    'site_url' => get_site_url(),
                    'wp_version' => get_bloginfo('version'),
                    'yoast_active' => defined('WPSEO_VERSION'),
                ], 200);
            },
        ]);
    }
}

AutoArticlesConnector::init();


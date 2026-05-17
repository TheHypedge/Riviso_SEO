<?php
/**
 * Plugin Name: Riviso
 * Description: Enables required REST capabilities (Yoast meta fields + authenticated ping) for the Auto Articles tool.
 * Version: 0.1.0
 * Author: Riviso
 * License: GPLv2 or later
 */

if (!defined('ABSPATH')) {
    exit;
}

final class AutoArticlesConnector {
    const REST_NAMESPACE = 'auto-articles/v1';
    const OPTION_CONNECTOR_ID = 'auto_articles_connector_id';

    public static function init() {
        add_action('init', [__CLASS__, 'register_yoast_meta_rest_support']);
        add_action('rest_api_init', [__CLASS__, 'register_rest_routes']);
    }

    public static function activate() {
        if (!get_option(self::OPTION_CONNECTOR_ID)) {
            // Unique ID to confirm plugin presence across verifications.
            $id = function_exists('wp_generate_uuid4') ? wp_generate_uuid4() : bin2hex(random_bytes(16));
            add_option(self::OPTION_CONNECTOR_ID, $id, '', false);
        }
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

        // Common Yoast meta keys used by many sites. You can extend via filter.
        $yoast_fields = apply_filters('auto_articles_connector_yoast_fields', [
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
                        // Restrict write/read of meta over REST to authenticated users who can edit posts.
                        return current_user_can('edit_posts');
                    },
                ]);
            }
        }
    }

    private static function normalize_post_type($raw) {
        $t = sanitize_key(is_string($raw) ? $raw : 'post');
        if ($t === 'posts') {
            $t = 'post';
        }
        return $t ?: 'post';
    }

    public static function register_rest_routes() {
        register_rest_route(self::REST_NAMESPACE, '/publish', [
            'methods' => 'POST',
            'permission_callback' => function () {
                return current_user_can('publish_posts');
            },
            'callback' => function (WP_REST_Request $request) {
                $params = $request->get_json_params();
                if (!is_array($params)) {
                    return new WP_Error('riviso_invalid', 'Invalid JSON body', ['status' => 400]);
                }

                if (!empty($params['validate_only'])) {
                    return new WP_REST_Response([
                        'ok' => true,
                        'can_publish' => current_user_can('publish_posts'),
                    ], 200);
                }

                $post_type = self::normalize_post_type($params['post_type'] ?? 'post');
                $title = sanitize_text_field($params['title'] ?? '');
                $content = isset($params['content']) ? wp_kses_post((string) $params['content']) : '';
                $status = sanitize_key($params['status'] ?? 'draft');
                if (!in_array($status, ['publish', 'draft', 'pending', 'future', 'private'], true)) {
                    $status = 'draft';
                }

                $postarr = [
                    'post_title' => $title,
                    'post_content' => $content,
                    'post_status' => $status,
                    'post_type' => $post_type,
                ];

                if (!empty($params['categories']) && is_array($params['categories'])) {
                    $cats = array_filter(array_map('intval', $params['categories']));
                    if ($cats) {
                        $postarr['post_category'] = $cats;
                    }
                }

                $post_id = wp_insert_post($postarr, true);
                if (is_wp_error($post_id)) {
                    return new WP_Error(
                        'riviso_publish_failed',
                        $post_id->get_error_message(),
                        ['status' => 500]
                    );
                }

                $post_id = (int) $post_id;

                if (!empty($params['featured_media']) && is_numeric($params['featured_media'])) {
                    set_post_thumbnail($post_id, (int) $params['featured_media']);
                }

                if (!empty($params['meta']) && is_array($params['meta'])) {
                    foreach ($params['meta'] as $key => $val) {
                        if (!is_string($key) || $key === '') {
                            continue;
                        }
                        update_post_meta($post_id, $key, sanitize_text_field((string) $val));
                    }
                }

                return new WP_REST_Response([
                    'id' => $post_id,
                    'link' => get_permalink($post_id),
                    'status' => get_post_status($post_id),
                ], 201);
            },
        ]);

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
                    'plugin' => 'riviso',
                    'version' => '0.1.0',
                    'connector_id' => (string) get_option(AutoArticlesConnector::OPTION_CONNECTOR_ID, ''),
                    'site_url' => get_site_url(),
                    'wp_version' => get_bloginfo('version'),
                    'yoast_active' => defined('WPSEO_VERSION'),
                    'rest_meta_fields' => apply_filters('auto_articles_connector_yoast_fields', [
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

AutoArticlesConnector::init();
register_activation_hook(__FILE__, ['AutoArticlesConnector', 'activate']);


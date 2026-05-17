<?php
/**
 * Plugin Name:       Riviso Content Operations
 * Plugin URI:        https://riviso.com
 * Description:       REST connector for Riviso — Yoast meta in REST, connection ping, and secure publish endpoint.
 * Version:           0.2.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Riviso
 * Author URI:        https://riviso.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       riviso-content-operations
 *
 * @package RivisoContentOperations
 */

if (!defined('ABSPATH')) {
    exit;
}

final class RivisoContentOperationsConnector {
    const REST_NAMESPACE = 'riviso/v1';
    const OPTION_CONNECTOR_ID = 'riviso_content_ops_connector_id';

    public static function init() {
        add_action('init', array(__CLASS__, 'register_yoast_meta_rest_support'));
        add_action('rest_api_init', array(__CLASS__, 'register_rest_routes'));
    }

    public static function activate() {
        if (!get_option(self::OPTION_CONNECTOR_ID)) {
            if (function_exists('wp_generate_uuid4')) {
                $id = wp_generate_uuid4();
            } elseif (function_exists('random_bytes')) {
                $id = bin2hex(random_bytes(16));
            } else {
                $id = uniqid('riviso_', true);
            }
            add_option(self::OPTION_CONNECTOR_ID, $id, '', false);
        }
    }

    public static function register_yoast_meta_rest_support() {
        $post_types = apply_filters('riviso_content_ops_post_types', array('post', 'page'));
        $yoast_fields = apply_filters('riviso_content_ops_yoast_fields', array(
            '_yoast_wpseo_title',
            '_yoast_wpseo_metadesc',
            '_yoast_wpseo_focuskw',
            '_yoast_wpseo_canonical',
            '_yoast_wpseo_opengraph-title',
            '_yoast_wpseo_opengraph-description',
            '_yoast_wpseo_twitter-title',
            '_yoast_wpseo_twitter-description',
        ));

        foreach ((array) $post_types as $post_type) {
            foreach ((array) $yoast_fields as $field) {
                register_post_meta($post_type, $field, array(
                    'show_in_rest' => true,
                    'single' => true,
                    'type' => 'string',
                    'auth_callback' => function () {
                        return current_user_can('edit_posts');
                    },
                ));
            }
        }
    }

    private static function normalize_post_type($raw) {
        $t = sanitize_key(is_string($raw) ? $raw : 'post');
        if ($t === 'posts') {
            $t = 'post';
        }
        return $t ? $t : 'post';
    }

    public static function register_rest_routes() {
        register_rest_route(self::REST_NAMESPACE, '/publish', array(
            'methods' => 'POST',
            'permission_callback' => function () {
                return current_user_can('publish_posts');
            },
            'callback' => function (WP_REST_Request $request) {
                $params = $request->get_json_params();
                if (!is_array($params)) {
                    return new WP_Error('riviso_invalid', 'Invalid JSON body', array('status' => 400));
                }

                if (!empty($params['validate_only'])) {
                    return new WP_REST_Response(array(
                        'ok' => true,
                        'can_publish' => current_user_can('publish_posts'),
                    ), 200);
                }

                $post_type = self::normalize_post_type(isset($params['post_type']) ? $params['post_type'] : 'post');
                $title = sanitize_text_field(isset($params['title']) ? $params['title'] : '');
                $content = isset($params['content']) ? wp_kses_post((string) $params['content']) : '';
                $status = sanitize_key(isset($params['status']) ? $params['status'] : 'draft');
                if (!in_array($status, array('publish', 'draft', 'pending', 'future', 'private'), true)) {
                    $status = 'draft';
                }

                $postarr = array(
                    'post_title' => $title,
                    'post_content' => $content,
                    'post_status' => $status,
                    'post_type' => $post_type,
                );

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
                        array('status' => 500)
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

                return new WP_REST_Response(array(
                    'id' => $post_id,
                    'link' => get_permalink($post_id),
                    'status' => get_post_status($post_id),
                ), 201);
            },
        ));

        register_rest_route(self::REST_NAMESPACE, '/ping', array(
            'methods' => 'GET',
            'permission_callback' => function () {
                return current_user_can('edit_posts');
            },
            'callback' => function (WP_REST_Request $request) {
                return new WP_REST_Response(array(
                    'ok' => true,
                    'plugin' => 'riviso-content-operations',
                    'version' => '0.2.0',
                    'connector_id' => (string) get_option(self::OPTION_CONNECTOR_ID, ''),
                    'site_url' => get_site_url(),
                    'wp_version' => get_bloginfo('version'),
                    'yoast_active' => defined('WPSEO_VERSION'),
                    'rest_meta_fields' => apply_filters('riviso_content_ops_yoast_fields', array(
                        '_yoast_wpseo_title',
                        '_yoast_wpseo_metadesc',
                        '_yoast_wpseo_focuskw',
                        '_yoast_wpseo_canonical',
                        '_yoast_wpseo_opengraph-title',
                        '_yoast_wpseo_opengraph-description',
                        '_yoast_wpseo_twitter-title',
                        '_yoast_wpseo_twitter-description',
                    )),
                ), 200);
            },
        ));
    }
}

RivisoContentOperationsConnector::init();
register_activation_hook(__FILE__, array('RivisoContentOperationsConnector', 'activate'));

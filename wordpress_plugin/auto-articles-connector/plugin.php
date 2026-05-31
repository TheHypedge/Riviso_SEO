<?php
/**
 * Riviso connector implementation (loaded by riviso-content-operations.php).
 *
 * @package RivisoContentOperations
 */

if (!defined('ABSPATH')) {
    exit;
}

if (defined('RIVISO_CONTENT_OPS_LOADED')) {
    return;
}
define('RIVISO_CONTENT_OPS_LOADED', true);

final class RivisoContentOperationsConnector {
    const REST_NAMESPACE = 'riviso/v1';
    const LEGACY_REST_NAMESPACE = 'auto-articles/v1';
    const OPTION_CONNECTOR_ID = 'riviso_content_ops_connector_id';
    const LEGACY_OPTION_CONNECTOR_ID = 'auto_articles_connector_id';
    const VERSION = '0.3.1';

    /** @var bool */
    private static $routes_registered = false;

    public static function init() {
        add_action('init', array(__CLASS__, 'register_yoast_meta_rest_support'));
        add_action('rest_api_init', array(__CLASS__, 'register_rest_routes'));
    }

    public static function activate() {
        self::ensure_connector_id(self::OPTION_CONNECTOR_ID);
        self::ensure_connector_id(self::LEGACY_OPTION_CONNECTOR_ID);
    }

    private static function ensure_connector_id($option_name) {
        if (get_option($option_name)) {
            return;
        }
        if (function_exists('wp_generate_uuid4')) {
            $id = wp_generate_uuid4();
        } elseif (function_exists('random_bytes')) {
            $id = bin2hex(random_bytes(16));
        } else {
            $id = uniqid('riviso_', true);
        }
        add_option($option_name, $id, '', false);
    }

    public static function connector_id() {
        self::ensure_connector_id(self::OPTION_CONNECTOR_ID);
        self::ensure_connector_id(self::LEGACY_OPTION_CONNECTOR_ID);
        $id = (string) get_option(self::OPTION_CONNECTOR_ID, '');
        if ($id !== '') {
            return $id;
        }
        return (string) get_option(self::LEGACY_OPTION_CONNECTOR_ID, '');
    }

    public static function register_yoast_meta_rest_support() {
        $post_types = apply_filters('riviso_content_ops_post_types', apply_filters('auto_articles_connector_post_types', array(
            'post',
            'page',
            'articles',
            'news',
            'subjects',
            'bare-acts',
            'judgements',
        )));

        $yoast_fields = apply_filters('riviso_content_ops_yoast_fields', apply_filters('auto_articles_connector_yoast_fields', array(
            '_yoast_wpseo_title',
            '_yoast_wpseo_metadesc',
            '_yoast_wpseo_focuskw',
            '_yoast_wpseo_canonical',
            '_yoast_wpseo_opengraph-title',
            '_yoast_wpseo_opengraph-description',
            '_yoast_wpseo_twitter-title',
            '_yoast_wpseo_twitter-description',
        )));

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

    public static function handle_publish(WP_REST_Request $request) {
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
        self::apply_post_extras($post_id, $params);

        return new WP_REST_Response(array(
            'id' => $post_id,
            'link' => get_permalink($post_id),
            'status' => get_post_status($post_id),
        ), 201);
    }

    public static function handle_update(WP_REST_Request $request) {
        $params = $request->get_json_params();
        if (!is_array($params)) {
            return new WP_Error('riviso_invalid', 'Invalid JSON body', array('status' => 400));
        }

        $post_id = isset($params['post_id']) ? (int) $params['post_id'] : 0;
        if ($post_id <= 0) {
            return new WP_Error('riviso_invalid', 'Missing post_id', array('status' => 400));
        }

        $existing = get_post($post_id);
        if (!$existing instanceof WP_Post) {
            return new WP_Error('riviso_not_found', 'Post not found', array('status' => 404));
        }

        $postarr = array('ID' => $post_id);
        if (isset($params['title'])) {
            $postarr['post_title'] = sanitize_text_field((string) $params['title']);
        }
        if (isset($params['content'])) {
            $postarr['post_content'] = wp_kses_post((string) $params['content']);
        }
        if (isset($params['status'])) {
            $status = sanitize_key((string) $params['status']);
            if (in_array($status, array('publish', 'draft', 'pending', 'future', 'private', 'trash'), true)) {
                $postarr['post_status'] = $status;
            }
        }

        $updated_id = wp_update_post($postarr, true);
        if (is_wp_error($updated_id)) {
            return new WP_Error(
                'riviso_update_failed',
                $updated_id->get_error_message(),
                array('status' => 500)
            );
        }

        self::apply_post_extras($post_id, $params);

        return new WP_REST_Response(array(
            'id' => $post_id,
            'link' => get_permalink($post_id),
            'status' => get_post_status($post_id),
        ), 200);
    }

    private static function apply_post_extras($post_id, array $params) {
        if (!empty($params['categories']) && is_array($params['categories'])) {
            $cats = array_filter(array_map('intval', $params['categories']));
            if ($cats) {
                wp_set_post_categories((int) $post_id, $cats, false);
            }
        }

        if (!empty($params['featured_media']) && is_numeric($params['featured_media'])) {
            set_post_thumbnail((int) $post_id, (int) $params['featured_media']);
        }

        if (!empty($params['meta']) && is_array($params['meta'])) {
            foreach ($params['meta'] as $key => $val) {
                if (!is_string($key) || $key === '') {
                    continue;
                }
                update_post_meta((int) $post_id, $key, sanitize_text_field((string) $val));
            }
        }
    }

    public static function handle_ping() {
        return new WP_REST_Response(array(
            'ok' => true,
            'plugin' => 'rivisoseo',
            'version' => self::VERSION,
            'connector_id' => self::connector_id(),
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
    }

    public static function register_rest_routes() {
        if (self::$routes_registered) {
            return;
        }
        self::$routes_registered = true;

        $namespaces = array_unique(array(self::REST_NAMESPACE, self::LEGACY_REST_NAMESPACE));
        foreach ($namespaces as $namespace) {
            register_rest_route($namespace, '/publish', array(
                'methods' => 'POST',
                'permission_callback' => function () {
                    return current_user_can('publish_posts');
                },
                'callback' => array(__CLASS__, 'handle_publish'),
            ));

            register_rest_route($namespace, '/update', array(
                'methods' => 'POST',
                'permission_callback' => function () {
                    return current_user_can('edit_posts');
                },
                'callback' => array(__CLASS__, 'handle_update'),
            ));

            register_rest_route($namespace, '/ping', array(
                'methods' => 'GET',
                'permission_callback' => function () {
                    return current_user_can('edit_posts');
                },
                'callback' => array(__CLASS__, 'handle_ping'),
            ));
        }
    }
}

RivisoContentOperationsConnector::init();

<?php
/**
 * RivisoSEO connector core (loaded by riviso-content-operations.php).
 *
 * @package RivisoContentOperations
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

if ( defined( 'RIVISO_CONTENT_OPS_LOADED' ) ) {
	return;
}
define( 'RIVISO_CONTENT_OPS_LOADED', true );

final class RivisoContentOperationsConnector {
	const REST_NAMESPACE = 'riviso/v1';
	const LEGACY_REST_NAMESPACE = 'auto-articles/v1';
	const OPTION_CONNECTOR_ID = 'riviso_content_ops_connector_id';
	const LEGACY_OPTION_CONNECTOR_ID = 'auto_articles_connector_id';
	const VERSION = '0.6.1';

	/** @var bool */
	private static $routes_registered = false;

	public static function init() {
		add_action( 'init', array( __CLASS__, 'register_seo_meta_rest_support' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest_routes' ) );

		if ( defined( 'RIVISO_PLUGIN_FILE' ) ) {
			$basename = plugin_basename( RIVISO_PLUGIN_FILE );
			add_filter( 'plugin_action_links_' . $basename, array( __CLASS__, 'plugin_action_links' ) );
			add_filter( 'plugin_row_meta', array( __CLASS__, 'plugin_row_meta' ), 10, 2 );
		}
	}

	public static function activate() {
		self::ensure_connector_id( self::OPTION_CONNECTOR_ID );
		self::ensure_connector_id( self::LEGACY_OPTION_CONNECTOR_ID );
		self::deactivate_legacy_bootstrap_paths();
	}

	public static function deactivate() {
		// Reserved for future cleanup hooks.
	}

	private static function deactivate_legacy_bootstrap_paths() {
		if ( ! defined( 'RIVISO_PLUGIN_FILE' ) ) {
			return;
		}
		if ( ! function_exists( 'deactivate_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$canonical = plugin_basename( RIVISO_PLUGIN_FILE );
		$legacy_paths = array(
			'riviso-content-operations/plugin.php',
			'auto-articles-connector/auto-articles-connector.php',
			'auto-articles-connector/plugin.php',
		);
		foreach ( $legacy_paths as $path ) {
			if ( $path === $canonical ) {
				continue;
			}
			if ( function_exists( 'is_plugin_active' ) && is_plugin_active( $path ) ) {
				deactivate_plugins( $path, true );
			}
		}
	}

	public static function plugin_action_links( $links ) {
		$links[] = '<a href="' . esc_url( admin_url( 'admin.php?page=riviso-settings' ) ) . '">' .
			esc_html__( 'Settings', 'riviso-content-operations' ) . '</a>';
		return $links;
	}

	public static function plugin_row_meta( $links, $file ) {
		if ( ! defined( 'RIVISO_PLUGIN_FILE' ) || $file !== plugin_basename( RIVISO_PLUGIN_FILE ) ) {
			return $links;
		}
		$links[] = '<a href="https://riviso.com" target="_blank" rel="noopener">' .
			esc_html__( 'Documentation', 'riviso-content-operations' ) . '</a>';
		return $links;
	}

	private static function ensure_connector_id( $option_name ) {
		if ( get_option( $option_name ) ) {
			return;
		}
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			$id = wp_generate_uuid4();
		} elseif ( function_exists( 'random_bytes' ) ) {
			$id = bin2hex( random_bytes( 16 ) );
		} else {
			$id = uniqid( 'riviso_', true );
		}
		add_option( $option_name, $id, '', false );
	}

	public static function connector_id() {
		self::ensure_connector_id( self::OPTION_CONNECTOR_ID );
		self::ensure_connector_id( self::LEGACY_OPTION_CONNECTOR_ID );
		$id = (string) get_option( self::OPTION_CONNECTOR_ID, '' );
		if ( $id !== '' ) {
			return $id;
		}
		return (string) get_option( self::LEGACY_OPTION_CONNECTOR_ID, '' );
	}

	/**
	 * Detect the active SEO plugin on each request (supports mid-flight plugin switches).
	 *
	 * @return string 'rank_math'|'yoast'|'none'
	 */
	public static function get_active_seo_platform() {
		if ( ! function_exists( 'is_plugin_active' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( function_exists( 'is_plugin_active' ) && is_plugin_active( 'seo-by-rank-math/rank-math.php' ) ) {
			return 'rank_math';
		}
		if ( function_exists( 'is_plugin_active' ) && is_plugin_active( 'wordpress-seo/wp-seo.php' ) ) {
			return 'yoast';
		}
		if ( function_exists( 'is_plugin_active' ) && is_plugin_active( 'wordpress-seo/wordpress-seo.php' ) ) {
			return 'yoast';
		}
		if ( defined( 'RANK_MATH_VERSION' ) ) {
			return 'rank_math';
		}
		if ( defined( 'WPSEO_VERSION' ) ) {
			return 'yoast';
		}
		return 'none';
	}

	/**
	 * SEO meta keys Riviso may send (Yoast-shaped payload stays unchanged upstream).
	 *
	 * @return string[]
	 */
	private static function riviso_seo_source_meta_keys() {
		return array(
			'_yoast_wpseo_title',
			'_yoast_wpseo_metadesc',
			'_yoast_wpseo_focuskw',
			'meta_title',
			'meta_description',
			'focus_keyphrase',
			'focus_keyword',
			'_rank_math_title',
			'_rank_math_description',
			'_rank_math_focus_keyword',
			'_riviso_seo_title',
			'_riviso_seo_description',
			'_riviso_seo_focus_keyword',
		);
	}

	/**
	 * Extract canonical SEO values from the Riviso meta payload.
	 *
	 * @param array<string,mixed> $meta Incoming REST meta map.
	 * @return array{title:string,description:string,focus_keyword:string}
	 */
	private static function extract_seo_from_payload_meta( array $meta ) {
		$title_keys = array( '_yoast_wpseo_title', 'meta_title', '_rank_math_title', '_riviso_seo_title' );
		$desc_keys  = array( '_yoast_wpseo_metadesc', 'meta_description', '_rank_math_description', '_riviso_seo_description' );
		$focus_keys = array( '_yoast_wpseo_focuskw', 'focus_keyphrase', 'focus_keyword', '_rank_math_focus_keyword', '_riviso_seo_focus_keyword' );

		$pick = static function ( array $source, array $keys ) {
			foreach ( $keys as $key ) {
				if ( isset( $source[ $key ] ) && (string) $source[ $key ] !== '' ) {
					return sanitize_text_field( (string) $source[ $key ] );
				}
			}
			return '';
		};

		return array(
			'title'          => $pick( $meta, $title_keys ),
			'description'    => $pick( $meta, $desc_keys ),
			'focus_keyword'  => $pick( $meta, $focus_keys ),
		);
	}

	/**
	 * Map canonical SEO values to platform-specific post meta keys.
	 *
	 * @param string $platform From get_active_seo_platform().
	 * @param array{title:string,description:string,focus_keyword:string} $seo Canonical SEO values.
	 * @return array<string,string>
	 */
	private static function map_seo_meta_for_platform( $platform, array $seo ) {
		$mapped = array();

		switch ( $platform ) {
			case 'rank_math':
				if ( $seo['title'] !== '' ) {
					$mapped['_rank_math_title'] = $seo['title'];
				}
				if ( $seo['description'] !== '' ) {
					$mapped['_rank_math_description'] = $seo['description'];
				}
				if ( $seo['focus_keyword'] !== '' ) {
					$mapped['_rank_math_focus_keyword'] = $seo['focus_keyword'];
				}
				break;

			case 'yoast':
				if ( $seo['title'] !== '' ) {
					$mapped['_yoast_wpseo_title'] = $seo['title'];
				}
				if ( $seo['description'] !== '' ) {
					$mapped['_yoast_wpseo_metadesc'] = $seo['description'];
				}
				if ( $seo['focus_keyword'] !== '' ) {
					$mapped['_yoast_wpseo_focuskw'] = $seo['focus_keyword'];
				}
				break;

			default:
				if ( $seo['title'] !== '' ) {
					$mapped['_riviso_seo_title'] = $seo['title'];
				}
				if ( $seo['description'] !== '' ) {
					$mapped['_riviso_seo_description'] = $seo['description'];
				}
				if ( $seo['focus_keyword'] !== '' ) {
					$mapped['_riviso_seo_focus_keyword'] = $seo['focus_keyword'];
				}
				break;
		}

		return $mapped;
	}

	/**
	 * Register Yoast + Rank Math + Riviso fallback meta keys for REST read/write.
	 */
	public static function register_seo_meta_rest_support() {
		$post_types = apply_filters(
			'riviso_content_ops_post_types',
			apply_filters(
				'auto_articles_connector_post_types',
				array(
					'post',
					'page',
					'articles',
					'news',
					'subjects',
					'bare-acts',
					'judgements',
				)
			)
		);

		$seo_fields = apply_filters(
			'riviso_content_ops_seo_fields',
			array_merge(
				array(
					'_yoast_wpseo_title',
					'_yoast_wpseo_metadesc',
					'_yoast_wpseo_focuskw',
					'_yoast_wpseo_canonical',
					'_yoast_wpseo_opengraph-title',
					'_yoast_wpseo_opengraph-description',
					'_yoast_wpseo_twitter-title',
					'_yoast_wpseo_twitter-description',
					'_rank_math_title',
					'_rank_math_description',
					'_rank_math_focus_keyword',
					'_riviso_seo_title',
					'_riviso_seo_description',
					'_riviso_seo_focus_keyword',
				),
				self::riviso_seo_source_meta_keys()
			)
		);
		$seo_fields = array_values( array_unique( array_filter( array_map( 'strval', (array) $seo_fields ) ) ) );

		foreach ( (array) $post_types as $post_type ) {
			foreach ( $seo_fields as $field ) {
				register_post_meta(
					$post_type,
					$field,
					array(
						'show_in_rest'  => true,
						'single'        => true,
						'type'          => 'string',
						'auth_callback' => function () {
							return current_user_can( 'edit_posts' );
						},
					)
				);
			}
		}
	}

	/** @deprecated 0.6.0 Use register_seo_meta_rest_support(). */
	public static function register_yoast_meta_rest_support() {
		self::register_seo_meta_rest_support();
	}

	private static function normalize_post_type( $raw ) {
		$t = sanitize_key( is_string( $raw ) ? $raw : 'post' );
		if ( $t === 'posts' ) {
			$t = 'post';
		}
		return $t ? $t : 'post';
	}

	public static function handle_publish( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			return new WP_Error( 'riviso_invalid', 'Invalid JSON body', array( 'status' => 400 ) );
		}

		if ( ! empty( $params['validate_only'] ) ) {
			return new WP_REST_Response(
				array(
					'ok'          => true,
					'can_publish' => current_user_can( 'publish_posts' ),
				),
				200
			);
		}

		$post_type = self::normalize_post_type( isset( $params['post_type'] ) ? $params['post_type'] : 'post' );
		$title     = sanitize_text_field( isset( $params['title'] ) ? $params['title'] : '' );
		$content   = isset( $params['content'] ) ? wp_kses_post( (string) $params['content'] ) : '';
		$status    = sanitize_key( isset( $params['status'] ) ? $params['status'] : 'draft' );
		if ( ! in_array( $status, array( 'publish', 'draft', 'pending', 'future', 'private' ), true ) ) {
			$status = 'draft';
		}

		$postarr = array(
			'post_title'   => $title,
			'post_content' => $content,
			'post_status'  => $status,
			'post_type'    => $post_type,
		);

		if ( ! empty( $params['categories'] ) && is_array( $params['categories'] ) ) {
			$cats = array_filter( array_map( 'intval', $params['categories'] ) );
			if ( $cats ) {
				$postarr['post_category'] = $cats;
			}
		}

		$post_id = wp_insert_post( $postarr, true );
		if ( is_wp_error( $post_id ) ) {
			return new WP_Error(
				'riviso_publish_failed',
				$post_id->get_error_message(),
				array( 'status' => 500 )
			);
		}

		$post_id = (int) $post_id;
		self::apply_post_extras( $post_id, $params );

		return new WP_REST_Response(
			array(
				'id'     => $post_id,
				'link'   => get_permalink( $post_id ),
				'status' => get_post_status( $post_id ),
			),
			201
		);
	}

	public static function handle_update( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			return new WP_Error( 'riviso_invalid', 'Invalid JSON body', array( 'status' => 400 ) );
		}

		$post_id = isset( $params['post_id'] ) ? (int) $params['post_id'] : 0;
		if ( $post_id <= 0 ) {
			return new WP_Error( 'riviso_invalid', 'Missing post_id', array( 'status' => 400 ) );
		}

		$existing = get_post( $post_id );
		if ( ! $existing instanceof WP_Post ) {
			return new WP_Error( 'riviso_not_found', 'Post not found', array( 'status' => 404 ) );
		}

		$postarr = array( 'ID' => $post_id );
		if ( isset( $params['title'] ) ) {
			$postarr['post_title'] = sanitize_text_field( (string) $params['title'] );
		}
		if ( isset( $params['content'] ) ) {
			$postarr['post_content'] = wp_kses_post( (string) $params['content'] );
		}
		if ( isset( $params['status'] ) ) {
			$status = sanitize_key( (string) $params['status'] );
			if ( in_array( $status, array( 'publish', 'draft', 'pending', 'future', 'private', 'trash' ), true ) ) {
				$postarr['post_status'] = $status;
			}
		}

		$updated_id = wp_update_post( $postarr, true );
		if ( is_wp_error( $updated_id ) ) {
			return new WP_Error(
				'riviso_update_failed',
				$updated_id->get_error_message(),
				array( 'status' => 500 )
			);
		}

		self::apply_post_extras( $post_id, $params );

		return new WP_REST_Response(
			array(
				'id'     => $post_id,
				'link'   => get_permalink( $post_id ),
				'status' => get_post_status( $post_id ),
			),
			200
		);
	}

	private static function apply_post_extras( $post_id, array $params ) {
		if ( ! empty( $params['categories'] ) && is_array( $params['categories'] ) ) {
			$cats = array_filter( array_map( 'intval', $params['categories'] ) );
			if ( $cats ) {
				wp_set_post_categories( (int) $post_id, $cats, false );
			}
		}

		if ( ! empty( $params['tags'] ) && is_array( $params['tags'] ) ) {
			$tag_ids = array_filter( array_map( 'intval', $params['tags'] ) );
			if ( $tag_ids ) {
				wp_set_object_terms( (int) $post_id, $tag_ids, 'post_tag', false );
			}
		}

		if ( ! empty( $params['featured_media'] ) && is_numeric( $params['featured_media'] ) ) {
			set_post_thumbnail( (int) $post_id, (int) $params['featured_media'] );
		}

		if ( ! empty( $params['meta'] ) && is_array( $params['meta'] ) ) {
			self::apply_mapped_post_meta( (int) $post_id, $params['meta'] );
		}
	}

	/**
	 * Map Riviso SEO meta to Yoast, Rank Math, or fallback fields; persist extras safely.
	 *
	 * @param int                  $post_id Post ID.
	 * @param array<string,mixed>  $meta    Incoming meta payload from Riviso.
	 */
	private static function apply_mapped_post_meta( $post_id, array $meta ) {
		$platform     = self::get_active_seo_platform();
		$seo_values   = self::extract_seo_from_payload_meta( $meta );
		$mapped_seo   = self::map_seo_meta_for_platform( $platform, $seo_values );
		$skip_keys    = array_flip( self::riviso_seo_source_meta_keys() );
		$yoast_extras = array(
			'_yoast_wpseo_canonical',
			'_yoast_wpseo_opengraph-title',
			'_yoast_wpseo_opengraph-description',
			'_yoast_wpseo_twitter-title',
			'_yoast_wpseo_twitter-description',
		);

		foreach ( $mapped_seo as $key => $val ) {
			update_post_meta( $post_id, $key, $val );
		}

		foreach ( $meta as $key => $val ) {
			if ( ! is_string( $key ) || $key === '' || isset( $skip_keys[ $key ] ) ) {
				continue;
			}
			if ( $platform === 'rank_math' && in_array( $key, $yoast_extras, true ) ) {
				continue;
			}
			if ( $platform === 'yoast' && strpos( $key, '_rank_math_' ) === 0 ) {
				continue;
			}
			update_post_meta( $post_id, $key, sanitize_text_field( (string) $val ) );
		}
	}

	public static function handle_ping() {
		$platform = self::get_active_seo_platform();
		$fields   = array();

		switch ( $platform ) {
			case 'rank_math':
				$fields = array(
					'_rank_math_title',
					'_rank_math_description',
					'_rank_math_focus_keyword',
				);
				break;
			case 'yoast':
				$fields = array(
					'_yoast_wpseo_title',
					'_yoast_wpseo_metadesc',
					'_yoast_wpseo_focuskw',
					'_yoast_wpseo_canonical',
					'_yoast_wpseo_opengraph-title',
					'_yoast_wpseo_opengraph-description',
					'_yoast_wpseo_twitter-title',
					'_yoast_wpseo_twitter-description',
				);
				break;
			default:
				$fields = array(
					'_riviso_seo_title',
					'_riviso_seo_description',
					'_riviso_seo_focus_keyword',
				);
				break;
		}

		return new WP_REST_Response(
			array(
				'ok'               => true,
				'plugin'           => 'rivisoseo',
				'version'          => self::VERSION,
				'connector_id'     => self::connector_id(),
				'site_url'         => get_site_url(),
				'wp_version'       => get_bloginfo( 'version' ),
				'seo_platform'     => $platform,
				'yoast_active'     => ( $platform === 'yoast' ),
				'rank_math_active' => ( $platform === 'rank_math' ),
				'rest_meta_fields' => apply_filters( 'riviso_content_ops_seo_fields', $fields ),
			),
			200
		);
	}

	public static function register_rest_routes() {
		if ( self::$routes_registered ) {
			return;
		}
		self::$routes_registered = true;

		$namespaces = array_unique( array( self::REST_NAMESPACE, self::LEGACY_REST_NAMESPACE ) );
		foreach ( $namespaces as $namespace ) {
			register_rest_route(
				$namespace,
				'/publish',
				array(
					'methods'             => 'POST',
					'permission_callback' => function () {
						return current_user_can( 'publish_posts' );
					},
					'callback'            => array( __CLASS__, 'handle_publish' ),
				)
			);

			register_rest_route(
				$namespace,
				'/update',
				array(
					'methods'             => 'POST',
					'permission_callback' => function () {
						return current_user_can( 'edit_posts' );
					},
					'callback'            => array( __CLASS__, 'handle_update' ),
				)
			);

			register_rest_route(
				$namespace,
				'/ping',
				array(
					'methods'             => 'GET',
					'permission_callback' => function () {
						return current_user_can( 'edit_posts' );
					},
					'callback'            => array( __CLASS__, 'handle_ping' ),
				)
			);
		}
	}
}

RivisoContentOperationsConnector::init();

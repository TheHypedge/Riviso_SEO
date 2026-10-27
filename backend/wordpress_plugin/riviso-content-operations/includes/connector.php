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
	const VERSION = '0.7.0';
	const OPTION_INDEXNOW_KEY = 'riviso_indexnow_key';
	const OPTION_UPDATE_TOKEN = 'riviso_update_token';
	const SCHEMA_META_KEYS = array( '_riviso_schema_faq', '_riviso_schema_article' );
	const DEFAULT_API_BASE = 'https://api.riviso.cloud';

	/** @var bool */
	private static $routes_registered = false;

	public static function init() {
		add_action( 'init', array( __CLASS__, 'serve_indexnow_key' ), 0 );
		add_action( 'init', array( __CLASS__, 'register_seo_meta_rest_support' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest_routes' ) );
		// Priority 20: after Yoast/Rank Math's own wp_head schema output; we only add
		// our own separate nodes (FAQPage, and Article only when neither is active).
		add_action( 'wp_head', array( __CLASS__, 'output_schema_markup' ), 20 );
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'check_for_update' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_info' ), 10, 3 );

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
	/**
	 * Every meta key Riviso may write. Anything else in a request is dropped, so an
	 * authenticated caller cannot touch protected keys (_wp_page_template, _thumbnail_id, ...).
	 *
	 * @return string[]
	 */
	private static function allowed_meta_keys() {
		$keys = array_merge(
			self::riviso_seo_source_meta_keys(),
			array(
				'_yoast_wpseo_canonical',
				'_yoast_wpseo_opengraph-title',
				'_yoast_wpseo_opengraph-description',
				'_yoast_wpseo_twitter-title',
				'_yoast_wpseo_twitter-description',
				'_yoast_wpseo_schema_page_type',
				'_yoast_wpseo_schema_article_type',
				'rank_math_canonical_url',
				'rank_math_rich_snippet',
				'_aioseo_title',
				'_aioseo_description',
			),
			self::SCHEMA_META_KEYS
		);
		return array_values( array_unique( array_map( 'strval', (array) apply_filters( 'riviso_content_ops_allowed_meta_keys', $keys ) ) ) );
	}

	private static function riviso_seo_source_meta_keys() {
		return array(
			'_yoast_wpseo_title',
			'_yoast_wpseo_metadesc',
			'_yoast_wpseo_focuskw',
			'meta_title',
			'meta_description',
			'focus_keyphrase',
			'focus_keyword',
			'rank_math_title',
			'rank_math_description',
			'rank_math_focus_keyword',
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
		$title_keys = array( '_yoast_wpseo_title', 'meta_title', 'rank_math_title', '_riviso_seo_title' );
		$desc_keys  = array( '_yoast_wpseo_metadesc', 'meta_description', 'rank_math_description', '_riviso_seo_description' );
		$focus_keys = array( '_yoast_wpseo_focuskw', 'focus_keyphrase', 'focus_keyword', 'rank_math_focus_keyword', '_riviso_seo_focus_keyword' );

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
					$mapped['rank_math_title'] = $seo['title'];
				}
				if ( $seo['description'] !== '' ) {
					$mapped['rank_math_description'] = $seo['description'];
				}
				if ( $seo['focus_keyword'] !== '' ) {
					$mapped['rank_math_focus_keyword'] = $seo['focus_keyword'];
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
					'rank_math_title',
					'rank_math_description',
					'rank_math_focus_keyword',
					'rank_math_canonical_url',
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
						// Per-post check: edit_posts alone would let a Contributor change SEO
						// meta on posts they cannot edit.
						'auth_callback' => function ( $allowed, $meta_key, $object_id ) {
							return current_user_can( 'edit_post', (int) $object_id );
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

	/**
	 * Only public, front-end content types (post, page, CPTs) — never attachments, menus,
	 * templates, changesets or other internal types.
	 *
	 * @param string $post_type Post type slug.
	 * @return WP_Post_Type|null
	 */
	private static function content_post_type( $post_type ) {
		$pto = get_post_type_object( $post_type );
		if ( ! $pto || $post_type === 'attachment' || ! is_post_type_viewable( $pto ) ) {
			return null;
		}
		return $pto;
	}

	/**
	 * Statuses that make content visible need the type's publish capability.
	 *
	 * @param string       $status Requested status.
	 * @param WP_Post_Type $pto    Post type object.
	 * @return WP_Error|null
	 */
	private static function status_permission_error( $status, $pto ) {
		if ( in_array( $status, array( 'publish', 'future', 'private' ), true ) && ! current_user_can( $pto->cap->publish_posts ) ) {
			return new WP_Error(
				'riviso_forbidden',
				'This WordPress user cannot publish posts. Use an Editor or Administrator account.',
				array( 'status' => 403 )
			);
		}
		return null;
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
		$pto       = self::content_post_type( $post_type );
		if ( ! $pto ) {
			return new WP_Error( 'riviso_invalid', 'Unsupported post type', array( 'status' => 400 ) );
		}
		if ( ! current_user_can( $pto->cap->create_posts ) ) {
			return new WP_Error( 'riviso_forbidden', 'This WordPress user cannot create this post type.', array( 'status' => 403 ) );
		}
		$title   = sanitize_text_field( isset( $params['title'] ) ? $params['title'] : '' );
		$content = isset( $params['content'] ) ? wp_kses_post( (string) $params['content'] ) : '';
		$status  = sanitize_key( isset( $params['status'] ) ? $params['status'] : 'draft' );
		if ( ! in_array( $status, array( 'publish', 'draft', 'pending', 'future', 'private' ), true ) ) {
			$status = 'draft';
		}
		$denied = self::status_permission_error( $status, $pto );
		if ( $denied ) {
			return $denied;
		}

		$postarr = array(
			'post_title'   => $title,
			'post_content' => $content,
			'post_status'  => $status,
			'post_type'    => $post_type,
		);

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
		$pto      = $existing instanceof WP_Post ? self::content_post_type( $existing->post_type ) : null;
		// Same 404 for "missing", "not a content type" and "not yours" — no ID probing.
		if ( ! $pto || ! current_user_can( 'edit_post', $post_id ) ) {
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
				$denied = $status === 'trash'
					? ( current_user_can( 'delete_post', $post_id ) ? null : new WP_Error( 'riviso_forbidden', 'This WordPress user cannot delete this post.', array( 'status' => 403 ) ) )
					: self::status_permission_error( $status, $pto );
				if ( $denied ) {
					return $denied;
				}
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

	/**
	 * @param string $taxonomy Taxonomy slug.
	 * @param int    $post_id  Post the terms go on (taxonomy must be registered for its type).
	 * @return bool
	 */
	private static function can_assign_terms( $taxonomy, $post_id ) {
		$tax = get_taxonomy( $taxonomy );
		return $tax && is_object_in_taxonomy( get_post_type( $post_id ), $taxonomy ) && current_user_can( $tax->cap->assign_terms );
	}

	/**
	 * Existing term IDs of $taxonomy only (unknown IDs are dropped, never created).
	 *
	 * @param mixed  $raw      Incoming IDs.
	 * @param string $taxonomy Taxonomy slug.
	 * @return int[]
	 */
	private static function existing_term_ids( $raw, $taxonomy ) {
		$ids = array();
		foreach ( (array) $raw as $id ) {
			$id = (int) $id;
			if ( $id > 0 && term_exists( $id, $taxonomy ) ) {
				$ids[] = $id;
			}
		}
		return $ids;
	}

	private static function apply_post_extras( $post_id, array $params ) {
		if ( ! empty( $params['categories'] ) && is_array( $params['categories'] ) && self::can_assign_terms( 'category', $post_id ) ) {
			$cats = self::existing_term_ids( $params['categories'], 'category' );
			if ( $cats ) {
				wp_set_post_categories( (int) $post_id, $cats, false );
			}
		}

		$can_tag = self::can_assign_terms( 'post_tag', $post_id );
		if ( $can_tag && ! empty( $params['tags'] ) && is_array( $params['tags'] ) ) {
			$tag_ids = self::existing_term_ids( $params['tags'], 'post_tag' );
			if ( $tag_ids ) {
				wp_set_object_terms( (int) $post_id, $tag_ids, 'post_tag', false );
			}
		}

		if ( $can_tag && ! empty( $params['tag_names'] ) && is_array( $params['tag_names'] ) ) {
			$names = array();
			foreach ( $params['tag_names'] as $raw_name ) {
				$name = sanitize_text_field( (string) $raw_name );
				if ( $name !== '' ) {
					$names[] = $name;
				}
			}
			if ( $names ) {
				wp_set_object_terms( (int) $post_id, $names, 'post_tag', false );
			}
		}

		if ( ! empty( $params['featured_media'] ) && is_numeric( $params['featured_media'] ) ) {
			$media_id = (int) $params['featured_media'];
			// Must be an image attachment this user may read (not someone's private file).
			if ( wp_attachment_is_image( $media_id ) && current_user_can( 'read_post', $media_id ) ) {
				set_post_thumbnail( (int) $post_id, $media_id );
			}
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

		$allowed      = array_flip( self::allowed_meta_keys() );

		foreach ( $mapped_seo as $key => $val ) {
			update_post_meta( $post_id, $key, $val );
		}

		foreach ( $meta as $key => $val ) {
			if ( ! is_string( $key ) || $key === '' || isset( $skip_keys[ $key ] ) || ! isset( $allowed[ $key ] ) ) {
				continue;
			}
			if ( ! is_scalar( $val ) ) {
				continue;
			}
			if ( in_array( $key, self::SCHEMA_META_KEYS, true ) ) {
				// JSON-LD is stored re-encoded from a decoded schema.org object, never as the
				// raw string (sanitize_text_field would mangle it; raw could carry markup).
				$schema = self::decode_schema( (string) $val );
				if ( $schema ) {
					update_post_meta( $post_id, $key, wp_slash( wp_json_encode( $schema ) ) );
				}
				continue;
			}
			if ( $platform === 'rank_math' && in_array( $key, $yoast_extras, true ) ) {
				continue;
			}
			if ( $platform === 'yoast' && strpos( $key, 'rank_math_' ) === 0 ) {
				continue;
			}
			update_post_meta( $post_id, $key, sanitize_text_field( (string) $val ) );
		}
	}

	/**
	 * Decode a JSON-LD string; only schema.org objects (max 64 KB) are accepted.
	 *
	 * @param string $raw JSON string.
	 * @return array|null
	 */
	private static function decode_schema( $raw ) {
		if ( $raw === '' || strlen( $raw ) > 65536 ) {
			return null;
		}
		$data = json_decode( $raw, true );
		if ( ! is_array( $data ) || ! isset( $data['@context'] ) || ! is_string( $data['@context'] ) ) {
			return null;
		}
		return preg_match( '#^https?://schema\.org/?$#', $data['@context'] ) ? $data : null;
	}

	/**
	 * Print Riviso JSON-LD (FAQPage; Article only when no SEO plugin handles it) in <head>.
	 * Re-encoded with JSON_HEX_TAG so no stored value can close the <script> element.
	 */
	public static function output_schema_markup() {
		if ( ! is_singular() ) {
			return;
		}
		$post_id = get_the_ID();
		if ( ! $post_id || get_post_status( $post_id ) !== 'publish' ) {
			return;
		}
		foreach ( self::SCHEMA_META_KEYS as $key ) {
			$raw    = get_post_meta( $post_id, $key, true );
			$schema = is_string( $raw ) ? self::decode_schema( $raw ) : null;
			if ( ! $schema ) {
				continue;
			}
			$json = wp_json_encode( $schema, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_UNICODE );
			if ( $json ) {
				echo '<script type="application/ld+json">' . $json . '</script>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- hex-escaped JSON.
			}
		}
	}

	public static function handle_ping() {
		$platform = self::get_active_seo_platform();
		$fields   = array();

		switch ( $platform ) {
			case 'rank_math':
				$fields = array(
					'rank_math_title',
					'rank_math_description',
					'rank_math_focus_keyword',
					'rank_math_canonical_url',
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
				'auto_update'      => get_option( self::OPTION_UPDATE_TOKEN, '' ) !== '',
				'indexnow'         => get_option( self::OPTION_INDEXNOW_KEY, '' ) !== '',
			),
			200
		);
	}

	/**
	 * IndexNow key format: 8-128 chars of a-z, A-Z, 0-9 and dashes.
	 *
	 * @param mixed $key Candidate key.
	 * @return bool
	 */
	private static function is_valid_indexnow_key( $key ) {
		return is_string( $key ) && (bool) preg_match( '/^[A-Za-z0-9-]{8,128}$/', $key );
	}

	/**
	 * Serve {home}/{key}.txt so IndexNow (Bing & co.) can verify site ownership.
	 * No physical file is written; the request is answered before WordPress routing.
	 */
	public static function serve_indexnow_key() {
		$key = (string) get_option( self::OPTION_INDEXNOW_KEY, '' );
		if ( ! self::is_valid_indexnow_key( $key ) || empty( $_SERVER['REQUEST_URI'] ) ) {
			return;
		}
		$path      = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$home_path = rtrim( (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH ), '/' );
		if ( $path !== $home_path . '/' . $key . '.txt' ) {
			return;
		}
		status_header( 200 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		header( 'X-Robots-Tag: noindex' );
		echo $key; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- validated [A-Za-z0-9-] only.
		exit;
	}

	public static function handle_indexnow_key( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		$key    = is_array( $params ) && isset( $params['key'] ) ? (string) $params['key'] : '';
		if ( ! self::is_valid_indexnow_key( $key ) ) {
			return new WP_Error( 'riviso_invalid', 'Invalid IndexNow key', array( 'status' => 400 ) );
		}
		update_option( self::OPTION_INDEXNOW_KEY, $key, true );
		return new WP_REST_Response(
			array(
				'ok'           => true,
				'key_location' => home_url( '/' . $key . '.txt' ),
			),
			200
		);
	}

	public static function handle_update_token( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		$token  = is_array( $params ) && isset( $params['token'] ) ? (string) $params['token'] : '';
		if ( ! preg_match( '/^[A-Za-z0-9_-]{1,100}\.[a-f0-9]{40}$/', $token ) ) {
			return new WP_Error( 'riviso_invalid', 'Invalid update token', array( 'status' => 400 ) );
		}
		update_option( self::OPTION_UPDATE_TOKEN, $token, false );
		delete_site_transient( 'riviso_release' );
		return new WP_REST_Response( array( 'ok' => true ), 200 );
	}

	/**
	 * Riviso API origin. HTTPS only; overridable with define( 'RIVISO_API_BASE', ... ) in wp-config.php.
	 *
	 * @return string
	 */
	private static function api_base() {
		$base = defined( 'RIVISO_API_BASE' ) ? (string) RIVISO_API_BASE : self::DEFAULT_API_BASE;
		$base = untrailingslashit( esc_url_raw( $base ) );
		return strpos( $base, 'https://' ) === 0 ? $base : self::DEFAULT_API_BASE;
	}

	/**
	 * Latest release manifest from Riviso (cached 6h; failures cached 1h).
	 *
	 * @return array|null
	 */
	private static function remote_release() {
		$token = (string) get_option( self::OPTION_UPDATE_TOKEN, '' );
		if ( $token === '' ) {
			return null;
		}
		$cached = get_site_transient( 'riviso_release' );
		if ( is_array( $cached ) ) {
			return $cached ? $cached : null;
		}
		$base = self::api_base();
		$res  = wp_remote_get(
			add_query_arg( 'token', rawurlencode( $token ), $base . '/api/wordpress/plugin/release' ),
			array( 'timeout' => 10 )
		);
		$data = ( ! is_wp_error( $res ) && wp_remote_retrieve_response_code( $res ) === 200 )
			? json_decode( wp_remote_retrieve_body( $res ), true )
			: null;
		$ok = is_array( $data )
			&& isset( $data['version'] )
			&& is_string( $data['version'] ) && preg_match( '/^\d+(\.\d+){1,3}$/', $data['version'] );
		if ( $ok ) {
			// Built here from the fixed HTTPS origin — the manifest can never point the download elsewhere.
			$data['package'] = add_query_arg( 'token', rawurlencode( $token ), $base . '/api/wordpress/plugin/package' );
		}
		set_site_transient( 'riviso_release', $ok ? $data : array(), $ok ? 6 * HOUR_IN_SECONDS : HOUR_IN_SECONDS );
		return $ok ? $data : null;
	}

	/**
	 * Hook into WordPress's own plugin update check, so "Update now" and auto-updates work
	 * exactly like wordpress.org plugins (the admin stays in control).
	 *
	 * @param object $transient update_plugins transient.
	 * @return object
	 */
	public static function check_for_update( $transient ) {
		if ( ! is_object( $transient ) || ! defined( 'RIVISO_PLUGIN_FILE' ) ) {
			return $transient;
		}
		$release = self::remote_release();
		if ( ! $release ) {
			return $transient;
		}
		$basename = plugin_basename( RIVISO_PLUGIN_FILE );
		$item     = (object) array(
			'id'           => 'riviso-content-operations',
			'slug'         => 'riviso-content-operations',
			'plugin'       => $basename,
			'new_version'  => $release['version'],
			'url'          => 'https://riviso.com',
			'package'      => $release['package'],
			'tested'       => isset( $release['tested'] ) ? (string) $release['tested'] : '',
			'requires_php' => isset( $release['requires_php'] ) ? (string) $release['requires_php'] : '',
		);
		if ( version_compare( $release['version'], self::VERSION, '>' ) ) {
			$transient->response[ $basename ] = $item;
		} else {
			// Listing it under no_update enables the "Enable auto-updates" toggle.
			$transient->no_update[ $basename ] = $item;
		}
		return $transient;
	}

	/**
	 * "View details" modal on the Plugins screen.
	 *
	 * @param mixed  $result Default result.
	 * @param string $action plugins_api action.
	 * @param object $args   Request args.
	 * @return mixed
	 */
	public static function plugin_info( $result, $action, $args ) {
		if ( $action !== 'plugin_information' || ! isset( $args->slug ) || $args->slug !== 'riviso-content-operations' ) {
			return $result;
		}
		$release = self::remote_release();
		if ( ! $release ) {
			return $result;
		}
		return (object) array(
			'name'          => 'RivisoSEO',
			'slug'          => 'riviso-content-operations',
			'version'       => $release['version'],
			'author'        => 'Riviso',
			'homepage'      => 'https://riviso.com',
			'requires'      => isset( $release['requires'] ) ? (string) $release['requires'] : '',
			'tested'        => isset( $release['tested'] ) ? (string) $release['tested'] : '',
			'requires_php'  => isset( $release['requires_php'] ) ? (string) $release['requires_php'] : '',
			'download_link' => $release['package'],
			'sections'      => array(
				'changelog' => esc_html( isset( $release['changelog'] ) ? (string) $release['changelog'] : '' ),
			),
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
						return current_user_can( 'edit_posts' );
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

			register_rest_route(
				$namespace,
				'/indexnow-key',
				array(
					'methods'             => 'POST',
					'permission_callback' => function () {
						return current_user_can( 'edit_others_posts' );
					},
					'callback'            => array( __CLASS__, 'handle_indexnow_key' ),
				)
			);

			register_rest_route(
				$namespace,
				'/update-token',
				array(
					'methods'             => 'POST',
					'permission_callback' => function () {
						return current_user_can( 'edit_others_posts' );
					},
					'callback'            => array( __CLASS__, 'handle_update_token' ),
				)
			);
		}
	}
}

RivisoContentOperationsConnector::init();

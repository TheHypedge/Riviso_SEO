from app.services.wordpress_client import RIVISO_WP_USER_AGENT, WordpressClient


def test_wordpress_client_sends_riviso_user_agent() -> None:
    wp = WordpressClient(site_url="https://example.com", username="editor", app_password="abcd efgh")
    headers = wp.auth_headers()
    assert headers.get("user-agent") == RIVISO_WP_USER_AGENT
    assert headers.get("authorization", "").startswith("Basic ")

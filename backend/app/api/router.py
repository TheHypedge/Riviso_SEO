"""
Aggregates all HTTP routers under the ``/api`` prefix (see ``app.main.create_app``).

Route modules are mounted without per-router prefixes here; each route file defines its own path segments.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import auth
from app.api.routes import articles
from app.api.routes import admin
from app.api.routes import context_links
from app.api.routes import health
from app.api.routes import image_prompts
from app.api.routes import profile
from app.api.routes import content_briefs
from app.api.routes import prompts
from app.api.routes import projects
from app.api.routes import wordpress
from app.api.routes import scheduled_jobs
from app.api.routes import gsc
from app.api.routes import shopify
from app.api.routes import project_gsc
from app.api.routes import project_shopify
from app.api.routes import project_cluster_validation
from app.api.routes import project_site_map
from app.api.routes import project_topic_cluster
from app.api.routes import research
from app.api.routes import user_subscription
from app.api.routes import workspace
from app.api.routes import project_collaboration
from app.api.routes import invitations
from app.api.routes import notifications

api_router = APIRouter()

api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(profile.router)
api_router.include_router(projects.router)
api_router.include_router(articles.router)
api_router.include_router(prompts.router)
api_router.include_router(content_briefs.router)
api_router.include_router(image_prompts.router)
api_router.include_router(context_links.router)
api_router.include_router(admin.router)
api_router.include_router(wordpress.router)
api_router.include_router(scheduled_jobs.router)
api_router.include_router(gsc.router)
api_router.include_router(shopify.router)
api_router.include_router(project_gsc.router)
api_router.include_router(project_shopify.connect_router)
api_router.include_router(project_shopify.router)
api_router.include_router(project_site_map.router)
api_router.include_router(project_topic_cluster.router)
api_router.include_router(project_cluster_validation.router)
api_router.include_router(research.router)
api_router.include_router(user_subscription.router)
api_router.include_router(workspace.router)
api_router.include_router(project_collaboration.router)
api_router.include_router(invitations.router)
api_router.include_router(notifications.router)


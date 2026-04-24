from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import auth
from app.api.routes import articles
from app.api.routes import admin
from app.api.routes import context_links
from app.api.routes import health
from app.api.routes import image_prompts
from app.api.routes import profile
from app.api.routes import prompts
from app.api.routes import projects
from app.api.routes import wordpress
from app.api.routes import scheduled_jobs

api_router = APIRouter()

api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(profile.router)
api_router.include_router(projects.router)
api_router.include_router(articles.router)
api_router.include_router(prompts.router)
api_router.include_router(image_prompts.router)
api_router.include_router(context_links.router)
api_router.include_router(admin.router)
api_router.include_router(wordpress.router)
api_router.include_router(scheduled_jobs.router)


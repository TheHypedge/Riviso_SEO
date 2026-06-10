#!/bin/bash
cd /var/www/riviso
git pull origin main
docker compose down
docker compose up -d --build

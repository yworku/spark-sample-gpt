FROM node:24-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    STUDIO_FRONTEND_DIST=/app/frontend/dist STUDIO_MEDIA_ROOT=/data/media
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 studio && useradd --uid 10001 --gid studio --create-home studio
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY backend/ backend/
RUN pip install --no-cache-dir uv==0.12.15 && uv sync --frozen --no-dev \
    && mkdir -p /data/media && chown -R studio:studio /data /app
COPY --from=frontend --chown=studio:studio /app/frontend/dist frontend/dist
COPY --chown=studio:studio scripts/ scripts/
ENV PATH="/app/.venv/bin:$PATH"
USER studio
EXPOSE 8000
CMD ["uvicorn", "studio.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]

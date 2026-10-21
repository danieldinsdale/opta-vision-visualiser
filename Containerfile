# Podman / Docker build:  podman build -t opta-vision-visualiser -f Containerfile .
# Run:                    podman run --rm -p 127.0.0.1:8501:8501 opta-vision-visualiser
FROM docker.io/library/python:3.12-slim

# uv, copied from the pinned official image
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=0 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# Unprivileged user; the app never needs write access outside /tmp.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser
WORKDIR /app

# Dependencies first (cached layer). --frozen refuses to run if uv.lock is out of date.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=appuser:appuser app.py ./
COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser config ./config
COPY --chown=appuser:appuser assets ./assets
COPY --chown=appuser:appuser .streamlit/config.toml ./.streamlit/config.toml

# Writable cache location for downloaded SDAPI files; mount a volume here to persist it.
RUN mkdir -p /app/data && chown appuser:appuser /app/data && chmod 700 /app/data

USER appuser
EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8501/_stcore/health', timeout=3)"

# Bind to all interfaces inside the container; publish the port to localhost only
# unless you place the app behind an authenticating reverse proxy.
CMD ["streamlit", "run", "app.py", "--server.address=0.0.0.0", "--server.port=8501", "--server.headless=true"]

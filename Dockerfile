# Dockerfile for ai-marketplace-monitor
#
# Provides a Linux runtime that bundles:
#   - Python + aimm
#   - Playwright with Chromium
#   - Xvfb virtual display (so non-headless Chromium can run)
#   - x11vnc + websockify + noVNC for browser-based interaction (CAPTCHA / login)
#   - supervisord to manage all processes
#
# Build:
#   docker build --build-arg AIMM_BUILD_SHA="$(git rev-parse HEAD)" -t aimm .
#
# Run (mount your host config + cache directory into the container):
#   docker run --rm -it \
#     -p 8467:8467 \
#     -v "$HOME/.ai-marketplace-monitor:/root/.ai-marketplace-monitor" \
#     -e FACEBOOK_USERNAME -e FACEBOOK_PASSWORD \
#     -e ANTHROPIC_API_KEY \
#     aimm
#
#   Web UI: http://localhost:8467
#   Click the "Browser" button in the header for the live Chromium view.

FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DISPLAY=:99 \
    SCREEN_GEOMETRY=1280x800x24 \
    VNC_PORT=5900 \
    AIMM_WEBUI_HOST=0.0.0.0 \
    AIMM_WEBUI_PORT=8467 \
    AIMM_ENABLE_VNC=1 \
    AIMM_NOVNC_DIR=/usr/share/novnc \
    AIMM_VNC_HOST=127.0.0.1 \
    AIMM_VNC_PORT=5900

# System packages:
#   - Xvfb + x11vnc + xauth: virtual display + VNC
#   - websockify + novnc: browser-based VNC client
#   - supervisor: process manager
#   - ca-certificates, curl, git: misc tooling
#   - fonts and libs needed by Chromium are installed by `playwright install --with-deps`
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        xauth \
        supervisor \
        websockify \
        novnc \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Symlink so noVNC's web UI is reachable at /usr/share/novnc/vnc.html
RUN if [ ! -e /usr/share/novnc/vnc.html ] && [ -e /usr/share/novnc/vnc_lite.html ]; then \
        ln -s /usr/share/novnc/vnc_lite.html /usr/share/novnc/vnc.html; \
    fi

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /uvx /bin/

ENV UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/usr/local

# Install locked dependencies and Chromium from the project metadata alone, so this
# layer stays cached when only application source changes. --inexact keeps the base
# image's own packages, such as pip, in the system environment.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project --inexact \
    && playwright install --with-deps chromium

COPY src ./src
RUN uv sync --locked --no-dev --no-editable --inexact

# Embed the immutable source revision; the installed package has no .git directory.
ARG AIMM_BUILD_SHA
ENV AIMM_BUILD_SHA=${AIMM_BUILD_SHA}

# supervisord configuration
RUN mkdir -p /etc/supervisor/conf.d /var/log/supervisor /root/.ai-marketplace-monitor
COPY docker/supervisord.conf /etc/supervisor/conf.d/aimm.conf

EXPOSE 8467

VOLUME ["/root/.ai-marketplace-monitor"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]

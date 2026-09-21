FROM python:3.12-slim-bookworm AS dependencies
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 HOME=/work TMPDIR=/tmp
RUN printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep sed tar gzip jq curl procps iproute2 openssh-client less man-db \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 \
    && pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
FROM dependencies
RUN sed -i '\|^path-exclude /usr/share/man/\*$|d' /etc/dpkg/dpkg.cfg.d/docker \
    && apt-get update && apt-get install -y --reinstall --no-install-recommends grep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runner
COPY runner/python/ ./
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python", "/opt/runner/entrypoint.py"]

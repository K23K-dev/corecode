FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 HOME=/work TMPDIR=/tmp
RUN printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources
# The Linux problems also use bash, coreutils, find, grep, sed and tar, which the base image has.
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 \
    && pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
WORKDIR /opt/runner
COPY judge/graders/python/ ./
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python", "/opt/runner/grade_submission.py"]

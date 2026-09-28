FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 HOME=/work TMPDIR=/tmp
RUN pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 \
    && pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
WORKDIR /opt/runner
COPY *.py ./
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python", "/opt/runner/grade_submission.py"]

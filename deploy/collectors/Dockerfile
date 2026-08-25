# Pulaski collectors — Cloud Run Job image.
#
# The collector scripts are NOT vendored. They are cloned from upstream at build
# time and run unmodified, so this image can never drift from the pipeline that
# produced the archive it is appending to. `brandongrant/pulaski_building_map` is
# read-only to us: we clone it, we never push to it.
#
# The store is a Cloud Storage bucket mounted with Cloud Storage FUSE at /store,
# which is what `--store` has always pointed at (a plain read-write directory) —
# so no script needs changing.

FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin with --build-arg UPSTREAM_REF=<sha> to freeze the pipeline for a run.
ARG UPSTREAM_REF=main
RUN git clone --depth 1 --branch "${UPSTREAM_REF}" \
      https://github.com/brandongrant/pulaski_building_map.git /app/upstream

WORKDIR /app/upstream

# Matches the dependency list installed by upstream's dispatch.yml workflow.
RUN pip install --no-cache-dir requests pdfplumber

COPY entrypoint.sh /usr/local/bin/collect
RUN chmod +x /usr/local/bin/collect

ENV STORE_DIR=/store \
    PYTHONUNBUFFERED=1

CMD ["/usr/local/bin/collect"]

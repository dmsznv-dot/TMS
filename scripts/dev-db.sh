#!/usr/bin/env bash
# Starts the local PostgreSQL service and creates the role and databases
# used for development, integration tests and end-to-end tests.
# Safe to run repeatedly.
set -euo pipefail

if ! pg_isready -q -h localhost -p 5432; then
  service postgresql start >/dev/null
  for _ in $(seq 1 30); do
    pg_isready -q -h localhost -p 5432 && break
    sleep 0.5
  done
fi

run_psql() {
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -tA $*"
  else
    psql -v ON_ERROR_STOP=1 -tA "$@"
  fi
}

run_psql -c "\"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tms') THEN CREATE ROLE tms LOGIN PASSWORD 'tms' CREATEDB; END IF; END \\\$\\\$;\""

for db in tms_dev tms_test tms_e2e; do
  exists=$(run_psql -c "\"SELECT 1 FROM pg_database WHERE datname = '$db'\"")
  if [ "$exists" != "1" ]; then
    run_psql -c "\"CREATE DATABASE $db OWNER tms\""
  fi
done

echo "PostgreSQL is ready: tms_dev, tms_test, tms_e2e"

#!/bin/sh
set -eu

app_password="$(cat /run/secrets/db_app_password)"
migrator_password="$(cat /run/secrets/db_migrator_password)"

if [ -z "$app_password" ] || [ -z "$migrator_password" ]; then
  echo "Database passwords must not be empty." >&2
  exit 1
fi

case "$app_password$migrator_password" in
  *[!A-Za-z0-9_-]*)
    echo "Database passwords must be non-empty base64url strings." >&2
    exit 1
    ;;
esac

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE homeorg_app LOGIN PASSWORD '$app_password';
CREATE ROLE homeorg_migrator LOGIN PASSWORD '$migrator_password';
GRANT CONNECT ON DATABASE homeorg TO homeorg_app, homeorg_migrator;
GRANT CREATE ON DATABASE homeorg TO homeorg_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO homeorg_migrator;
GRANT USAGE ON SCHEMA public TO homeorg_app;
CREATE SCHEMA drizzle AUTHORIZATION homeorg_migrator;
GRANT USAGE ON SCHEMA drizzle TO homeorg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO homeorg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO homeorg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO homeorg_app;
SQL

# Ubuntu deployment and recovery

This deployment uses Docker Compose for the API and PostgreSQL, with Nginx and
Certbot installed on the Ubuntu host. PostgreSQL has no published port, and
the API is published only on `127.0.0.1:3000`. Do not expose either container
port directly to the Internet.

## Host and secret setup

Use a supported Ubuntu LTS release. Point the deployment hostname's A/AAAA
records at the host. Install Docker Engine with the Compose plugin, Nginx,
Certbot, and the Certbot Nginx package. Permit SSH only from trusted addresses
when possible, then configure UFW to allow SSH, HTTP, and HTTPS and deny other
inbound traffic. Do not open PostgreSQL's port. Follow Docker's official
Ubuntu Engine installation instructions, then install the host packages:

```sh
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Create the protected secret directory and unique secrets as root:

```sh
sudo install -d -o root -g root -m 0700 /opt/homeorg/deploy/secrets
cd /opt/homeorg
sudo sh -c 'umask 077
openssl rand -hex 32 > deploy/secrets/db_owner_password
openssl rand -hex 32 > deploy/secrets/db_app_password
openssl rand -hex 32 > deploy/secrets/db_migrator_password
openssl rand -hex 32 > deploy/secrets/session_secret'
sudo chown root:1000 deploy/secrets/db_app_password deploy/secrets/db_migrator_password deploy/secrets/session_secret
sudo chmod 0440 deploy/secrets/db_app_password deploy/secrets/db_migrator_password deploy/secrets/session_secret
sudo chmod 0400 deploy/secrets/db_owner_password
sudo cp deploy/.env.example deploy/.env
sudo chmod 0600 deploy/.env
```

The database password files must contain non-empty hexadecimal values. The
session secret must contain at least 32 bytes. Keep the owner password for
manual database administration only; the API receives only its own DML role,
and the one-shot migrator receives schema-creation authority only in the
application database (not the PostgreSQL server-level CREATEDB or superuser
attributes). Compose mounts
these files as secrets without placing their contents in environment
variables, image layers, or command arguments. The app and migrator run as
UID/GID 1000; the `root:1000` group-readable `0440` files let those unprivileged
processes read only the mounted files. Keep the secret directory `root:root`
mode `0700`, so other host users cannot traverse it. Verify ownership and
permissions after copying secrets. Back up secret files separately from the
database dump. Never commit `deploy/.env` or `deploy/secrets/`.

## First deployment

Check out the release commit in `/opt/homeorg`, set `IMAGE_TAG` in
`deploy/.env` to that commit identifier, and set `homeorg.example` and the
certificate paths in `deploy/nginx/homeorg.conf` and
`deploy/nginx/bootstrap-http.conf` to the real DNS name.

Install the HTTP bootstrap site and prepare the ACME webroot:

```sh
sudo install -d -o www-data -g www-data -m 0755 /var/www/certbot/.well-known/acme-challenge
sudo cp deploy/nginx/bootstrap-http.conf /etc/nginx/sites-available/homeorg
sudo ln -s /etc/nginx/sites-available/homeorg /etc/nginx/sites-enabled/homeorg
sudo nginx -t
sudo systemctl reload nginx
```

Obtain the first certificate with Certbot's webroot method:

```sh
sudo certbot certonly --webroot -w /var/www/certbot -d homeorg.example
```

After certificate issuance, install `homeorg.conf` over the site and run
`nginx -t` before reloading:

```sh
sudo cp deploy/nginx/homeorg.conf /etc/nginx/sites-available/homeorg
sudo nginx -t
sudo systemctl reload nginx
```

The HTTPS site serves only `/api/v1/`, `/openapi.json`, `/docs/`, `/healthz`,
and `/readyz`; all other paths return 404. It sets the forwarded scheme and
client address, limits request bodies to 1 MiB, applies 30-second upstream
timeouts, and adds a per-IP request limit to `POST /api/v1/session`. The API
also applies independent account/IP login throttles. The Fastify process
trusts only the host proxy hop.

The first Household Administrator is provisioned only once, using the
dedicated bootstrap override. Create the two extra secret files before this
step, then run:

```sh
sudo sh -c 'umask 077
printf "%s" "admin@example.com" > deploy/secrets/bootstrap_admin_email
openssl rand -hex 24 > deploy/secrets/bootstrap_admin_password'
sudo chown root:1000 deploy/secrets/bootstrap_admin_*
sudo chmod 0440 deploy/secrets/bootstrap_admin_*
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml \
  -f deploy/compose.bootstrap.yaml up -d --build
```

After confirming that account can sign in, remove the bootstrap override from
future Compose commands and delete both bootstrap files. The account is stored
in PostgreSQL and is not re-created when the container restarts.

For routine, explicit release steps:

```sh
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml build api db
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml up -d db
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm migrate
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-deps api
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl --fail https://homeorg.example/healthz
curl --fail https://homeorg.example/readyz
```

The database must pass its health check before the one-shot migration task
runs. API readiness checks the PostgreSQL migration ledger; an unmigrated
database does not report ready. `docker compose up -d` without `--no-deps`
also enforces the `service_completed_successfully` migration dependency.
Repeat the one-shot migration step for each release before replacing the API.
The Compose services use digest-pinned base images, a persistent named volume,
an unprivileged read-only API container, and bounded local logs (10 MiB per
file, five files).

Certbot renewals use the webroot challenge location already served on port 80.
Enable and test renewal with `sudo certbot renew --dry-run`; ensure the
installed Certbot renewal timer remains enabled. Install a deploy hook so
Nginx reloads the renewed certificate:

```sh
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo sh -c 'printf "%s\n" "#!/bin/sh" "nginx -t && systemctl reload nginx" \
  > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx'
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo certbot renew --dry-run
```

The HTTPS server enables TLS 1.2/1.3 and HSTS. UFW should expose only SSH, 80,
and 443; verify the firewall after host changes.

## Rollback

Keep the previous release checkout and its image tag until the release is
accepted. To roll back code, set `IMAGE_TAG` to the previous commit's tag,
check out that release source, rebuild its image if necessary, then run the
one-shot migration task and replace the API using the same release sequence.
This is safe only when the old application can use the current schema. There
are no automatic down migrations. If a schema change is incompatible, stop
the deployment and restore the pre-release dump instead; writes since that
dump will be lost.

## Manual dump and full restore

Create a timestamped custom-format dump outside the deployment volume and
protect it as sensitive data:

```sh
sudo sh -c 'umask 077; docker compose --env-file deploy/.env -f deploy/compose.yaml \
  exec -T db pg_dump -U homeorg_owner -Fc homeorg > /secure-backups/homeorg-YYYYMMDD.dump'
```

To restore, schedule downtime and stop PostgreSQL and the API. Preserve the
current volume unchanged, then set `POSTGRES_VOLUME_NAME=homeorg_postgres_restore`
in `deploy/.env`. Start only `db` to initialize the empty volume and create
the separate database roles. Recreate the empty database with the migrator as
its owner so restored schema objects remain owned by the role that applies
future migrations:

```sh
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml stop api migrate db
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml up -d db
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T db \
  dropdb -U homeorg_owner homeorg
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T db \
  createdb -U homeorg_owner -O homeorg_migrator homeorg
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T db \
  psql -U homeorg_owner -d homeorg -c 'GRANT CONNECT ON DATABASE homeorg TO homeorg_app'
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T db \
  psql -v ON_ERROR_STOP=1 -U homeorg_owner -d homeorg \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO homeorg_app' \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO homeorg_app' \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE homeorg_migrator IN SCHEMA drizzle GRANT SELECT ON TABLES TO homeorg_app'
sudo sh -c 'docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T db \
  sh -c "pg_restore \
    --no-owner --role=homeorg_migrator -U homeorg_owner -d homeorg" \
  < /secure-backups/homeorg-YYYYMMDD.dump'
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm migrate
sudo sh -c 'umask 077; openssl rand -hex 32 > deploy/secrets/session_secret'
sudo chown root:1000 deploy/secrets/session_secret
sudo chmod 0440 deploy/secrets/session_secret
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml up -d api
```

Do not restore over a live or partially populated database. A full-database
replacement intentionally discards writes made after the dump. Verify
representative Household data and authentication before reopening traffic. To
roll back a failed restore, stop services and change `POSTGRES_VOLUME_NAME`
back to the original value; that preserved volume was not modified.

The restore commands rotate the session secret before starting the API; all
sessions signed with the former secret then fail authentication. Keep the
database role secrets consistent with the roles stored in the restored
database.

## Secret rotation

For a routine session-secret rotation, replace `deploy/secrets/session_secret`
with a new random value, restore `root:1000` ownership and `0440` mode, and
recreate the API container. This invalidates all existing sessions. Coordinate
the change across every API replica if scaling is introduced.

To rotate a database role password, stop the API (or migrator for its role),
change that role's password using an interactive owner `psql` session, update
the app/migrator secret file with `root:1000` ownership and `0440` mode, then
start the affected service and verify readiness. The owner password file
remains `root:root` mode `0400`; rotate the PostgreSQL owner credential through
the same DBA procedure, replace its file with the same new value, and reapply
that ownership/mode. Verify the new credential before closing the
administration session. The database init script is only run for a new data
volume and does not rotate existing role credentials.

Review `docker compose logs` and Nginx logs after releases and recovery. Logs
must not contain request bodies, cookies, CSRF tokens, authorization headers,
passwords, or secret values. Keep dumps and secret backups access-restricted
and test the restore procedure periodically.

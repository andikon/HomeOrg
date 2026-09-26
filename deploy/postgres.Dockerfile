FROM postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297

COPY deploy/postgres/10-create-roles.sh /docker-entrypoint-initdb.d/10-create-roles.sh
RUN sed -i 's/\r$//' /docker-entrypoint-initdb.d/10-create-roles.sh \
  && chmod 0644 /docker-entrypoint-initdb.d/10-create-roles.sh
